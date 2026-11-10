---
name: armord-setup
description: Install and configure armord, the local ArmorIQ decision daemon, for coding agents (Claude Code, Cursor, Codex, Gemini CLI, OpenHands) and MCP clients; migrate existing permission rules and MCP servers into one policy. Use when the user wants local, offline, sub-millisecond policy decisions for their coding agent or asks to set up or troubleshoot armord.
---

# Set up armord

armord is a local daemon (TypeScript, Node 20+) that answers allow, hold or block for every tool call from any host, from one armor.io/v2 policy, with a hash-chained audit log. It can also mirror an agent's policy from the ArmorIQ control plane. It is a prototype/proposal from armoriq-labs, so say so if the user asks about support. Full reference: the armord README.

## Install and start

```bash
# from the armord checkout (not published to npm yet):
npm install && npm run build && npm link
armord init --template armordev          # or: armord templates, then pick one
armord start                             # foreground; or: armord service install  (start at login)
armord doctor                            # checks policies, daemon, hooks, credentials, bundle, audit chain
```

Without a daemon, hooks fall back to deciding in-process, so nothing breaks if it is not running (slightly slower per call).

## Wire a host

```bash
armord install claude-code               # .claude/settings.json PreToolUse hook
armord install cursor                    # .cursor/hooks.json
armord install codex                     # Codex hooks
armord install gemini                    # Gemini CLI BeforeTool
armord install openhands                 # writes a Python helper; pip install the armord_openhands adapter
armord install mcp                       # wraps stdio MCP servers in mcp.json files with `armord mcp-proxy`
```

Add `--project` for the current repo only and `--dry-run` to preview. Existing config is merged, backed up once as `<file>.armord-bak`, and `armord uninstall <host>` removes only armord's entries (wrapped MCP servers are restored exactly). Always run `--dry-run` first and show the user which files will change.

Host semantics differ, and you should tell the user: Claude Code and Gemini have a native "ask"; Cursor asks only on shell and MCP events; Codex has no ask, so a hold waits for `armord approve <id>` and then denies on timeout; OpenHands enforces verdicts only when its confirmation mode is on.

## Migrate an existing setup

```bash
armord migrate                  # dry run: finds Claude Code, Codex, Cursor, Gemini, Claude Desktop, ArmorIQ plugin installs, MCP servers
armord migrate --show           # prints the generated policy
armord migrate --apply          # writes migrated-*.yaml, wires hooks, wraps MCP servers (backups kept)
```

Native permission rules become policy statements (allow, ask to hold, deny to block); things armord cannot express (Cursor's in-app allowlist, ArmorClaw rules with unsupported matchers) are listed as warnings, not silently dropped. ArmorIQ plugin hooks keep running unless `--replace-plugin-hooks` is passed. `--apply` edits real config files: confirm with the user first.

## Policy, approvals, logs

```bash
armord policy check <file>             # compile
armord policy test <cases> <policy>    # expected-verdict tests
armord watch                           # approve/reject held calls in this terminal
armord logs -f --verdict block         # live decisions
armord audit verify                    # hash chain intact?
```

Use the `armoriq-write-policy` skill to author rules and `armoriq-debug-block` when a verdict surprises the user.

## Remote policy (optional)

```bash
armord remote agents                   # needs ARMORIQ_API_KEY or `armoriq login`
ARMORD_AGENT_ID=<agent-id> armord start
```

armord then mirrors the agent's active policy and combines it with local files; the strictest verdict wins. It fails closed when the bundle is older than 5 minutes. A key is only ever read from the environment or `~/.armoriq/credentials.json`; never put one in a file you create. An API key can register agents and read bundles but cannot attach a per-agent policy; that needs a dashboard login.

## Do not

- Run `armord migrate --apply` or `install` without telling the user which files change.
- Let the agent edit armord's own files, keys, or hook configs: armord blocks that itself (self-protection) and holds changes to hook configs. Do not work around it.
- Claim a host is protected until `armord doctor` lists its hook and `armord decide Bash '{"command":"rm -rf /"}'` returns block.
