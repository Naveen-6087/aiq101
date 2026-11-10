# 0003. Bring the aiq-demos scenarios into the cookbook as recipes

**Date**: 2026-10-31
**Status**: Proposed

## Summary

The nine demos in [Naveen-6087/aiq-demos](https://github.com/Naveen-6087/aiq-demos) become nine `community` recipes, each at its taxonomy path with a `recipe.yaml`, a README in cookbook voice, its `policy.yaml`, and an offline mode that runs with no keys, no Docker, and no network. The offline ArmorIQ stand-in reads the recipe's own `policy.yaml` to decide allow, hold, or block, so the offline run tells the same policy story as the live one. Every stand-in prints one shared log line format, which the recipe browser (spec [0004](0004-armoriq-recipe-browser.md)) turns into a visual timeline.

## Context

The cookbook has two recipes and a working pipe: manifest schema and validator (spec [0002](0002-recipe-metadata-manifest.md)), the layout rule (spec [0001](0001-repo-layout-recipe-taxonomy.md)), a generated index, and per lane checks that run each recipe's offline test (`tools/check-recipe.mjs`). The aiq-demos repo (author Naveen-6087, ArmorIQ team) holds nine working demos that were run live against ArmorIQ, plus docs ready cookbook pages for five of them in `cookbook/*.md`. None of them has an offline mode or a manifest, and two are Python, which opens the Python lane for the first time.

Decisions the user already made: all nine come in as `community`; the GitHub demo becomes its own recipe next to the existing GitHub agent (not merged); every recipe, Python included, gets a full offline mode.

## Requirements

**User stories**:
- As a reader, I want each demo as a recipe I can run offline in one command so that I can see the allow, hold, and block story before I create any account.
- As a maintainer, I want the new recipes to pass the same checks as the existing two so that CI covers them with no secrets.

**Acceptance criteria**:
- **AC-1**: The nine recipes exist at the paths in *Recipe table*, each with `recipe.yaml`, `README.md`, `policy.yaml` (or two for cross MCP, see table), `.env.example`, `.gitignore`, a lockfile, and an `offline/` folder.
- **AC-2**: `npm run check` passes (schema fixtures, every manifest, fresh index). The root README index lists 11 recipes.
- **AC-3**: `npm run check:recipes` passes for all 11 recipes, including both Python ones, with no `.env`, no Docker, and the network off for the recipe process (installing dependencies may use the network).
- **AC-4**: Each TypeScript recipe has `demo:offline` and `test:offline` scripts; each Python recipe has `offline/demo.py` and `offline/test.py`. Every offline demo is non interactive (runs to completion with stdin closed).
- **AC-5**: Every offline run prints the log contract lines (see *Offline log contract*), and each recipe's `test:offline` asserts at least one line for every outcome its manifest lists in `demonstrates`.
- **AC-6**: The offline ArmorIQ stand-in decides from the recipe's `policy.yaml` (rules by tool name, then `default_action`), not from hardcoded tool lists. Changing a rule in `policy.yaml` changes the offline result.
- **AC-7**: Setting `OFFLINE_APPROVAL=reject` turns every held call into a rejected one (`[armoriq] hold <tool>: REJECTED`) and the agent handles it without crashing; unset or `approve` approves.
- **AC-8**: Each manifest's `title` equals its README's first `# ` heading; `tested_with` equals the lockfile's resolved version (`@armoriq/sdk` from `package-lock.json`, `armoriq-sdk` pinned with `==` in `requirements.txt`); `authors` is `[Naveen-6087]`; `tier: community`; none of the nine is added to `.github/official-recipes.txt`.
- **AC-9**: Each README credits the original demo with a link to its folder in aiq-demos, keeps the demo's "Why `mode: "sdk"`" explanation where it had one, and has a "Run it offline" section with the one command. The CrewAI README keeps its honest proxy only limitation section.
- **AC-10**: The existing two recipes still pass their offline tests unchanged.

## Decision

Port each demo into its own recipe folder, keep the real agent code, and add offline stand-ins next to it. In TypeScript, follow the existing module hook pattern (`offline/register.mjs` + `offline/hooks.mjs` swap `@armoriq/sdk`, the MCP client module, and the planner or model module). In Python, `offline/register.py` puts stand-in modules into `sys.modules` before the agent is imported. One stand-in ArmorIQ per recipe reads that recipe's `policy.yaml`.

**Implementation skills**: none beyond the repo's own conventions (the existing two recipes' `offline/` folders are the reference).

## Recipe table

All `tier: community`, `authors: [Naveen-6087]`. Source = folder under `aiq-demos/demos/`. Titles follow the existing pattern "Build a ... with the ArmorIQ SDK"; where `aiq-demos/cookbook/<page>.md` exists, use its title and its prose as the README base.

| # | Path (`recipes/...`) | Source | Title base | use_case | demonstrates | products | services |
|---|---|---|---|---|---|---|---|
| 1 | `sdk/typescript/filesystem-notes` | `filesystem-notes-agent` | demo README | productivity | allow, hold | sdk, policies, approvals, mcp-registration | armoriq, gemini |
| 2 | `sdk/typescript/memory-knowledge` | `memory-knowledge-agent` | demo README | data-access | allow, hold, block | sdk, policies, approvals, mcp-registration | armoriq, gemini |
| 3 | `sdk/typescript/cross-mcp-research` | `cross-mcp-research-agent` | demo README | research | allow, hold, multi-server | sdk, policies, approvals, mcp-registration | armoriq |
| 4 | `sdk/typescript/postgres-notes` | `postgres-notes-agent` | `cookbook/postgres-agent.md` | data-access | hold | sdk, policies, approvals, mcp-registration | armoriq |
| 5 | `sdk/typescript/crypto-prices` | `coingecko-crypto-agent` | `cookbook/crypto-agent.md` | research | allow | sdk, policies, mcp-registration | armoriq, gemini, coingecko |
| 6 | `sdk/typescript/github-write-guard` | `github-agent` | demo README | devtools | allow, hold, block | sdk, policies, approvals, mcp-registration | armoriq, github, gemini |
| 7 | `langchain/typescript/weather-agent` | `langchain-tool-agent` | `cookbook/langchain-agent.md` | research | allow | sdk, policies, mcp-registration | armoriq, gemini |
| 8 | `strands/python/support-desk` | `strands-support-agent` | `cookbook/strands-agent.md` | support-ops | allow, hold, block, prompt-injection | sdk, policies, approvals, mcp-registration | armoriq, gemini |
| 9 | `crewai/python/crypto-crew` | `crewai-crypto-crew` | `cookbook/crewai-agent.md` | research | allow | sdk, mcp-registration | armoriq, gemini, coingecko |

Notes per recipe:
- **1, 2, 6 (Gemini planned)**: offline planner is rule based (keyword to tool calls), same role as `offline/planner.mjs` in the GitHub agent. The demo's own keyword fallback can serve as the stand-in if it already exists in `src/planner.js`.
- **2**: the scripted demo includes the `delete_entities` step (the memory wipe) so the block shows.
- **3**: ship both `policy.filesystem.yaml` and `policy.memory.yaml`; the stand-in picks the policy by the `<mcp>__` prefix of each step. That per server routing is the `multi-server` outcome.
- **4**: no Docker offline. The stand-in postgres MCP returns canned rows for a `notes` table seeded from `db/init.sql`. Keep `docker-compose.yml` and `db/init.sql` for the live path.
- **5, 9**: stand-in CoinGecko MCP returns canned prices. Keep the real `coingecko-mcp-server.js` (5) and `crypto_tool.py` (9) for the live path.
- **7**: offline swaps the Gemini chat model for a scripted tool calling model (two tool calls: geocode, then current conditions) and `weather-mcp` for canned data, while the real `ArmorIQLangChain` callback handler path runs against the stand-in SDK.
- **8**: stand-in SDK applies the policy's amount threshold rule to the `amount` argument (if the policy expresses one; otherwise per tool rules). The scripted run includes the `TCK-1002` injected ticket so the prompt injection outcome shows. Stand-in Gemini model for Strands is scripted.
- **9**: the offline run shows the crew completing with stand-in data and one allowed call; the README states plainly that per call policy is not available through `ArmorIQCrew` (the limitation section stays).

## Offline log contract

Every stand-in ArmorIQ (TypeScript and Python) prints these lines to stdout, one event per line, exactly this shape. Existing recipes already print `plan`, `check`, and `report` in this shape; this adds `HELD` and the `hold` line.

```
[armoriq] plan: <goal> -> <tool>, <tool>, ...
[armoriq] check <tool>: ALLOWED (<reason>)
[armoriq] check <tool>: HELD (<reason>)
[armoriq] check <tool>: BLOCKED (<reason>)
[armoriq] hold <tool>: APPROVED
[armoriq] hold <tool>: REJECTED
[armoriq] report <tool>: <status>
```

`<tool>` is the bare action name or `<mcp>__<action>`. `<reason>` names the matched rule (for example `policy filesystem-notes-policy: write_file -> hold`). An optional args line may follow a `check` line: `[armoriq] args <tool>: <single line JSON>` (the browser shows it on held cards). Prompt injection is shown by a `BLOCKED` or `HELD` check whose reason contains `prompt injection` or by the recipe printing `[armoriq] injection: <short description>` before it.

## Run conventions (shared with spec 0004)

- TypeScript: `npm run -s demo:offline`. If a recipe's offline demo cannot run unattended, it adds `demo:browser` (the browser prefers it). `sdk/typescript/github-agent` gets `"demo:browser": "node offline/test.mjs"`.
- Python: `.venv/bin/python offline/demo.py` (Windows: `.venv\Scripts\python.exe`). If no `.venv` exists, the browser shows "Run `npm run check:recipes <id>` once to set it up".
- Both read `OFFLINE_APPROVAL` (`approve` default, or `reject`).

## Taxonomy additions (`schema/taxonomy.yaml`)

- `outcomes.multi-server`: label "One plan, several MCP servers".
- `services.coingecko`: label "CoinGecko".
- `packages."armoriq-sdk"`: label "ArmorIQ SDK (Python)", ecosystem `pypi`, language `python` (resolves the spec 0002 follow-up on the PyPI name; `requirements.txt` in the demos uses `armoriq-sdk[strands]==0.6.10`).

## Build plan

Tracer Bullet: one recipe all the way through first, then widen.

1. Taxonomy additions above. Branch `feat/aiq-demos-recipes` (already created).
2. Tracer: recipe 1 (`filesystem-notes`) end to end: copy source, manifest, README, `policy.yaml`, offline stand-ins with the policy reading SDK, `test:offline`, lockfile with `@armoriq/sdk` resolved. `npm run validate && npm run check:recipes sdk/typescript/filesystem-notes` green.
3. Extract nothing shared across recipes (spec 0001: recipes share no code); copy the policy reading stand-in into each recipe and adjust.
4. Recipes 2 to 6 (TypeScript, SDK loop).
5. Recipe 7 (LangChain TS).
6. Python lane: recipe 8 (Strands) then 9 (CrewAI), with pinned `requirements.txt` (`==` for every line).
7. Add `demo:browser` to the GitHub agent. `npm run index`, then `npm run check` and `npm run check:recipes` for all 11.
8. Scope: tick milestones in feature 20.

## Consequences

- The Python lane gets real coverage for the first time; CI time grows (CrewAI install is heavy).
- Each recipe carries its own copy of the stand-in SDK. Some duplication, by design (spec 0001).
- `crewai/python/crypto-crew` does not satisfy scope feature 16's "delegated agent refused" bar; feature 16 stays planned.

## Follow-up

- aiq-demos has no LICENSE file. Before the repo goes public, confirm with Naveen that the code can ship under the cookbook's license (feature 11).
- The demos were run live on `@armoriq/sdk` ^0.6.8; recipes pin what installs today. Live verification belongs to feature 12.
- Promote any of these to `official` once feature 12 exists.

## Rationale

Community tier, separate GitHub recipe, and offline for all were the user's calls. Reading `policy.yaml` in the stand-in (over hardcoded lists in the existing recipes) keeps the offline story honest and makes the policy file load bearing, which also moves feature 10 (policy as data) forward. A single log contract lets the browser render any recipe's run without per recipe code.
