# ArmorIQ docs MCP server

Offline docs search for AI assistants. JSON-RPC 2.0 over stdin/stdout (MCP protocol `2024-11-05`, tools only), no dependencies at run time.

```bash
npm run index                 # build data/docs-index.json from ../docs and ../cookbook (no network)
node docs-mcp/server.mjs      # serve
ARMORIQ_DOCS_INDEX=/path/to/index.json node docs-mcp/server.mjs   # use another index
```

| Tool | Arguments | Returns |
|---|---|---|
| `search_docs` | `query`, `limit` (1-20, default 5), `product?` | ranked sections: page id, title, section, URL, score, snippet |
| `read_doc` | `id` or `url` (page id, `https://docs.armoriq.ai/...` URL, path, or exact title), `section?`, `max_chars?` | the page as markdown; a bad id is a tool error that says how to find one |
| `list_docs` | `product?` | every page (id, title, product, description) and the product list |
| `get_endpoint` | `path_or_name` (`POST /agent/register`, `/agent/agents/{id}/status`, or a page name) | matching routes (`:param` and `{param}` are equivalent), the doc lines that mention them, matching pages |
| `find_recipe` | `framework?`, `language?`, `outcome?` (allow, hold, block, prompt-injection, ...), `query?` | cookbook recipes with title, summary, products, demonstrated outcomes and the `create-armoriq-agent` command to scaffold them |

Run the tests with `node --test docs-mcp/test/*.test.mjs` (they drive the server over stdio).
