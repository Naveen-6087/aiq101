# armord for Claude Code

Plugin that gates every Claude Code tool call through armord.

- `hooks/hooks.json`: a `PreToolUse` hook (`matcher: "*"`) running `armord hook claude-code`.
  allow -> `permissionDecision: allow`, hold -> `ask`, block -> `deny`.
- `commands/`: `/armord-status`, `/armord-holds`, `/armord-approve <id>` (user-initiated only).
- `skills/armord/SKILL.md`: tells the model not to route around a block.

## Install

Without the plugin system, merge the hook into your settings (idempotent, reversible):

```bash
armord install claude-code            # user scope: ~/.claude/settings.json
armord install claude-code --project  # <project>/.claude/settings.json
```

`armord` must be on `PATH`. Start the daemon with `armord start` (or `armord service install`);
without it the hook builds the engine in-process from the same policy files.

## Verification status

The `.claude-plugin/plugin.json` fields (`name`, `version`, `description`, `license`), the
`hooks/hooks.json` shape and the `commands/*.md` frontmatter follow Claude Code's documented plugin
layout. This package has not been loaded into a live Claude Code or published to a marketplace.
Unlike ArmorClaude, there is no `$CLAUDE_PLUGIN_ROOT` script path: the hook calls the `armord`
binary on `PATH`.
