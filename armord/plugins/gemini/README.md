# armord for Gemini CLI

- `gemini-extension.json`: extension manifest declaring the `armord-plan` MCP server and `GEMINI.md`
  as context. Same `mcpServers` shape as ArmorGemini's manifest.
- `hooks/hooks.json`: the `BeforeTool` hook block (`armord hook gemini`, timeout in ms).
- `GEMINI.md`: context telling the model not to route around a denial.

## Install

Gemini reads hooks from `settings.json`, so install them with the installer:

```bash
armord install gemini            # ~/.gemini/settings.json
armord install gemini --project  # <project>/.gemini/settings.json
```

For the MCP server and context file, link this folder as an extension
(`gemini extensions link plugins/gemini`, if your Gemini CLI has that command).

## Verification status

Verified against the docs: the `settings.json` hook block and the manifest's `mcpServers` shape
(ArmorGemini publishes both). Not verified: whether Gemini loads `hooks/hooks.json` from an extension
folder (ArmorGemini merges into `settings.json` instead, so the installer does the same), and the
`contextFileName` field. If the hook times out or fails to start, Gemini runs the tool.
