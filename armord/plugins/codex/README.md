# armord for Codex CLI

- `hooks/hooks.json`: a `PreToolUse` hook running `armord hook codex` (Bash, apply_patch, MCP tools).
- A hold waits on armord's queue (`armord holds`, `armord approve <id>`) up to 60 s, then denies,
  because Codex cannot show an approval prompt from a hook. Keep the hook `timeout` above that.

## Install

```bash
armord install codex            # ~/.codex/hooks.json
armord install codex --project  # <repo>/.codex/hooks.json
```

Codex skips a new or edited hook until you trust it: open Codex and review it once.

## Verification status

The hooks.json shape comes from the Codex hooks docs and schema (see
[docs/adapters.md](../../docs/adapters.md#codex-cli)). The `.codex-plugin/plugin.json` manifest
mirrors the location ArmorCodex's docs mention (`plugins/armorcodex/.codex-plugin/plugin.json`), but
Codex has no `plugin install` yet, so field names are unverified and the installer is the supported
path. Codex fails open if the hook crashes or `armord` is not on `PATH`.
