# ArmorIQ agent skills

Four skills that teach a coding agent to work with ArmorIQ without guessing.

| Skill | Use it when |
|---|---|
| `armoriq-integrate` | adding ArmorIQ to an existing agent (SDK, Intent Gateway, plugins, armord) and verifying enforcement |
| `armoriq-write-policy` | writing, reviewing or testing an `armor.io/v2` policy |
| `armoriq-debug-block` | a call was blocked, held or wrongly allowed and you need the rule behind it |
| `armord-setup` | installing armord, wiring hosts, migrating existing rules |

Each is grounded in docs.armoriq.ai, the cookbook and the armord README. Pair them with the docs MCP server (`../docs-mcp`) so the agent can look up exact syntax.

## Install

```bash
node skills/install.mjs claude            # ~/.claude/skills/<skill>/SKILL.md
node skills/install.mjs claude --project  # ./.claude/skills
node skills/install.mjs cursor            # ./.cursor/rules/<skill>.mdc (agent-requested rules)
node skills/install.mjs codex             # ~/.codex/AGENTS.md, a managed block between markers
node skills/install.mjs codex --project   # ./AGENTS.md
```

Add `--dry-run` to preview and `--uninstall` to remove only what this script added.

Verified: the SKILL.md format (frontmatter `name` and `description`) is Claude Code's. **Unverified:** Cursor's `.mdc` rule frontmatter beyond `description` and `alwaysApply`, and Codex's handling of a long `AGENTS.md` block; Codex has no skills folder that I could confirm, so the managed block is the safe fallback. None of these was loaded into a live host.
