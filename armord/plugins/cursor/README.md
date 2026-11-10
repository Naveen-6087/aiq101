# armord for Cursor

- `hooks/hooks.json`: `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile` and a
  `preToolUse` for writes, deletes, grep and tasks, all `failClosed: true`, all running
  `armord hook cursor`. Event contract and limits: [docs/adapters.md](../../docs/adapters.md#cursor).
- `mcp.json`: the `armord-plan` MCP server (`register_intent_plan`).
- `rules/armord.mdc`: an always-on rule telling the model not to route around a denial.

## Install

```bash
armord install cursor            # ~/.cursor/hooks.json
armord install cursor --project  # <project>/.cursor/hooks.json
armord install mcp               # also route Cursor's MCP servers through armord mcp-proxy
```

Copy `rules/armord.mdc` to `<project>/.cursor/rules/` if you want the rule.

## Verification status

The hook file follows Cursor's documented hooks format (https://cursor.com/docs/agent/hooks) and
the installer is tested. Not verified: the `.cursor-plugin/plugin.json` manifest fields and
whether Cursor's plugin loader picks up `hooks/`, `mcp.json` and `rules/` from a plugin folder; use
the installer or copy the files by hand until that is checked. Nothing here has run in a live
Cursor. Cloud agents skip `beforeMCPExecution` and user-level hooks.
