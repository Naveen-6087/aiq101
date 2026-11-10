# 0001. Place recipes by framework, then language

**Date**: 2026-10-21
**Status**: Proposed

## Summary

Every recipe lives at exactly one path: `recipes/<framework>/<language>/<slug>/`. The framework is whatever runs the agent loop (`sdk` when there is none). The language is the language of the recipe's main entry point (`config` for recipes with no real program, such as plugin policy setups). The slug names the scenario. The tier (`official` or `community`) is metadata plus a maintainer owned allowlist, not a folder, so promoting a recipe never moves it. Recipes share no code: every folder can be copied out and run on its own.

## Context

The cookbook is going open source, and anyone can add a recipe for any agent, in any framework, as long as it uses an ArmorIQ product. Today it holds two recipes, sitting flat in `recipes/github-agent/` and `recipes/adk-agent/`. The launch bar adds four more across two first class language lanes (Python and TypeScript/JavaScript, matching the two SDKs), plus one recipe that has no app code at all (an ArmorClaude or ArmorCodex policy setup). After launch the count is expected to grow past ten, and that is when the static gallery comes in.

Without a placement rule, contributors guess, reviewers argue about folders in every PR, and the same kind of recipe ends up in two places. Every later piece reads the path: the metadata validator (feature 6), the generated index (feature 7), and the per lane CI path filters (feature 8, which decides which toolchain runs). So the rule has to be mechanical: given a recipe's framework, language, product, and tier, it yields one path and only one.

The rule also has to cope with recipes that don't fit the obvious mould: a recipe with no agent framework (the raw SDK loop), a recipe with no code (plugin policy), a recipe in a language with no SDK yet (the `other` lane), and a recipe that mixes frameworks or languages. A move after launch breaks inbound links from the docs site, blog posts, and forks, so the layout should not depend on anything that changes over a recipe's life (its tier, mainly).

The repo is still private and only on a local branch, so moving the two existing recipes costs nothing now and gets expensive later.

## Options considered

### Option 1: Language first (`recipes/<language>/<framework>/<slug>/`)

The top level is the language lane, framework underneath.

**Pros**:
- The lane split you see on disk matches the SDK split and the CI jobs one to one.
- A lane's toolchain config could sit at the lane root.

**Cons**:
- People look for "the LangChain example" more often than for "the Python examples"; the framework sits one level deeper than where they look.
- No code plugin recipes have no language, so they need a special case at the top level.

### Option 2: Framework first, language second (`recipes/<framework>/<language>/<slug>/`)

The top level is the agent framework (or `sdk`, or the host coding agent for plugin recipes), the language under it.

**Pros**:
- Matches how readers search: they arrive knowing their framework.
- Plugin recipes fit the same rule with no special case (`claude-code/config/...`).
- The same scenario can exist in Python and TypeScript under one framework without a name clash.

**Cons**:
- The language split is the second level, so you can't see "all Python recipes" from a single folder; that view comes from the generated index.
- Many framework folders will hold one language and one recipe for a while, so paths are deep for what they contain.

### Option 3: Flat, metadata only (`recipes/<slug>/`)

No grouping folders; the manifest carries framework and language, and the index does all grouping.

**Pros**:
- Nothing ever moves; the shortest paths.

**Cons**:
- Browsing the folders shows no split at all, which is the scope's stated goal.
- Slugs must be globally unique, so ported scenarios get awkward names, and CI must parse manifests to pick a toolchain.

### Option 4: Tier as a folder (`recipes/official/...` and `recipes/community/...`)

A variation on any of the above that puts the tier in the path.

**Pros**:
- You can see trust level on disk.

**Cons**:
- Promoting a community recipe to official means a move, which breaks links and churns CI filters, exactly when a recipe is getting popular.

## Decision

**Chosen option**: Option 2: Framework first, language second, with the tier in metadata only (Option 4 rejected).

Every recipe lives at `recipes/<framework>/<language>/<slug>/`, chosen by the placement rules below, and nothing else lives under `recipes/`.

## Rationale

You picked framework first over my recommended language first. Both meet the scope's bar (a mechanical rule, a visible split). Framework first wins on the thing readers actually do (arrive with a framework in mind) and on uniformity: plugin recipes fit the rule with `config` in the language slot instead of needing a top level exception. The cost is real but manageable. "All Python recipes" is no longer a single folder, so the generated index (feature 7) must group by language as well as framework. CI is unaffected, because its unit is one recipe (the first three path segments of a changed file), not a lane prefix.

Tier stays out of the path because tier is the one attribute that changes routinely over a recipe's life. A placement rule built only from facts that rarely change (what runs the loop, the entry point's language, what the agent does) keeps a recipe's URL stable unless the recipe itself is rewritten onto another framework or language. That matters most once the repo is public and the docs site, posts, and forks link in. But tier is also a trust boundary: `official` recipes run live with secrets (feature 12), so a manifest field a contributor can edit cannot be the only gate. The tier is therefore confirmed by a maintainer owned allowlist that the live job reads.

No shared code follows from the README promise ("clone it, run it, adapt it"). A shared helper turns every recipe into a two folder copy and makes one change ripple through every recipe and every CI job. Duplication in teaching code is cheaper than coupling. Test fixtures, if feature 9 (offline mode) needs them, live inside each recipe for the same reason.

## Layout rule

### The path

```
recipes/
  <framework>/          e.g. sdk, langchain, crewai, google-adk, claude-code, codex
    <language>/         python | typescript | config | <other language name>
      <slug>/           the recipe, self contained
```

Exactly three levels. A recipe folder is always at depth three under `recipes/`. Apart from recipe folders, `recipes/` and its framework and language folders may hold only a generated `README.md` (if feature 7 chooses to generate one). No hand written files, no code, no shared folders.

### Placement inputs (where each path segment comes from)

| Segment | Source | Rule |
|---|---|---|
| `<framework>` | What runs the agent | The **runner test**: if the recipe imports a framework's agent runner or executor (the thing that calls the model, picks tools, and loops), that framework wins. Using only a framework's model or tool wrappers does not count, nor does an MCP client, a model provider SDK (Gemini, OpenAI, Anthropic client), or the ArmorIQ SDK; with no runner the value is `sdk`. For a plugin recipe it is the host agent the plugin runs in (`claude-code`, `codex`). For a config recipe with no host at all (registering an MCP server, a platform policy pack) it is `armoriq`. |
| `<language>` | The language of the recipe's main entry point | `python`; `typescript` for both TypeScript and plain JavaScript (the manifest records which); `config` when there is no real program (policy files, settings, a shell glue hook); otherwise the language's canonical folder name from the allowed list (`go`, `java`, `rust`, `csharp`, `cpp`). |
| `<slug>` | What the agent does, the scenario | Chosen by the contributor under the naming rules below. |
| tier | Manifest field plus the official allowlist (feature 2) | Never part of the path. |
| ArmorIQ product(s) | Manifest field (feature 2) | Never part of the path (the framework slot already carries plugin hosts). |
| lane | Derived from `<language>` | `python` → Python lane, `typescript` → TypeScript lane, `config` → config lane (validated, nothing to build), any other value → `other` lane. Used by CI (feature 8) and the index (feature 7). |

### Naming rules

- **Every segment**: lowercase kebab case, matching `^[a-z0-9]+(-[a-z0-9]+)*$`, at most 40 characters, and not a name Windows reserves (`con`, `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1` to `lpt9`).
- **Framework**: the framework's own short name (`langchain`, `langgraph`, `crewai`, `strands`). Add the vendor only when the short name is ambiguous across vendors: `google-adk`, `openai-agents`, `claude-agent-sdk`. One folder per distinct framework, so LangGraph is `langgraph`, not under `langchain`, and the Claude Agent SDK (`claude-agent-sdk`) is separate from the Claude Code plugin host (`claude-code`). The same framework uses the same folder whatever its package is called in each language. A major framework version updates recipes in place; it never gets a new folder.
- **Language**: one canonical folder name per language from the allowed list. The validator rejects known aliases with a hint (`javascript`, `js`, `ts` → use `typescript`; `py` → `python`; `c#` → `csharp`).
- **Slug**: the scenario in at most four words (`github-agent`, `ops-copilot`, `support-triage`). Never repeat the framework or the language; the path already says them. It only has to be unique within its language folder.
- **Recipe ID**: the path relative to `recipes/`, for example `sdk/typescript/github-agent`. That is the identifier the manifest, index, badges, and gallery key on. It is stable unless the recipe's framework or language changes (it gains a framework, is rewritten in another language, or a config recipe gains a real program); then it moves, and its manifest lists the old ID in `moved_from`.

### Tie breaks (a recipe that spans several)

- **Several frameworks** (LangGraph plus an MCP server, CrewAI wrapping LangChain tools): apply the runner test to the outer loop. The others go in the manifest as secondary tags.
- **Several languages** (a TypeScript agent plus a Python MCP server, a Python agent with a TypeScript UI): the language of the main entry point, the thing the README tells you to run first. The other languages go in the manifest. It stays one recipe, because neither half runs alone.
- **Several host agents** (one policy setup meant for both Claude Code and Codex): one recipe per host, each self contained, linked to each other in the manifest.
- **Plugin recipe with code** (an ArmorClaude recipe with a hook): the host is still the framework. The language is the hook's language if it is a real program, and `config` if it is shell glue around config files.
- **SDK recipe that also ships a policy file**: still an SDK recipe. Policy as data (feature 10) is a file inside the recipe, and `config` as a language is only for recipes with no real program.

### Key invariants (checked by the metadata validator, feature 6)

- The validator walks tracked files only (`git ls-files`), so untracked folders, `node_modules`, and `.DS_Store` never count.
- Every folder at depth three under `recipes/` is a recipe and holds a manifest; no manifest exists at any other depth.
- Every path segment meets the naming rules above (pattern, length, reserved names, no aliases).
- `<framework>` is on the allowed framework list and `<language>` on the allowed language list (both owned by feature 2). A PR that introduces a new framework or language folder adds it to that list in the same PR, so a new value is always a reviewed decision.
- The manifest's framework and language fields equal the path's segments. The manifest repeats them so a copied recipe still describes itself, and the validator rejects any mismatch. (Runner up: derive them from the path only. Rejected because a recipe copied out of the repo would lose them.)
- A recipe is `official` only when its manifest says so **and** its ID is on the official allowlist, a file owned by maintainers through CODEOWNERS. Either one without the other fails validation. The live end to end job (feature 12) reads only the allowlist and only on `main`, never the manifest of an incoming PR.
- No recipe escapes its folder: no imports, build config, or workspace references that resolve outside it, and no symlinks at all. Markdown links to repo docs (CONTRIBUTING, specs) are allowed.

### CI unit

The unit of CI is one recipe: map each changed file's first three segments under `recipes/` to a recipe ID, and run only those recipes (feature 8 builds the job list from that mapping with a script, since a plain path filter cannot). Changes outside `recipes/` (templates, tooling, the allowlist) trigger whatever feature 8 decides; this spec only fixes the unit.

### Existing recipes, target locations

| Today | Target | Why |
|---|---|---|
| `recipes/github-agent/` | `recipes/sdk/typescript/github-agent/` | No agent framework (an MCP client plus Gemini, ArmorIQ SDK in a hand written loop), plain JavaScript in the TypeScript lane. |
| `recipes/adk-agent/` | `recipes/google-adk/typescript/ops-copilot/` | Google ADK owns the loop; slug names the scenario and matches its package name `ops-copilot-agent`. |

### Seeded recipes, expected locations (for features 14 to 17)

| Seed | Expected path |
|---|---|
| Python raw SDK | `recipes/sdk/python/<slug>/` |
| Python LangChain | `recipes/langchain/python/<slug>/` |
| Python CrewAI | `recipes/crewai/python/<slug>/` |
| ArmorClaude plugin policy | `recipes/claude-code/config/<slug>/` (or `recipes/codex/config/<slug>/` for ArmorCodex) |

### Repo root

The root stays for repo wide things: `recipes/`, `docs/`, `.github/`, root `README.md`, and the open source kit files (feature 11). Recipe templates (feature 3) and repo tooling such as the index generator and validator (features 6 and 7) get their own root folders; their names are those features' call, but templates should mirror the language values (`python`, `typescript`, `config`) so a contributor copies `templates/<language>/` into `recipes/<framework>/<language>/<slug>/`.

## Consequences

**Positive**:
- Any proposed recipe resolves to one path from facts that rarely change, so URLs stay stable unless a recipe is rewritten onto another framework or language.
- Plugin, config, no framework, and new language recipes all fit one rule with no special cases.
- Tier promotion never moves files: a manifest change plus an allowlist line, reviewed by a maintainer.
- Each recipe folder is a complete, copyable project.

**Negative / tradeoffs**:
- There is no single "all Python" folder; the index (feature 7) must group by language.
- The official tier has two sources (manifest and allowlist) that must agree; that is deliberate, since the allowlist is the security gate, but it is one more file to keep in step.
- A recipe that changes framework or language does move, and git does not redirect old folder links; `moved_from` lets the index and gallery point readers to the new place.
- Paths are three levels deep even while most framework folders hold one recipe.
- Code is duplicated across recipes (config loading, error printing), and a fix to a common pattern has to be repeated by hand.
- `sdk` and the host agent names (`claude-code`, `codex`) sit beside real frameworks in the top level, so the top level is "what runs the agent", not strictly "framework"; the index labels should say so.

**Neutral**:
- The two existing recipes move once, before the repo goes public, via `git mv` so history follows (features 5 and 13). The only inbound link today is the root `README.md` list, which the generated index (feature 7) replaces.
- Feature 2's manifest needs framework, language, and the lane derivation, plus allowed value lists for framework and language.

## Follow-up

- [ ] Feature 2 (metadata manifest): include `framework` and `language` (must equal the path), a `js` or `ts` flavour field for the TypeScript lane, secondary framework and language tags, links to sibling recipes for other hosts, `moved_from`, the allowed value lists for framework and language (with the alias hints), and the location of the official allowlist file. Seed the framework list with a disambiguation table for the easily confused ones (Google ADK, OpenAI Agents SDK, Claude Agent SDK, Vercel AI SDK, AutoGen/AG2, Pydantic AI, Mastra, LlamaIndex).
- [ ] Feature 6 (validation check): enforce the invariants above, including tracked files only, depth, naming rules, allowed lists, path and manifest agreement, the official allowlist match, and no escapes from the recipe folder.
- [ ] Feature 7 (generated index): group by language and by framework, label the top level as "what runs the agent" rather than strictly "framework", use `moved_from` for old links, and decide whether to generate `README.md` files inside `recipes/` and its framework folders.
- [ ] Feature 8 (CI checks): build the job list per recipe from changed paths, a config lane that validates without building, how the `other` lane is checked, and what changes outside `recipes/` trigger.
- [ ] Feature 12 (live checks): read only the official allowlist on `main`; add the allowlist to CODEOWNERS (feature 11's ownership work, or here if that is deferred).
- [ ] Feature 3 (recipe kit): name the templates folder and mirror the language values.
- [ ] ArmorClaw recipes: confirm the host agent folder name (likely `openclaw`) with its first recipe, and add it to the allowed list then.
- [ ] Root `AGENTS.md` (feature 4) should carry a one paragraph summary of this rule with a link to this spec, so agents place new recipes correctly.
