# Host adapters

Every adapter sends the host's pre-execution event to the same armord engine and translates the
verdict into the host's own answer. A verdict is `allow`, `hold` (a person must approve) or
`block`. If the daemon is running, the hook asks it over the local socket. If it isn't, the hook
builds the engine in-process from the same policy files. Malformed input and internal errors
always get the host's **deny** answer.

| Host | Command | allow | hold | block |
|---|---|---|---|---|
| Claude Code | `armord hook claude-code` | `permissionDecision: allow` | `ask` (Claude Code prompts) | `deny` |
| Cursor | `armord hook cursor` | `permission: allow` | `ask` on shell/MCP; `deny` elsewhere | `deny` |
| Codex CLI | `armord hook codex` | no output (Codex decides) | waits on armord's hold queue, else `deny` | `deny` |
| Gemini CLI | `armord hook gemini` | `decision: allow` | `decision: ask` (Gemini prompts) | `decision: deny`, exit 2 |
| OpenHands | `armord_openhands.ArmordSecurityAnalyzer` | `SecurityRisk.LOW` | `HIGH` (confirmation) | `HIGH` + rejection reason |
| anything else | `armord hook generic` | exit 0 | waits on the hold queue | exit 2 |

An unknown host name (`armord hook foo`) gets the generic block answer.

Hooks run the `armord` binary, so it must be on `PATH` for the host process. You can also give an
absolute path, such as `node /path/to/armord/dist/cli.js hook cursor`.

---

## Cursor

Contract: https://cursor.com/docs/agent/hooks

Use `~/.cursor/hooks.json` for the user, `<project>/.cursor/hooks.json` for a project, or the
enterprise path (`C:\ProgramData\Cursor\hooks.json`, `/etc/cursor/hooks.json`, or
`/Library/Application Support/Cursor/hooks.json`):

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [{ "command": "armord hook cursor", "failClosed": true }],
    "beforeMCPExecution":   [{ "command": "armord hook cursor", "failClosed": true }],
    "beforeReadFile":       [{ "command": "armord hook cursor", "failClosed": true }],
    "preToolUse":           [{ "command": "armord hook cursor", "failClosed": true, "matcher": "^(Write|Delete|Grep|Task)$" }]
  }
}
```

`failClosed: true` matters. Without it, Cursor runs the action when the hook crashes or times out.

**What armord reads from each event** (common fields: `conversation_id`, `workspace_roots`, `hook_event_name`, …):

| Event | Input → armord request | Answer |
|---|---|---|
| `beforeShellExecution` | `command`, `cwd` → tool `run_terminal_cmd` `{command}` | `{permission, user_message, agent_message}` |
| `beforeMCPExecution` | `tool_name`, `tool_input` (a JSON *string*), `mcp_server_name` → tool `<tool_name>` on server `<mcp_server_name>` | `{permission, user_message, agent_message}` |
| `beforeReadFile` | `file_path`, plus each `attachments[]` entry of type `file` → tool `read_file` `{file_path}`, strictest wins | `{permission, user_message}` (`allow`/`deny` only) |
| `beforeTabFileRead` | `file_path` → `read_file` | `{permission}` (`allow`/`deny` only) |
| `preToolUse` | `tool_name` `Shell`/`Read`/`Write`/`Grep`/`Delete`/`Task`/`MCP:<name>`, `tool_input` → `run_terminal_cmd`/`read_file`/`edit_file`/`grep`/`delete_file`/`task`/`<name>` | `{permission, user_message, agent_message}` (`allow`/`deny`) |
| `beforeSubmitPrompt` | — | `{continue: true}` (armord has no prompt policy) |
| other events | — | no output |

**Verdicts:**
- **allow** → `permission: "allow"`.
- **block** → `permission: "deny"`. The `user_message` shows the reason; the `agent_message` tells the model not to retry.
- **hold** → `permission: "ask"` on `beforeShellExecution` and `beforeMCPExecution`, which brings up Cursor's own approval prompt.
- **hold on other events** → `deny`, with a message saying approval is needed. These events don't honor `ask`; `preToolUse` accepts it but doesn't enforce it, so the call would run.
- **Malformed input** → exit code 2 (Cursor blocks) and `{permission: "deny", continue: false, user_message, agent_message}`.
- **Unparsable MCP `tool_input`** → that event's deny shape.

**Limits:**
- Cursor has no pre-execution event for its built-in file *writes* other than `preToolUse`. A
  hold there can't become a prompt, so a held write is denied. Use `preToolUse` for writes and
  deletes.
- Don't send `Shell` through `preToolUse` as well. If you do, the `preToolUse` deny runs before
  `beforeShellExecution` can ask.
- Response field names follow the current docs (snake_case). Cursor 1.7 used `userMessage` /
  `agentMessage`; with those older builds the verdict still applies, but the message may not show.
- Cloud agents don't run `beforeMCPExecution`, `beforeTabFileRead` or user-level hooks.
- Some Cursor builds reportedly ignore `ask` in "Auto-review" mode (a forum report, not docs).

---

## Codex CLI

Contract:
- openai/codex: `codex-rs/hooks/schema/generated/pre-tool-use.command.{input,output}.schema.json`, `codex-rs/hooks/src/events/pre_tool_use.rs`, `codex-rs/core/src/tools/hook_names.rs`
- https://developers.openai.com/codex/hooks

Use `~/.codex/hooks.json` for the user or `<repo>/.codex/hooks.json` for a repo:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "armord hook codex", "timeout": 120 }] }
    ]
  }
}
```

Current Codex runs hooks by default (the `hooks` feature is stable). Older builds needed
`[features] codex_hooks = true` in `config.toml`.

Codex skips a new or edited hook until you trust it. After any change, review and trust it in Codex.

**Input:**
- `tool_name`:
  - `Bash` for shell, with `tool_input` `{command}`.
  - `apply_patch`, with `tool_input` `{command: "<patch>"}`.
  - `mcp__<server>__<tool>` for MCP tools.
  - Other function tools by their own name.
- armord splits MCP names into tool and server, so a rule keyed by `delete_note` and one keyed by
  `mcp__notes__delete_note` both apply.
- For `apply_patch`, armord passes the patch as `input` too, so the file paths in its headers are checked.

**Verdicts:**

Codex supports one blocking answer: `permissionDecision: "deny"` with a non-empty reason. Codex
treats `allow` without `updatedInput` and `ask` as unsupported, and then *runs the tool*.

- **allow** → no output, exit 0. Codex's own approval policy still applies.
- **block** → `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"ArmorIQ: …"}}`.
- **hold** → Codex has no approval prompt a hook can trigger, so the hook waits instead:
  - With a running daemon (`armord start`), the call waits on armord's hold queue.
    - `armord holds` lists it.
    - `armord approve <id>` lets it run (no output).
    - `armord reject <id>`, or no answer within `ARMORD_CODEX_HOLD_TIMEOUT_MS` (default 60 s), denies it with the hold id in the reason.
  - Without a daemon, nobody could approve it, so it is denied at once.
  - Keep the hook `timeout` (seconds; Codex's default is 600) above the hold timeout.
  - This is better than treating hold as deny (as armorCodex does): a human can still say yes,
    and the default still stops the call.
- **Malformed input** (not JSON, not an object, no `tool_name`) → the deny shape above.

**Limits:**
- Codex fails open: if the hook crashes, times out or prints invalid JSON, the tool still runs.
  armord never crashes on bad input, but a missing `armord` binary would let calls through.
- Codex has no file-read tool; reads go through `Bash` (for example `cat`), and armord sees them
  as shell commands.
- Codex's hosted web search is not hooked.
- armorCodex's `CODEX_HARNESS_LIMITATIONS.md` (CLI 0.125.0) also lists `list_dir`, `view_image`
  and `tool_search` as unhooked; on current Codex `main` most function tools go through the hook.

---

## Gemini CLI

Contract: google-gemini/gemini-cli
- `docs/hooks/reference.md`
- `packages/core/src/hooks/{types,hookRunner,hookAggregator,hookPlanner}.ts`
- `packages/core/src/scheduler/hook-utils.ts`

Use `~/.gemini/settings.json` for the user or `<project>/.gemini/settings.json` for a project:

```json
{
  "hooks": {
    "BeforeTool": [
      { "matcher": "*", "hooks": [{ "name": "armord", "type": "command", "command": "armord hook gemini", "timeout": 10000 }] }
    ]
  }
}
```

Hooks are on by default (`hooksConfig.enabled`). `timeout` is in milliseconds.

**Input:** `tool_name`, `tool_input`, `cwd`, `session_id`, and `mcp_context` for MCP tools.

**How armord reads it:**
- **MCP tools** arrive as `mcp_<server>_<tool>`. armord uses `mcp_context.server_name` and `mcp_context.tool_name`.
- **`web_fetch`** has no `url` argument, because its URLs are inside `prompt`. armord decides every
  URL in the prompt, and the strictest verdict wins.
- **Other built-in tools** (`run_shell_command`, `read_file`, `write_file`, `replace`,
  `list_directory`, `glob`, `grep_search`, `google_web_search`) map directly.

**Verdicts:**
- **allow** → `{"decision":"allow","reason":"ArmorIQ: …"}`, exit 0. This does not skip Gemini's
  own confirmation policy.
- **hold** → `{"decision":"ask","reason":…,"systemMessage":"ArmorIQ: … Approve to run it."}`.
  Gemini then shows its own confirmation.
- **block** → `{"decision":"deny","reason":…,"systemMessage":…}`, exit 2. Gemini blocks on any exit code ≥ 2.
- **Malformed input** → the deny answer.

**Limits:**
- If the hook times out or fails to start, Gemini runs the tool.
- `read_many_files` passes glob patterns, not paths, so `files` rules don't see individual files.

---

## OpenHands

Contract: the OpenHands agent SDK (`openhands-sdk`, OpenHands/software-agent-sdk):
- `openhands/sdk/security/analyzer.py`: `SecurityAnalyzerBase.security_risk(action: ActionEvent) -> SecurityRisk`, `analyze_action(...) -> SecurityAnalysis`
- `risk.py`: `SecurityRisk` LOW / MEDIUM / HIGH / UNKNOWN
- `confirmation_policy.py`: `ConfirmRisky`

The V0 app's `openhands.security.SecurityAnalyzer` was removed from OpenHands `main` in April 2026
(commit 701231c). The adapter still maps the V0 action classes, but subclasses only the SDK base.

Install:

```bash
pip install ./adapters/openhands            # protocol client + analyzer
pip install "./adapters/openhands[openhands]"   # with openhands-sdk (Python >= 3.12)
```

Wire it in:

```python
from openhands.sdk.conversation.state import ConversationExecutionStatus
from armord_openhands import ArmordSecurityAnalyzer, confirm_risky_policy, pending_actions, reject_blocked

analyzer = ArmordSecurityAnalyzer(cwd="/workspace")   # socket: $ARMORD_SOCKET or the per-user default
conversation.set_security_analyzer(analyzer)
conversation.set_confirmation_policy(confirm_risky_policy())   # ConfirmRisky(threshold=HIGH)

conversation.run()
while conversation.state.execution_status == ConversationExecutionStatus.WAITING_FOR_CONFIRMATION:
    if not reject_blocked(conversation, analyzer):         # armord blocked one: reject, don't ask
        if not ask_user(pending_actions(conversation)):    # a hold: your own confirmation UI
            conversation.reject_pending_actions("User rejected the action")
    conversation.run()
```

`pending_actions` is `ConversationState.get_unmatched_actions(state.active_branch())`, the same
lookup `reject_pending_actions` uses.

**How it reaches armord:** it talks to the running daemon over the local socket, using NDJSON
`{"id","method":"decide","params":{…}}`.
- **POSIX:** `~/.armoriq/armord.sock`.
- **Windows:** `\\.\pipe\armord-<user>`, opened as a file.
- `$ARMORD_SOCKET` overrides both.

**Action mapping:**

| OpenHands action | armord request |
|---|---|
| `TerminalAction(command)` (SDK) / `CmdRunAction` (V0) | `terminal` / `execute_bash` `{command}` (shell) |
| `FileEditorAction(command="view", path)` | `view` `{path}` (file read) |
| `FileEditorAction(create/str_replace/insert/undo_edit, path)` | `str_replace_editor` `{path, …}` (file write) |
| `FileReadAction` / `FileWriteAction` / `FileEditAction` (V0) | `read_file` / `write_file` / `edit_file` |
| `BrowserNavigateAction(url)` / `BrowseURLAction(url)` | `browse` `{url}` (network, host derived) |
| other `Browser*Action` (click, type, …) | `browser_click`, `browser_type`, … |
| `MCPToolAction(data)` / `MCPAction(name, arguments)` | the MCP tool name, `data` / `arguments` |

**Verdicts:**
- **allow** → `LOW`.
- **hold** → `HIGH`, so `ConfirmRisky` pauses for the user.
- **hold with `wait_on_hold=True`** → waits on armord's hold queue (`armord approve <id>`).
  Approved → `LOW`; rejected or timed out (`hold_timeout_ms`) → treated as block.
- **block** → `HIGH`, with `details["rejection_reason"]`. `rejection_for(pending)` returns that
  reason, so the loop rejects instead of asking.
- **armord unreachable, an error reply or a bad reply** → block (fail closed).

`analyze_action` attaches `details["armord"]` (`verdict`, `final`, `reason`, `statementId`,
`holdId`), and OpenHands records it in its `SecurityAnalysisEvent`.

**Limits:**
- An SDK analyzer can't reject on its own; the risk only drives the confirmation policy.
  - With the default `NeverConfirm` policy, armord's verdict is **not enforced**. Set `ConfirmRisky`
    (or `AlwaysConfirm`) and check `rejection_for` as shown above.
  - Rejecting is up to the caller.
- The SDK's `ActionEvent` does not name the MCP server, so MCP rules match on the bare tool name.
- The OpenHands app server/GUI configures analyzers by its own settings. This package plugs into
  the SDK conversation API.
- Tests:
  - `tests/test_openhands_sdk.py` runs against real openhands-sdk 1.61 classes (`ActionEvent`,
    `MCPToolAction`, `ConfirmRisky`).
  - The terminal, file-editor and browser actions live in `openhands-tools`, which isn't installed
    for the tests. They're covered by stand-ins with the same class names and fields.
  - `tests/test_real_armord.py` runs against a real `armord start`, including a hold released by
    `armord approve`.
