# 0005. Gap recipes: launch seeds, plugin policy packs, Intent Gateway, new frameworks

**Date**: 2026-11-10
**Status**: Proposed

## Summary

Nine new `community` recipes that fill the gaps the scope and taxonomy already name but nobody has started: the three Python launch seeds (scope features 14, 15, 16), the plugin policy recipe (feature 17, as two packs), the Intent Gateway (a shipped ArmorIQ product with no recipe and no taxonomy entry), and four frameworks the taxonomy lists with no recipe (OpenAI Agents SDK, Vercel AI SDK, LangGraph, Claude Agent SDK). Every one follows specs 0001 to 0004: taxonomy path, `recipe.yaml`, README in cookbook voice, `policy.yaml`, pinned dependencies, and a no-keys offline mode that prints the spec 0003 log contract.

## Recipe table

| # | Path (`recipes/...`) | Scope feature | Shows | Integration point |
|---|---|---|---|---|
| 1 | `claude-code/config/armordev-policy-pack` | 17 | allow, hold, block | ArmorClaude / ArmorCodex local policy (secondary framework `codex`) |
| 2 | `claude-code/config/armorops-policy-pack` | 17 | allow, hold, block | Same, for cloud and infra copilots (kubectl, terraform, aws, docker) |
| 3 | `sdk/python/handle-a-block` | 14 | allow, hold, block | Raw `capture_plan` / `get_intent_token` / `invoke` loop, and how an agent recovers from a block or a rejected hold |
| 4 | `langchain/python/sql-analyst` | 15 | allow, hold, block, prompt-injection | Shipped LangChain adapter (Python) |
| 5 | `crewai/python/delegated-crew` | 16 | allow, delegation, block | Raw client inside `BaseTool._run` plus `delegate()`: a child agent is refused what its parent could do |
| 6 | `openai-agents/python/gateway-monitor-to-enforce` | gateway | allow, block, monitor-mode | Intent Gateway base URL, monitor first, then enforce |
| 7 | `vercel-ai-sdk/typescript/gateway-support-bot` | gateway | allow, block | Intent Gateway base URL with the Anthropic provider |
| 8 | `langgraph/python/approval-interrupt` | new framework | allow, hold, block | ArmorIQ hold mapped onto a LangGraph `interrupt()` human approval |
| 9 | `claude-agent-sdk/typescript/governed-tools` | new framework | allow, hold, block | ArmorIQ check inside the Agent SDK's `canUseTool` permission callback |

## Decisions

- **Taxonomy**: adds `products.intent-gateway` and `outcomes.monitor-mode`.
- **Schema**: `tested_with` is now required only when a Python or TypeScript recipe lists the `sdk` product (matching the validator's existing SDK check). Gateway recipes install no ArmorIQ package, so there is nothing true to pin. New fixture: `schema/fixtures/valid/gateway-no-sdk.yaml`.
- **Gateway offline mode**: a stand-in gateway (a tiny local HTTP server inside the recipe) speaks the provider wire format, reads `policy.yaml`, removes blocked tool calls and appends the same note the real gateway adds (`Tool call "<name>" was blocked by policy: ...`). The recipe code only changes its base URL, exactly as it would live.
- **Policy packs (config lane)**: the config lane builds nothing, so each pack also ships `offline/test.mjs` (no dependencies) that evaluates sample tool calls against the pack and prints the log contract, so a reader can see held and blocked actions before installing the plugin.
- **SDK versions**: Python recipes pin `armoriq-sdk==0.8.18`, TypeScript recipes pin `@armoriq/sdk` `0.8.24` (current releases as of this spec).

## Follow-up

- `tools/check-recipe.mjs` could run `offline/test.mjs` for config lane recipes when present.
- Promote any of these to `official` once live checks (feature 12) exist.
