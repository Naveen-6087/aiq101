# Scope: ArmorIQ Cookbook

An open source collection of runnable, end to end recipes for building governed AI agents with ArmorIQ. Anyone can contribute a recipe for any agent or scenario, in any framework, as long as it uses an ArmorIQ product (SDK, ArmorClaw, ArmorClaude or ArmorCodex plugins, policies, or MCP registration). Recipes are organized and discoverable by language, framework, ArmorIQ product, and use case. This repo is separate from the docs site at docs.armoriq.ai; each one stands on its own.

**Build approach:** Tracer Bullet (push one recipe through the whole contribution pipe first: layout, metadata, CI checks, generated index; then widen to more recipes and the contributor experience).
**Workflow:** Beta (`/check verify`, then `/test`). The project default level of rigor. `/architect` is the recommended first stop for a feature with a real decision, but skippable when you already know the build. Any feature can carry its own tag (e.g. `· GA`) to do more or less.

_These are recommendations to keep your build orderly, not requirements. Skip anything that does not fit: if you already know how to build a feature, use `/develop` and skip `/architect`. You decide when a feature is `done`._

**Launch bar (decided):** contribution system, taxonomy, CI, and generated index in place, with the two existing recipes plus four seeded ones (Python raw SDK, Python LangChain, Python CrewAI, an ArmorClaude or ArmorCodex plugin policy recipe), so both language lanes are visible on day one. Two quality tiers: `official` (maintained by ArmorIQ, tested live end to end) and `community` (reviewed, must build and pass offline checks, no upkeep promise). First class language lanes: Python and TypeScript/JavaScript, matching the two SDKs; anything else lands in an `other` lane. The static gallery site comes after launch.

## At a glance

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| A | GitHub agent recipe (JS) | Existing | existing |
| B | Google ADK agent recipe (TS) | Existing | existing |
| 1 | Repo layout & recipe taxonomy | Foundation | in-progress |
| 2 | Recipe metadata manifest | Foundation | in-progress |
| 3 | Recipe kit & house style | Foundation | planned |
| 4 | Coding standards & tooling | Foundation | planned |
| 5 | Migrate GitHub agent recipe (first through the pipe) | Slice 1 | done |
| 6 | Metadata validation check | Slice 1 | done |
| 7 | Generated recipe index | Slice 1 | done |
| 8 | Per lane build and offline test checks | Slice 1 | done |
| 9 | Offline / mock mode convention | Slice 2 | in-progress |
| 10 | Policy as data | Slice 2 | planned |
| 11 | Core open source kit | Slice 2 | planned |
| 12 | Official tier live end to end checks | Slice 2 | planned |
| 13 | Migrate Google ADK agent recipe | Slice 3 | done |
| 14 | Seed: Python raw SDK recipe | Slice 3 | planned |
| 15 | Seed: Python LangChain recipe | Slice 3 | planned |
| 16 | Seed: Python CrewAI recipe | Slice 3 | planned |
| 17 | Seed: ArmorClaude / ArmorCodex plugin policy recipe | Slice 3 | planned |
| 18 | Topic tags & recipe badges | Slice 3 | planned |
| 19 | Public launch | Launch | planned |
| 20 | aiq-demos recipes (9 community recipes) | Slice 4 | in-progress |
| 21 | ArmorIQ restyle of the recipe browser | Slice 4 | in-progress |

## Already here

### A. GitHub agent recipe (JS) · existing
CLI agent that searches and reads a GitHub repo through the GitHub MCP server, with every tool call checked against policy. Imported from docs.armoriq.ai/cookbook; installs and passes a syntax check, not yet run against a live account. code in `recipes/github-agent/`

### B. Google ADK agent recipe (TS) · existing
Ops copilot on Google ADK showing allow, hold, and block (including a blocked prompt injection). Imported from docs.armoriq.ai/cookbook; installs and type checks, not yet run live. Depends on the external `armoriq-adk-ops-mcp` server. code in `recipes/adk-agent/`

## Foundations

### 1. Repo layout & recipe taxonomy · in-progress
Decide how recipes are laid out on disk and named, so the language and framework split is obvious when browsing the folders, and contributors know exactly where a new recipe goes. Covers the `official` / `community` tiers, the `other` lane, and shared code (if any).
**Done when:** a written layout rule places any proposed recipe (language, framework, product, tier) in exactly one path, and the two existing recipes have a target location.
spec [0001](../specs/0001-repo-layout-recipe-taxonomy.md)
- [x] Design it (spec): `/architect repo layout & recipe taxonomy`

### 2. Recipe metadata manifest · in-progress
One small metadata file per recipe declaring language, framework, ArmorIQ products used, use case, tier, authors, and tested SDK versions. This is the single source the index, badges, tags, and later the gallery all read from.
**Done when:** the schema is written down with required and optional fields, and a valid example exists for each existing recipe.
spec [0002](../specs/0002-recipe-metadata-manifest.md) · code in `schema/`, `recipes/*/recipe.yaml`, `.github/official-recipes.txt`
- [x] Design it (spec): `/architect recipe metadata manifest`
- [x] Build it: `/develop recipe metadata manifest`
  - [x] Taxonomy and JSON Schema written (AC-1, AC-2)
  - [x] Fixture runner plus valid and invalid fixtures pass (AC-6)
  - [x] GitHub agent manifest and official allowlist, the tracer (AC-3, AC-4, AC-7, AC-8)
  - [x] ADK ops copilot manifest (AC-5, AC-7, AC-8)
- [ ] Verify it: `/check verify recipe metadata manifest`
- [ ] Test it: `/test recipe metadata manifest`

### 3. Recipe kit & house style · needs a decision
The required contents of every recipe and the README template: guide, runnable code, `.env.example`, pinned dependencies, policy as data, offline mode, and demo output. Sets the voice and section order so recipes read like one cookbook.
**Done when:** a recipe template folder exists per lane, and a reviewer can check any PR against a short required list.
- [ ] Design it (spec): `/architect recipe kit & house style`

### 4. Coding standards & tooling
Per lane lint, format, and typecheck conventions (Python and TypeScript/JS), captured once and enforced the same way locally and in CI.
**Done when:** root `AGENTS.md` describes the repo and lanes, and lint/format/typecheck run clean on every existing recipe.
- [ ] Capture conventions + tooling choices: `/audit`

## Slice 1: One recipe through the whole pipe

### 5. Migrate GitHub agent recipe (first through the pipe) · done
Move the GitHub agent into the new layout with its metadata file and kit pieces. It is the tracer: it flows through every check and lands in the generated index.
**Done when:** the recipe sits at its taxonomy path, has valid metadata, meets the kit list, and appears in the index.
code in `recipes/sdk/typescript/github-agent/` (moved, with valid metadata, in the index; the ADK recipe moved too, to `recipes/google-adk/typescript/ops-copilot/`)
- [x] Build it: `/develop migrate github agent recipe`
  - [x] Moved to its taxonomy path, valid metadata, listed in the index
  - [x] Runs offline (`npm run demo:offline`, `npm run test:offline`)
  - skipped: meets the kit list (there is no kit list yet; feature 3 checks it)

### 6. Metadata validation check · done
An automatic check on every PR that each recipe's metadata matches the schema and its declared values (language, framework, product) are from the allowed lists.
**Done when:** a PR with missing or invalid metadata fails with a clear message naming the file and field; a valid one passes.
Built directly from specs 0001 and 0002 (no separate spec). code in `tools/validate.mjs`, run by `.github/workflows/recipes.yml`
- [x] Design it (spec): covered by specs 0001 and 0002
- [x] Build it: `npm run validate`
- [x] Verified locally: 11 planted problems all reported with file, field, and fix
- skipped: verify on a real PR (repo not pushed yet)

### 7. Generated recipe index · done
Root README tables (and lane READMEs if the layout calls for them) generated from metadata, grouped by language and framework, so the index never drifts from the recipes.
**Done when:** adding a recipe and running the generator updates the tables; CI fails if the committed index is stale.
Built directly (root README only, no lane READMEs). code in `tools/build-index.mjs`, run by `.github/workflows/recipes.yml`
- [x] Design it (spec): decided in the build, root README tables by language and by what runs the agent
- [x] Build it: `npm run index` and `npm run index:check`
- [x] Verified locally: a manifest edit makes `index:check` fail until `npm run index` runs
- skipped: verify on a real PR (repo not pushed yet)

### 8. Per lane build and offline test checks · done
CI that installs, lints, typechecks, and runs the offline tests for only the recipes a PR touches, safely, since it runs outside contributors' code.
**Done when:** a PR touching one Python recipe runs only that recipe's checks; a broken recipe fails the PR; no secrets are reachable from fork PRs.
Built directly. code in `tools/check-recipe.mjs` (`npm run check:recipes`), `tools/changed-recipes.mjs`, `.github/workflows/recipes.yml` (`pull_request` only, read only token, no secrets, recipe ID passed through env)
- [x] Design it (spec): decided in the build: one CI job per changed recipe; typescript lane installs, typechecks or syntax checks, runs `test:offline`; python lane installs into a venv, compiles, runs `offline/test.py`; config lane validates only
- [x] Build it, verified locally: both recipes pass, and a broken planner fails the check
- skipped: Python lane run (no Python recipe yet; lands with feature 14) · lint (waits on feature 4)
- skipped: verify on a real PR (repo not pushed yet)

## Slice 2: Contributor trust and experience

### 9. Offline / mock mode convention · in-progress
A standard way for every recipe to run its tests (and ideally a demo) with no real keys, so reviewers and CI can check community recipes without secrets.
**Done when:** the GitHub agent runs its offline tests with no `.env`, and the convention is in the recipe kit.
Built for both recipes: an `offline/` folder whose `register.mjs` swaps the SDK, model, and MCP imports for local stand-ins via Node module hooks, so the real agent code runs unchanged; `npm run demo:offline` and `npm run test:offline`.
- [x] Design it (spec): decided in the build (stand-ins via module hooks, recipe code untouched)
- [x] GitHub agent and ADK ops copilot run and test offline with no `.env`
- [ ] Put the convention in the recipe kit (feature 3)

### 10. Policy as data · needs a decision
Ship the ArmorIQ policies a recipe expects as a file alongside the code, so readers do not recreate them by hand in the console. Decide the format and how a reader applies it (console import, CLI, or documented manual steps).
**Done when:** the GitHub agent ships its policy file, and a reader can apply it by following one documented path.
- [ ] Design it (spec): `/architect policy as data`

### 11. Core open source kit · needs a decision
LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, a PR template with the kit checklist, and issue forms (new recipe proposal, recipe request, bug). The license choice is the decision.
**Done when:** GitHub shows the community profile as complete, and a first time contributor can go from reading CONTRIBUTING to an opened PR without asking anyone.
- [ ] Design it (spec): `/architect core open source kit`

### 12. Official tier live end to end checks · needs a decision · GA
Scheduled and maintainer triggered runs of `official` recipes against the real ArmorIQ platform, so official recipes stay working as the SDK and platform change. Secrets handling makes this the riskiest piece.
**Done when:** official recipes run live on a schedule and on demand, failures notify an owner, and fork PRs can never trigger a run with secrets.
- [ ] Design it (spec): `/architect official tier live end to end checks`

## Slice 3: Widen the cookbook

### 13. Migrate Google ADK agent recipe · done
Move the ADK recipe into the layout with metadata, kit pieces, offline mode, and policy file.
**Done when:** it passes every check and appears in the index alongside the GitHub agent.
code in `recipes/google-adk/typescript/ops-copilot/`
- [x] Build it: moved, valid metadata, in the index, runs offline (allow, hold, block)
- skipped: policy file (feature 10) and kit pieces (feature 3)

### 14. Seed: Python raw SDK recipe · needs a decision
The plain plan, intent token, invoke loop in Python with no framework. The template people copy for any framework without an adapter.
**Done when:** it passes every check, runs offline, and shows at least one allowed and one blocked call.
- [ ] Design it (spec): `/architect seed python raw sdk recipe`

### 15. Seed: Python LangChain recipe · needs a decision
A realistic LangChain agent governed through the SDK's LangChain adapter. Opens the Python lane with the most popular framework.
**Done when:** it passes every check, runs offline, and shows allow, hold, and block outcomes.
- [ ] Design it (spec): `/architect seed python langchain recipe`

### 16. Seed: Python CrewAI recipe · needs a decision
A multi agent CrewAI scenario through the CrewAI adapter, showing delegation with narrowed permissions.
**Done when:** it passes every check, runs offline, and shows a delegated agent being refused something its parent could do.
- [ ] Design it (spec): `/architect seed python crewai recipe`

### 17. Seed: ArmorClaude / ArmorCodex plugin policy recipe · needs a decision
A no app code recipe: a ready policy setup for a coding agent (for example, lock secrets folders, hold deploys), showing the plugin side of ArmorIQ. Proves the taxonomy handles recipes that are not SDK code.
**Done when:** it validates under the metadata schema with its own product and lane, and a reader can apply it and see a held and a blocked action.
- [ ] Design it (spec): `/architect seed armorclaude armorcodex plugin policy recipe`

### 18. Topic tags & recipe badges
Badges on each recipe README (language, framework, product, tier, tested SDK version) and repo topics, generated from metadata.
**Done when:** every recipe README shows its badges from metadata, and changing metadata updates them.
- [ ] Build it: `/develop topic tags & recipe badges`

## Slice 4: aiq-demos recipes and the ArmorIQ browser

### 20. aiq-demos recipes (9 community recipes) · in-progress
Bring the nine demos from github.com/Naveen-6087/aiq-demos in as `community` recipes: filesystem notes, memory knowledge, cross MCP research, Postgres notes, crypto prices, GitHub write guard, LangChain weather (TS), Strands support desk (Python), CrewAI crypto crew (Python). Each runs offline, with the stand-in deciding from its own `policy.yaml`.
**Done when:** all 11 recipes pass `npm run check` and `npm run check:recipes` with no keys, and the index lists them.
spec [0003](../specs/0003-aiq-demos-recipes.md) · code in `recipes/sdk/typescript/{filesystem-notes,memory-knowledge,cross-mcp-research,postgres-notes,crypto-prices,github-write-guard}/`, `recipes/langchain/typescript/weather-agent/`, `recipes/strands/python/support-desk/`, `recipes/crewai/python/crypto-crew/`
- [x] Design it (spec): `/architect aiq-demos recipes`
- [x] Build it: `/develop aiq-demos recipes`
  - [x] Taxonomy additions and the filesystem notes tracer, end to end
  - [x] Remaining TypeScript SDK recipes (memory, cross MCP, Postgres, crypto, GitHub write guard)
  - [x] LangChain weather recipe
  - [x] Python lane: Strands support desk and CrewAI crypto crew
  - [x] Index regenerated, all checks green
- [ ] Verify it: `/check verify aiq-demos recipes`
- [ ] Test it: `/test aiq-demos recipes`

### 21. ArmorIQ restyle of the recipe browser · in-progress
Rebuild the local recipe browser (`npm run serve`) in the ArmorIQ V5 design system, with filters, a Policy tab, and a run viewer that shows each call as allowed, held, or blocked.
**Done when:** every surface uses `aq-*` tokens only, light and dark work, and all 11 recipes run from the browser with a timeline.
spec [0004](../specs/0004-armoriq-recipe-browser.md) · code in `tools/server.mjs`, `tools/browser/`
- [x] Design it (spec): `/architect armoriq recipe browser`
- [x] Build it: `/develop armoriq recipe browser`
  - [x] Static files, tokens, fonts, primitive classes
  - [x] Rail, recipe view, tabs, Policy tab
  - [x] Convention based run and the timeline viewer
  - [x] Theme, a11y, path check, hand check in a real browser
- [ ] Verify it: `/check verify armoriq recipe browser`
- [ ] Test it: `/test armoriq recipe browser`

## Launch

### 19. Public launch
Final pass before making the repo public: everything above green, root README tells the story in one screen, and the repo settings (visibility, topics, branch protection, discussions) are ready.
**Done when:** the repo is public, CI is green on main, six recipes are listed across both lanes, and the contribution path is tested by someone outside the team.
- [ ] Build it: `/develop public launch`

## Deferred
Out of scope for the launch, kept so the plan stays honest.
- **Static gallery site**: searchable, filterable site built from the same metadata, once there are 10+ recipes · needs a decision
- **Recipe scaffolder**: one command creates a new recipe from the template for a chosen lane · needs a decision
- **Maintainer ownership**: CODEOWNERS per lane, labels, triage rules
- **Contributor recognition**: credits and author fields shown in the index
- **Recipe request board**: pinned list of wanted language x framework gaps and good first issues
- **More language lanes**: Go, Java, and others once demand or an SDK exists · needs a decision
- **Remaining framework seeds**: Langflow (Strands lands with feature 20), OpenAI and Anthropic raw client recipes

## Legend

**The decision box.** Every feature carries exactly one, the sub-task whose label ends with `(spec)`. Its wording varies (`Design it (spec)` normally), so skills locate it by that `(spec)` suffix, never by an exact label. Every other box is an execution box and `/architect` never ticks one.

**Feature lifecycle**: the scope updates as a feature moves; each row is what it shows and who sets it:

| State | Set by | The feature shows |
|---|---|---|
| `planned` · needs a decision | `/scope` | one box: `Design it (spec): /architect <feature>` |
| `in-progress` (designed) | **`/architect` at spec capture** | `Design it` ticked; spec linked; `Build it: /develop <feature>` + **2 to 5 milestones**; the tier's closing boxes (`Verify it` Alpha+, `Test it` Beta+, `Review it` + `Document it` GA); any surfaced follow-up enrolled |
| `in-progress` (building) | `/develop` | milestone sub-boxes tick one by one; code pointer filled |
| `in-progress` (verified) | `/check verify` | `Build it` + milestones ticked; `Verify it` ticked |
| `done` | **you, when you decide it is** (any skill sets it when you say so); `/sync` reconciles | boxes you ran ticked, skipped ones marked skipped; the tier's last stage (`Prototype` → after `/develop`; `Alpha` → after `/check verify`; `Beta`/`GA` → after `/test`) is the suggested point to call it done; `/sync` captures conventions |

- **Next step** = the first unticked box (always a command or a tracked milestone).
- **needs a decision** = run `/architect` first; otherwise straight to `/develop` (or `/audit` for standards & tooling). The tag drops once the spec is captured.
- **Atomic build tasks live in the spec's `## Build plan`, not here**: the scope carries only the milestone rollup.
- **Status** `planned` → `in-progress` → `done`, plus `existing` (pre-workflow) and `dropped` (de-scoped, kept for history).
- **Approach tag** beside a heading (e.g. `· Facade`) overrides the project default for that feature; no tag = inherits it.
- **Workflow tier tag** beside a heading (e.g. `· GA`, `· Prototype`) sets that one feature's rigor above or below the project default; no tag inherits the default. It decides the feature's check boxes and each skill's next suggestion.
- **Workflow** (header line) is the project default, what runs after `/develop`: **Prototype** = nothing (trust develop's own build time self check); **Alpha** = `/check verify`; **Beta** = `/check verify` then `/test`; **GA** = adds a fresh model `/check review` then `/document`. A feature built on an unratified decision (an `Assumed` spec) stays flagged, but that never blocks `done`.
- **Pointer line** (`spec <n> · code in <path>`): the spec link added by `/architect`, the code path by `/develop`.
