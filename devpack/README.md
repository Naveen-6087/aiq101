# ArmorIQ dev pack

Three small tools that make it faster to build governed agents with ArmorIQ. Everything works offline once built, and nothing here needs an API key.

| Part | What it does |
|---|---|
| [`docs-mcp/`](docs-mcp) | A stdio MCP server that lets an AI assistant search and read the ArmorIQ docs, look up API routes, and find cookbook recipes. Tools: `search_docs`, `read_doc`, `list_docs`, `get_endpoint`, `find_recipe`. |
| [`skills/`](skills) | Four agent skills (`armoriq-integrate`, `armoriq-write-policy`, `armoriq-debug-block`, `armord-setup`) plus an installer for Claude Code, Cursor and Codex. |
| [`create-armoriq-agent/`](create-armoriq-agent) | A scaffolder: pick a framework, get a runnable cookbook recipe, an `armord` policy template with expected-verdict tests, an `armord.config`, `.env.example` and a README with the offline run. |

## Quick start

```bash
npm install            # one dev dependency (yaml), used only by the build scripts
npm run build          # index the docs and snapshot the cookbook recipes + armord templates
npm test

# 1. docs MCP server
node docs-mcp/server.mjs                       # speaks MCP over stdin/stdout

# 2. skills
node skills/install.mjs claude                 # or: cursor, codex (add --dry-run first)

# 3. scaffold an agent
node create-armoriq-agent/bin/create.mjs my-agent --framework langchain --language python --policy armordev
node create-armoriq-agent/bin/create.mjs --list      # frameworks, recipes, policies
node create-armoriq-agent/bin/create.mjs             # interactive in a terminal
```

Register the docs server with an MCP client, for example Claude Code:

```bash
claude mcp add armoriq-docs -- node /absolute/path/to/devpack/docs-mcp/server.mjs
```

or in any client's JSON config:

```json
{ "mcpServers": { "armoriq-docs": { "command": "node", "args": ["/absolute/path/to/devpack/docs-mcp/server.mjs"] } } }
```

## How it fits with the rest

- **Docs corpus** (`../docs`): `npm run index` splits `llms-full.txt` into heading-sized sections using the page list in `index.json` (all 255 pages matched when this was written) and writes `docs-mcp/data/docs-index.json`. Re-run it when the corpus is refreshed. Search is BM25 over those sections; there is no network or embedding model.
- **Cookbook** (`../cookbook`): `find_recipe` reads every `recipe.yaml`; `npm run snapshot` copies the 18 runnable recipes (not the `claude-code` policy packs) into `create-armoriq-agent/templates/`, so the scaffolder does not need the cookbook checkout at run time. The scaffolder picks one offline-capable recipe per framework and language (see `DEFAULTS` in `build-snapshot.mjs`), or any bundled recipe with `--recipe <path>`.
- **armord** (`../armord`): the scaffolder copies a policy template (`armord/templates/*.yaml`, with its `.cases.yaml`) into the new project. The skills describe armord's real commands (`doctor`, `install`, `migrate`, `policy test`, `logs`, ...); a test fails if a skill mentions an armord command that does not exist.

## Scope and honesty

- The docs index only knows what is in the local corpus snapshot (generated 2026-11-09). Rebuild it after the docs change.
- `get_endpoint` finds routes by scanning the docs for `METHOD /path` strings (63 found). It does not know request or response schemas beyond what the docs print next to them.
- The scaffolded `armord.config` is a dotenv-style file of real `ARMORD_*` variables to source before `armord start`; armord itself has no config-file loader.
- The skills and the Cursor and Codex install formats were not loaded into those live hosts (see `skills/README.md`).
- Not committed anywhere.
