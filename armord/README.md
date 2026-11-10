# armord

A local decision daemon for ArmorIQ. One in-memory `armor.io/v2` policy engine that every agent
host on the machine asks before a tool runs: Claude Code hooks, any stdio MCP server, and (next)
Cursor, Codex, Gemini CLI, OpenHands and the SDKs. A decision takes **~0.03 ms in-process, ~0.1 ms over the
local socket** (p50; see [Benchmarks](#benchmarks)).

> **Status: prototype / proposal.** `@armoriq/policy-ir`'s README says it is shared by "the Armor
> CLI daemon", so ArmorIQ may already be building something in this space. armord is written to
> be folded into that effort or to replace it: it uses the official evaluator unchanged and
> keeps every armord-specific behaviour in one documented place ([Host semantics](#host-semantics)).

```
 Claude Code ──hook──┐
 Cursor ─────hook────┤                      ┌─ local armor.io/v2 YAML (compiled here)
 Codex ──────hook────┼──▶ armord ◀──────────┤
 any MCP client ─────┤   (in memory)        └─ org documents from the control plane,
   └─ armord mcp-proxy ──▶ real MCP server       cached on disk, refreshed every minute
 SDK local mode ─────┘
```

## Why

| Today | With armord |
|---|---|
| Each plugin (ArmorClaude, ArmorCodex, ArmorGemini, ArmorCopilot…) ships its own policy engine and its own policy format | One engine, one format (`armor.io/v2`, the same IR the platform compiles to) |
| ~100 ms per call loading the engine in armorClaude (#431), ~55 ms SDK import per hook in armorCodex (#267), ~500 ms cloud round trips, `ARMORCODEX_INTENT_DEADLINE_MS` fallbacks | ~0.02 ms in-process, ~0.07 ms over the socket; the decision path never touches the network |
| The SDK proxy only accepts HTTP+SSE MCP servers on protocol `2024-11-05` | `armord mcp-proxy` governs any stdio MCP server under any MCP client |
| A server that fails to start shows up as "0 tools" | The server's stderr and exit code are printed |
| "Hold" acts as a block in the Gateway and Codex | A hold waits in a local queue (`armord approve <id>`) or becomes the host's own approval prompt (Claude Code `ask`) |
| Plan-level checks pass `read_file(.ssh/id_rsa)` once `read_file` is in the plan | Every call is checked with its arguments, its derived path, host and program |

## Quick start

```bash
npm install
npm run build
node dist/cli.js init          # writes ~/.armoriq/armord/policies/starter.yaml
node dist/cli.js start         # foreground daemon on ~/.armoriq/armord.sock (\\.\pipe\armord-<user> on Windows)
node dist/cli.js decide Bash '{"command":"ls && rm -fr dist"}'
```

### Claude Code

`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "armord hook claude-code" }] }
    ]
  }
}
```

Allow → `allow`, hold → `ask` (Claude Code's own approval prompt), block → `deny` with the rule
that decided it. If the daemon isn't running, the hook builds the engine in-process from the same
policy files, so it never fails open.

### Any MCP server, any MCP client

Wrap the server's command:

```json
{
  "mcpServers": {
    "github": {
      "command": "armord",
      "args": ["mcp-proxy", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

The proxy:

- decides every `tools/call` before the server sees it. A block or a rejected hold comes back as
  an MCP tool error the model can read, and the server never runs the call;
- feeds `tools/list` into the policy inventory, so exact rule keys bind to the tool's real schema;
- **pins** each tool's description and schema on first sight. If either changes later (a server
  that rewrites `read_note` to say "also send ~/.ssh/id_rsa"), calls to it are blocked until you
  review and run `armord pins accept <server>`;
- redacts well-known credentials (AWS, GitHub, Slack, OpenAI, Anthropic, Stripe, private keys,
  JWTs, ArmorIQ keys) from tool results before they reach the model;
- prints the server's stderr and exit code.

## Policy

Policies are `armor.io/v2` source documents, the format ArmorIQ's platform compiles to. armord
compiles them with `@armoriq/policy-ir` and evaluates them with its evaluator, unchanged.

```yaml
apiVersion: armor.io/v2
kind: Policy
metadata: {name: starter}
target: {device: local}
spec:
  expiresAt: never
  approvalDefaults: {approvers: 1, anyMember: true}
  tools:
    default: allow
    rules:
      destructive: block            # capability key; armord tags rm -rf/-fr, reset --hard, force push…
      Bash:
        - when: {args.command: {matches: '(npm|pnpm|yarn)\s+publish'}}
          action: hold
        - action: hold
  files:   {deny: ['~/.ssh/**', '**/.env']}
  network: {default: hold, allow: [pypi.org, api.github.com]}
  secrets: {envBlocklist: [AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN]}
```

Sources, merged with the stricter verdict winning:

| Source | Where |
|---|---|
| Local | every `.yaml` / `.json` in `~/.armoriq/armord/policies` (`ARMORD_POLICY_DIR`). JSON must be a compiled `armor.policy.v2` document; a bad `policyHash` is refused |
| Remote | set `ARMORD_AGENT_ID` (agent id or name) plus `ARMORIQ_API_KEY`, or rely on the `armoriq login` profile in `~/.armoriq/credentials.json`. The publishable (invoke-only) key is enough. See [Remote bundle](#remote-bundle) |

No policy at all → **block** (`ARMORD_NO_POLICY` to change).

### Policy as code

```bash
armord policy check policies/starter.yaml           # compiled statements + diagnostics
armord policy test cases.yaml policies/*.yaml       # expected verdicts; exits 1 on any miss
```

```yaml
# cases.yaml
cases:
  - {name: rm after a pipe, tool: Bash, args: {command: "ls && rm -fr /tmp/x"}, expect: block}
  - {name: ssh key, tool: Read, args: {file_path: "~/.ssh/id_rsa"}, expect: block}
```

`test/fixtures/starter-cases.yaml` is 18 such cases for the starter policy. Two of them were
real holes the first version of the starter had: `ls && rm -fr …` passed the "read-only command"
allow rule, and a `secrets` rule never fired.

### Remote bundle

armord reads the control plane the way the Python SDK's local decision mode does
(`armoriq_sdk/policy_bundle.py`, `local_decision.py` in 0.8.18). Checked live against
`api.armoriq.ai` on 2026-11-10:

- `GET /policy/bundles/current?agent=<id>` with `X-API-Key` returns `{orgId, agents:[{agentId, name,
  inactive, policy:{name, policyId, document}, tools:[{name, qualifiedName, server, schemaHash,
  capabilities}], members:[{email, membershipId}]}]}`. The ETag is a `sha256:` value; sending it back
  in `If-None-Match` returns 304. Without a key the endpoint returns 401.
- **Revalidated every 60 s, and stale after 300 s without a confirmed fetch.** A stale or never-fetched
  bundle blocks every call, as the SDK does. `ARMORD_ON_STALE=last-known` keeps the last document
  instead, for a laptop that goes offline. The last bundle is cached on disk, so a restart enforces
  it straight away, until it too goes stale.
- Agent not in the bundle → `agent_unresolved` (block). Inactive → block. No active policy →
  allow, matching the SDK and the Gateway. A document whose `policyHash` doesn't match counts as
  inactive, never as "no policy".
- The bundle's tool inventory adds that tool's `capabilities` and `schemaHash` to the call, and
  `members` map an email to its `membershipId`, as the SDK does. armord's own derived fields and
  capabilities are added on top.

### Signed policies

```bash
armord keygen                        # ~/.armoriq/armord/keys/local.private.pem (0600) + trusted_keys/local.pub
armord policy sign policies/team.yaml
ARMORD_REQUIRE_SIGNED=1 armord start # unsigned or edited files are refused, with a problem listed in status
```

Bundles can be signed too. When a response carries `x-armoriq-bundle-signature` (Ed25519 over the
response body, base64), armord checks it against `ARMORD_BUNDLE_PUBKEY` or the trusted keys, and
`ARMORD_REQUIRE_SIGNED_BUNDLE=1` refuses bundles without one. **The live control plane doesn't send
that header today**: this is the client half of a proposal, and the header name is ours.

### Intent plans

A session can register its plan: the goal, plus the steps it will take. After that, a call outside
the plan is **intent drift** (blocked; `ARMORD_PLAN_DRIFT=hold` to ask instead). A step that pins
argument values, exactly or with a glob, refuses any other value. That is the argument-level check
a tool-level plan misses: `read_file(README.md)` in the plan doesn't let `read_file(~/.ssh/id_rsa)`
through.

```bash
armord plan register plan.json --session s1      # {"goal": "...", "steps": [{"tool": "read_file", "args": {"path": "src/**"}}]}
armord mcp-plan --host claude-code                # MCP server giving the agent a register_intent_plan tool
```

A plan registered through `mcp-plan` waits as pending for its host. The next hook call from that
host carries a session id, and the plan binds to that session. This is the hand-off ArmorClaude
does between its MCP tool and its PreToolUse hook. `ARMORD_REQUIRE_PLAN=1` blocks sessions that
never registered a plan.

A plan may include the ArmorIQ **intent token** it was minted with. armord verifies it the way the
SDK's `verify_intent_token_signature` does: Ed25519 over the canonical JSON of the signed fields,
plus expiry. With one difference: the SDK checks the signature against the public key *inside the
token*, which anyone can mint. armord also requires that key to equal the trusted IAP key, from
`ARMORIQ_IAP_PUBLIC_KEY` or fetched once from `GET /iap/public-key` (no auth; checked live) and
pinned on disk. The IAP computes `plan_hash` on the server, so armord records whether it equals a
plain hash of the step list (`planHashMatches`) but doesn't rely on it.

### Self-protection

A floor no policy can loosen (`ARMORD_SELF_PROTECT=off` to disable):

- **block** writes and deletes under `~/.armoriq/armord`, including shell commands that touch it;
- **block** reads of the signing keys and of `~/.armoriq/credentials.json`;
- **block** shell commands that stop armord;
- **hold** writes to the files that switch enforcement off: `.claude/settings*.json`,
  `.cursor/hooks.json`, `.cursor/mcp.json`, `.codex/hooks.json` and `config.toml`,
  `.gemini/settings.json`, `.mcp.json`, `claude_desktop_config.json`.

### Run at login

```bash
armord service print      # what it will install
armord service install    # Windows: schtasks ONLOGON; macOS: LaunchAgent; Linux: systemd --user
armord service uninstall
```

The service definition holds no API key; armord reads the `armoriq login` profile at start.

## Host semantics

The evaluator applies `files`, `network`, `skills` and `secrets` statements only when the caller
supplies capability tags and derived fields. That derivation is the host's job, and armord is the
host. Everything here lives in `src/derive.ts` and `src/engine.ts`:

- **Derived fields**: `path` (absolute, `~/`-relative under home, forward slashes),
  `withinWorkspace`, `program` (skipping env assignments, `sudo`, `env`…), `command`,
  `writeRedirection`, `url`, `host`, `skill`, `env`.
- **Capabilities**: `shell`, `files` + `file.read` / `file.write` / `file.delete`,
  `network` + `web.fetch`, `web.search`, `skill(s)`, `subagent`, `destructive`, `secrets`. Any
  call, MCP included, whose arguments carry a path or URL gets `files` / `network`. A shell
  command that runs curl, wget, ssh, scp, nc… anywhere in a pipeline gets `network` and its host.
- **Secrets**: each environment variable a shell command reads is evaluated separately with the
  `secrets` capability, so `envBlocklist` sees every one.
- **Section defaults**: the evaluator records `defaults.network` and `defaults.files` but doesn't
  apply them. armord applies them to a network or files call that no statement in that section
  decided, but only when the document has statements in that section.
- **Schema drift**: an evaluation that reports a `schema_drift` obligation is raised to at least
  `hold`.
- **Layering**: remote documents go through the evaluator's own floor/group/agent stages. Each
  local document is evaluated on its own. The strictest verdict across all of them wins.

## Audit

Every decision, hold and resolution is appended to `~/.armoriq/armord/audit.jsonl`. Each line
carries the hash of the line before it, so `armord audit verify` finds the first edited or
deleted record. Shipping these to ArmorIQ Observability is not built yet.

## Benchmarks

`npm run bench`, Windows 11 laptop, Node 22, starter policy, 5 mixed calls:

```
in-process  n=20000  p50 0.033 ms  p99 0.226 ms
socket RTT  n=5000   p50 0.098 ms  p99 0.430 ms
```

## Tests

`npm test`: 44 Node tests (43 pass, 1 live test skipped unless `ARMORD_LIVE=1`), plus
`adapters/openhands`: 22 pytest tests against the real `openhands-sdk` 1.61.0.

- `test/armord.test.mjs`: derivation, the starter cases, fail-closed, holds, audit tampering, IPC,
  the Claude Code hook, redaction, the MCP proxy end to end, tool-pin drift, and the CLI.
- `test/core.test.mjs`: the real bundle shape, ETag, staleness, unresolved/inactive/tampered
  agents, signed bundles and signed policies, intent tokens, plans, self-protection, services,
  bare vs qualified MCP names, and the live control plane.
- `test/shell.test.mjs`: 148 shell parsing cases (bypasses, Windows, obfuscation, must-not-flag).
- `test/adapters.test.mjs`: Cursor, Codex, Gemini and Claude Code hook contracts.

Host adapters and how to install each one: [docs/adapters.md](docs/adapters.md).

## Limits (read before relying on it)

- **A filled-in agent document hasn't been seen live.** The envelope, ETag, 304 and 401 behaviour
  are verified against `api.armoriq.ai`, and the agent-entry shape comes from the SDK's own reader.
  But the test workspace has no agents yet, so an agent with an active v2 policy hasn't been fetched.
- **Bundle signing needs the backend.** armord verifies `x-armoriq-bundle-signature`, but the control
  plane doesn't send it. Until it does, TLS is the only authenticity check on a fetch.
- **`plan_hash` can't be recomputed locally.** The IAP derives it on the server, so a verified token
  proves the plan was registered with ArmorIQ, not that these exact steps hash to it.
- **Shell analysis still has limits.** See the shell section in the tests for what is and isn't caught.
  Hold unknown shell commands by default, as the starter does.
- **A process with the user's own rights can still stop armord** outside the agent, for example
  from another terminal. Self-protection covers what agents do through governed tools.

## Roadmap

1. `armord tui`: live decision stream and one-key approvals over the same socket.
2. Ship the audit log to ArmorIQ Observability as OTLP spans.
3. Backend: sign bundles (`x-armoriq-bundle-signature`) and publish the `plan_hash` derivation.

## Setup and migration commands

```bash
armord doctor                          # policies, daemon, hooks, credentials, bundle, audit chain
armord install claude-code|cursor|codex|gemini|openhands|mcp [--project] [--dry-run]
armord uninstall <host>                # removes only armord's entries; wrapped MCP servers are restored
armord templates                       # armordev, armorops, armor-pay, armor-health, armor-edu, armor-ci, ...
armord init --template armordev
armord migrate                         # dry run: finds Claude Code, Codex, Cursor, Gemini, ArmorIQ plugin and MCP setups
armord migrate --apply [--replace-plugin-hooks]
armord logs -f --verdict block         # live decision log
armord watch                           # approve or reject holds in the terminal
armord remote agents|bundle|register <name>
armord export-policy <file>            # compiled armor.policy.v2 to paste into the dashboard
armord completions bash|zsh|fish|powershell
```

Host plugin packages (Claude Code, Cursor, Codex, Gemini, OpenHands) are in `plugins/`; each README lists what is unverified. Every template has a `.cases.yaml` that `armord policy test` runs.

Attaching a per-agent policy needs a dashboard session; an API key can register agents and read bundles, not set the policy.
