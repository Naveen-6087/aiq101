# aiq101

Local policy enforcement and developer tooling for ArmorIQ.

- `armord/` is a local daemon and CLI that decides allow, hold or block for every tool call an AI agent makes, using ArmorIQ armor.io/v2 policies. It includes adapters for Claude Code, Cursor, Codex, Gemini CLI, OpenHands and MCP clients, eleven policy templates, migration from other agents and a terminal UI.
- `devpack/` is a docs MCP server, four agent skills and a project scaffolder.

## Quick start

```bash
cd armord
npm install
npm run build
npm link
armord setup claude-code
armord start
armord doctor
```

See `armord/README.md` for the full guide and `armord/docs/adapters.md` for each host.

## Tests

```bash
cd armord && npm test
cd devpack && npm test
```

## Notes

- Keep API keys in environment variables. Never commit keys.
- This project is independent of the official ArmorIQ plugins and does not send traces to the ArmorIQ dashboard.
