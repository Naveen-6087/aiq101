# 0002. Describe each recipe with a recipe.yaml manifest

**Date**: 2026-10-21
**Status**: In Progress

## Summary

Every recipe carries one small file, `recipe.yaml`, that says what it is: its framework and language, which ArmorIQ products it uses, what it is for, who wrote it, and which SDK version it was tested with. A JSON Schema (a machine readable rulebook for the file's shape) checks the shape, and one `taxonomy.yaml` file holds the allowed values with their labels and aliases. The index, badges, live checks, and later the gallery all read from these files, so a recipe is described once and nothing drifts. The official tier stays doubly gated: the manifest says `official`, and a maintainer owned allowlist has to agree.

## Context

Spec [0001](0001-repo-layout-recipe-taxonomy.md) placed every recipe at `recipes/<framework>/<language>/<slug>/` and pushed everything else about a recipe into metadata: its tier, ArmorIQ products, secondary frameworks and languages, sibling recipes, and old IDs. Four later features read that metadata: the validation check (feature 6), the generated index (feature 7), the live end to end checks (feature 12), and badges and topics (feature 18). The deferred gallery reads it too. Each of them needs the same facts in the same shape. If each invents its own source (parsing READMEs, reading lockfiles, keeping its own lists), they drift, and the index ends up disagreeing with the badges.

The file is written by hand, by contributors who have never seen the repo before, in both language lanes. So it has to be easy to write correctly, and wrong in a loud way when it is not. Silent mistakes (a misspelled optional field that just vanishes, a version that no longer matches what the recipe installs) are the main risk. A recipe is also meant to be copied out and run alone, so the file has to describe the recipe even outside the repo.

Two values carry trust. `tier: official` means ArmorIQ maintains the recipe and runs it live with real secrets, so a field a contributor can edit must never be the gate on its own (0001 settled this with an allowlist; this spec fixes where that lives and its format). The "tested with" SDK version is shown on badges as a promise, so it has to be true.

Today there are two recipes and launch adds four more. Past launch the count grows toward the gallery threshold (10+). Allowed value lists (frameworks, products, use cases) will grow with every new kind of recipe, so adding a value has to be a small, reviewable change.

## Requirements

**User stories**:
- As a contributor, I want one short file with clear rules and editor hints so that I can describe my recipe without reading the tooling.
- As a maintainer, I want every recipe described in one checked shape so that the index, badges, and live checks agree with each other and with the code.
- As a reader, I want to see a recipe's language, framework, products, needs, and tested SDK version at a glance so that I can pick the right one.

**Acceptance criteria**:
- **AC-1**: `schema/recipe.schema.json` exists, is a valid JSON Schema draft 2020-12 document, defines every field in the field table below with its type, required or optional status, and the constraints that live inside one file (types, lengths, patterns, uniqueness, and the linked rules for `variant`, `deprecation_note`, and `tested_with` by language), sets `additionalProperties: false` on every object, and gives every property a `description`. Rules that look across files or need case insensitive matching are listed under *Schema versus validator* and are not in the schema.
- **AC-2**: `schema/taxonomy.yaml` exists in the shape under *Taxonomy shape* and holds the lists `frameworks`, `languages`, `products`, `use_cases`, `outcomes`, `services`, and `packages`, seeded with at least the values in *Taxonomy seed*. Every entry has a `label`. Frameworks carry `kind` and, where they are easily confused, a `note`. Languages carry `lane` and `aliases`. Use cases carry a `description`.
- **AC-3**: `.github/official-recipes.txt` exists in the format under *Official allowlist* and lists `sdk/typescript/github-agent` and `google-adk/typescript/ops-copilot`.
- **AC-4**: `recipes/github-agent/recipe.yaml` exists with the values in *Example manifests*, validates against the schema, and every taxonomy field value in it is present in `taxonomy.yaml`.
- **AC-5**: `recipes/adk-agent/recipe.yaml` exists with the values in *Example manifests*, validates against the schema, and every taxonomy field value in it is present in `taxonomy.yaml`.
- **AC-6**: `node schema/check.mjs` (run from the repo root after `npm ci`) loads every file in `schema/fixtures/` with js-yaml 4 and validates it with Ajv in draft 2020-12 mode. Every file in `schema/fixtures/valid/` passes. Every file in `schema/fixtures/invalid/` fails, and at least one of its errors names the offending field in its `instancePath` or `params` (`additionalProperty`, `missingProperty`). The script exits non zero if any fixture behaves otherwise. There must be at least one invalid fixture each for: an unknown key (`framwork`), a missing required field, `variant` on a non TypeScript recipe, `variant` missing on a TypeScript recipe, `status: deprecated` with no `deprecation_note`, a `tested_with` range instead of an exact version (`^0.6.10`), an empty `products` list, and a bare number where a string is expected (`use_case: 404`).
- **AC-7**: In both example manifests, `tested_with."@armoriq/sdk"` equals the version that recipe's `package-lock.json` resolves for `node_modules/@armoriq/sdk` (today `0.6.10` in both).
- **AC-8**: In both example manifests, `title` equals the recipe README's first `# ` heading, character for character.

## Options considered

### Option 1: One recipe.yaml per recipe, checked by a JSON Schema plus a taxonomy file

A YAML manifest at the recipe root. A JSON Schema holds the shape (types, required fields, patterns, and the rules that link one field to another). A separate `taxonomy.yaml` holds the allowed values with labels, aliases, and notes. The validator (feature 6) checks membership.

**Pros**:
- Easy to write by hand, comments allowed, the same file in both lanes.
- JSON Schema is language neutral, editors hint from it, and validators exist in Python and JS.
- The allowed values carry what the index and the validator's hints need (labels, aliases, disambiguation), in one place.

**Cons**:
- YAML quirks (old loaders turn `no` into false, and bare `1.10` becomes a number) must be handled by using a YAML 1.2 loader and string types in the schema.
- Membership in the allowed lists is a second check outside the schema, so plain schema validation alone does not prove a manifest is fully valid.

### Option 2: recipe.json with every allowed value as an enum inside the schema

The same fields, in JSON, with the lists written as `enum`s in the schema.

**Pros**:
- One file holds every rule. Any off the shelf validator gives a complete answer, and editors autocomplete values too.
- JSON has no parsing surprises.

**Cons**:
- No comments, and trailing commas and quoting trip up first time contributors.
- Enums have no room for labels, aliases, or disambiguation notes, so those scatter into the index and validator code.

### Option 3: Frontmatter at the top of each recipe README

The metadata block sits at the top of `README.md`, with no extra file.

**Pros**:
- Nothing extra to create, and the metadata sits beside the prose it describes.

**Cons**:
- It mixes data with prose. The badges feature (18) rewrites the same README, so a generator and a contributor edit one file.
- It's harder to validate cleanly, and the frontmatter shows up as clutter when GitHub renders the README.

### Option 4: Derive everything, store nothing

Framework and language come from the path, versions from the lockfile, and the title and summary from the README. There is no manifest at all.

**Pros**:
- Nothing can drift, because there is only one source for each fact.

**Cons**:
- Products, use case, tier, authors, outcomes, and services have no home anywhere else, so a file is needed anyway.
- A recipe copied out of the repo no longer describes itself, which 0001 rejected.

## Decision

**Chosen option**: Option 1: one `recipe.yaml` per recipe, shaped by `schema/recipe.schema.json`, with its allowed values in `schema/taxonomy.yaml` and the official tier confirmed by `.github/official-recipes.txt`.

## Rationale

The file is hand written by strangers in two language lanes, so the deciding forces are ease of writing and loud failure. YAML wins the first: comments, no braces, and one format for Python and TypeScript people alike. The second comes from strictness, not format. Unknown keys are rejected so a typo fails instead of vanishing. Every consumer parses with a YAML 1.2 core schema loader (js-yaml 4 in the JS tooling), which keeps `no`, `yes`, and `on` as plain strings instead of turning them into booleans. Every value the lists use is typed as a string, so what YAML 1.2 still turns into a number (`404`, `1.10`) causes a type error instead of a silent wrong value. The versions in `tested_with` are exact and matched against the lockfile, so the badge's promise is checked.

The allowed values live in a data file, not schema enums, because what consumers need from them is richer than a name. The index needs display labels, the validator needs alias hints (`js` should say "use `typescript`"), and 0001 asked for a disambiguation table for easily confused frameworks. A single `taxonomy.yaml` gives one reviewed place for all of it, and adding a framework is a one line PR. The cost is that schema validation alone does not check membership; feature 6 does both in one command, so contributors still see a single pass or fail. The runner up, generating enums into the schema from the taxonomy (with a staleness check), would restore editor autocomplete on values. It is a reasonable later addition, not a launch need (see Follow-up).

Derived facts are never stored. The recipe ID and the lane come from the path, so they cannot disagree with it. `framework` and `language` are stored even though the path has them, because 0001 requires a copied recipe to describe itself, and the validator rejects any mismatch. The tier is stored for the same reason, but trust comes from the allowlist under `.github/`, where CODEOWNERS can protect it apart from anything a contributor touches.

## Feature design

**Files**:

| Path | Owner | What it holds |
|---|---|---|
| `recipes/<framework>/<language>/<slug>/recipe.yaml` | the recipe's contributor | one manifest per recipe, at the recipe root, exactly that file name |
| `schema/recipe.schema.json` | maintainers | the shape: types, required fields, patterns, the rules that link fields |
| `schema/taxonomy.yaml` | maintainers (reviewed PRs) | the allowed values with labels, aliases, notes |
| `schema/fixtures/valid/*.yaml`, `schema/fixtures/invalid/*.yaml` | maintainers | test cases for the schema, reused by feature 6 |
| `schema/manifest.mjs`, `schema/check.mjs` | maintainers | shared manifest loader and the fixture runner. js-yaml 4 and Ajv are pinned in the root `package.json`, which also runs `tools/validate.mjs` (feature 6) and `tools/build-index.mjs` (feature 7). |
| `.github/official-recipes.txt` | maintainers via CODEOWNERS | the official tier allowlist |

Both recipes have since moved to their 0001 paths (`recipes/sdk/typescript/github-agent/`, `recipes/google-adk/typescript/ops-copilot/`), and the path match rule is enforced by `tools/validate.mjs`.

**Data model sketch** (the `recipe.yaml` fields, in canonical order):

| Field | Type | Required | Constraint |
|---|---|---|---|
| `schema` | integer | yes | `const: 1`. Bumped only on a breaking change. |
| `title` | string | yes | 1 to 80 characters, one line. Equals the README's first `# ` heading. |
| `summary` | string | yes | 1 to 200 characters, one line, one sentence. The index table cell. |
| `framework` | string | yes | kebab case (`^[a-z0-9]+(-[a-z0-9]+)*$`), a `taxonomy.frameworks` key, equals path segment 1 |
| `language` | string | yes | kebab case, a `taxonomy.languages` key, equals path segment 2 |
| `variant` | string | if `language: typescript` | `js` or `ts`. Forbidden for any other language. |
| `tier` | string | yes | `official` or `community`. `official` only together with an allowlist entry. |
| `products` | string list | yes | at least 1, unique, each a `taxonomy.products` key |
| `use_case` | string | yes | exactly one `taxonomy.use_cases` key |
| `tags` | string list | no | at most 10, unique, kebab case, each 2 to 30 characters, free form |
| `demonstrates` | string list | no | unique, each a `taxonomy.outcomes` key |
| `authors` | string list | yes | at least 1, unique (case insensitive uniqueness is feature 6's check), GitHub handles (`^[A-Za-z0-9](?:[A-Za-z0-9]\|-(?=[A-Za-z0-9])){0,38}$`) |
| `tested_with` | map of string to string | if `language` is `python` or `typescript` (optional for `config`) | keys are `taxonomy.packages` keys, which are ArmorIQ packages only (framework and other versions stay in the lockfile). Values are exact versions (`^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`, no ranges). For a recipe whose `products` include `sdk`, it must hold the SDK package for its language. |
| `requires` | object | no | keys: `services`, `external` only |
| `requires.services` | string list | no | unique, each a `taxonomy.services` key |
| `requires.external` | list of `{name, url}` | no | `name` 1 to 60 characters, `url` an `https://` URL. For anything not on the services list. |
| `secondary` | object | no | keys: `frameworks`, `languages` only |
| `secondary.frameworks` | string list | no | unique taxonomy framework keys, never equal to `framework` |
| `secondary.languages` | string list | no | unique taxonomy language keys, never equal to `language` |
| `siblings` | string list | no | unique recipe IDs: three segments joined by `/`, each segment following 0001's naming rule (`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 40 characters). Each must be an existing recipe, never this recipe. |
| `moved_from` | string list | no | unique recipe IDs in the same pattern |
| `status` | string | no | `active` (the default) or `deprecated` |
| `deprecation_note` | string | if `status: deprecated` | 1 to 200 characters: why, and what to use instead. Forbidden otherwise. |

Line 1 of every manifest is the editor hint comment `# yaml-language-server: $schema=<relative path to schema/recipe.schema.json>`. In today's folders that is `../../schema/recipe.schema.json`. At the 0001 path it is `../../../../schema/recipe.schema.json`, and features 5 and 13 update it when they move each recipe. The comment is recommended, not enforced.

Relationships: one recipe has one manifest (1:1). `siblings` links recipes to each other (N:M, by ID). The allowlist names recipes by ID (one file, many IDs). Every taxonomy field links to one taxonomy entry (N:1). No field is derived and stored: the recipe ID and the lane always come from the path.

**Taxonomy shape**: each list is a map keyed by the value itself, so a value appears exactly once and lookups are direct. A label is the official display name of the thing it names. You write the use case descriptions, and they get reviewed in the PR.

```yaml
frameworks:
  google-adk:
    label: Google ADK
    kind: runner            # runner | none | host | platform
    note: Google's Agent Development Kit. Using the Gemini client alone is not ADK.
languages:
  typescript:
    label: TypeScript / JavaScript
    lane: typescript        # python | typescript | config | other
    aliases: [javascript, js, ts, node]
use_cases:
  devtools:
    label: Developer tools
    description: Agents that work on code, repositories, or developer workflows.
packages:
  "@armoriq/sdk":
    label: ArmorIQ SDK (TypeScript)
    ecosystem: npm          # npm | pypi
    language: typescript
```

`products`, `outcomes`, and `services` entries carry `label` only.

**Taxonomy seed** (`schema/taxonomy.yaml`, every entry has a `label`):

- `frameworks` (each with a `kind`: `runner` is a framework that owns the agent loop, `none` means no framework, `host` is a coding agent a plugin runs in, `platform` is a config only recipe on ArmorIQ itself):
  - `sdk` (none), `armoriq` (platform), `claude-code` (host), `codex` (host).
  - `google-adk`, `langchain`, `langgraph`, `crewai`, `openai-agents`, `claude-agent-sdk`, `vercel-ai-sdk`, `ag2`, `pydantic-ai`, `mastra`, `llamaindex`, `strands` (runner).
  - Notes are required on the easily confused ones. `google-adk` is Google's Agent Development Kit, not Gemini client use alone. `langgraph` is separate from `langchain`. `openai-agents` is the OpenAI Agents SDK, not the OpenAI client. `claude-agent-sdk` is Anthropic's agent SDK, not the `claude-code` plugin host. `vercel-ai-sdk` only counts when its agent loop runs the tools. `ag2` covers AutoGen and AG2. `sdk` means the ArmorIQ SDK in a hand written loop.
- `languages` (each with `lane` and `aliases`): `python` (lane `python`, aliases `py`), `typescript` (lane `typescript`, aliases `javascript`, `js`, `ts`, `node`), `config` (lane `config`), `go`, `java`, `rust`, `csharp` (aliases `c#`, `cs`), `cpp` (aliases `c++`). The last five are all lane `other`.
- `products`: `sdk`, `policies`, `approvals`, `mcp-registration`, `armorclaw`, `armorclaude`, `armorcodex`.
- `use_cases` (each with a one line `description`): `devtools`, `support-ops`, `finance`, `data-access`, `coding-agent`, `security-ops`, `research`, `productivity`.
- `outcomes`: `allow`, `hold`, `block`, `delegation`, `prompt-injection`, `audit-log`.
- `services`: `armoriq`, `gemini`, `openai`, `anthropic`, `github`.
- `packages` (each with `ecosystem` and the `language` it serves): `@armoriq/sdk` (npm, typescript). The Python SDK package name goes in once confirmed (see Follow-up).

**Official allowlist** (`.github/official-recipes.txt`): UTF-8 text, one recipe ID per line, no duplicates. Blank lines and lines starting with `#` are ignored. The remaining ID lines are in sorted order (comments may sit anywhere). No other content. The IDs are target IDs, so the tier and allowlist agreement is checked (by feature 6) only once a recipe sits at its 0001 path.

**Example manifests**:

```yaml
# yaml-language-server: $schema=../../schema/recipe.schema.json
# recipes/github-agent/recipe.yaml (target ID sdk/typescript/github-agent)
schema: 1
title: Build a GitHub Agent with the ArmorIQ SDK
summary: A CLI agent that searches, reads, and explores a GitHub repository through the GitHub MCP server, with every tool call checked against policy.
framework: sdk
language: typescript
variant: js
tier: official
products: [sdk, policies, mcp-registration]
use_case: devtools
tags: [github, mcp, cli]
demonstrates: [allow, block]
authors: [Fuzailkazi]
tested_with:
  "@armoriq/sdk": "0.6.10"
requires:
  services: [armoriq, github, gemini]
```

```yaml
# yaml-language-server: $schema=../../schema/recipe.schema.json
# recipes/adk-agent/recipe.yaml (target ID google-adk/typescript/ops-copilot)
schema: 1
title: Build a Google ADK Agent with the ArmorIQ SDK
summary: An internal ops copilot on Google's Agent Development Kit that refunds a charge, holds a larger credit for human approval, and blocks a prompt injected data export.
framework: google-adk
language: typescript
variant: ts
tier: official
products: [sdk, policies, approvals, mcp-registration]
use_case: support-ops
tags: [refunds, mcp, human-approval]
demonstrates: [allow, hold, block, prompt-injection]
authors: [Fuzailkazi]
tested_with:
  "@armoriq/sdk": "0.6.10"
requires:
  services: [armoriq, gemini]
  external:
    - name: armoriq-adk-ops-mcp
      url: https://github.com/Fuzailkazi/armoriq-adk-ops-mcp
```

**State transitions**: a recipe's `status` goes `active` → `deprecated` by a PR that adds a `deprecation_note`. It may return to `active` by removing both. Deleting a recipe is not a status. The tier moves `community` → `official` only through one PR that edits the manifest and the allowlist together, approved by a code owner. Demotion is the same PR in reverse.

**API surface** (the file contract and who reads it; there are no HTTP endpoints):

| Consumer | Reads | Key output | Fails when |
|---|---|---|---|
| Validation check (feature 6) | every `recipe.yaml`, the schema, the taxonomy, the allowlist, lockfiles, README headings | pass, or errors naming file, field, and fix | shape invalid, value not in taxonomy, path mismatch, tier and allowlist disagree, version differs from lockfile, title differs from README |
| Generated index (feature 7) | manifests plus taxonomy labels | tables grouped by language and framework | (relies on feature 6 passing first) |
| Badges and topics (feature 18) | `language`, `variant`, `framework`, `products`, `tier`, `tested_with` | README badges, repo topics | (relies on feature 6) |
| Live checks (feature 12) | the allowlist only, on `main` only | the list of recipes to run live | never reads an incoming PR's manifest |
| Gallery (deferred) | manifests plus taxonomy | filters by every taxonomy field | n/a |

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Write a manifest (AC-4, AC-5) | `title` | the README's first `# ` heading |
| Write a manifest | `summary` | the contributor (it may adapt the README intro) |
| Write a manifest | `framework`, `language` | path segments 1 and 2 under the 0001 runner test (target paths in 0001 for the two existing recipes) |
| Write a manifest | `variant` | the entry point's file extension (`.js`/`.mjs` is `js`, `.ts` is `ts`). The entry point is `package.json` `main`, else the file the README runs first (github-agent: `agent.js`; ops-copilot: `src/index.ts` via `npm run ask`). |
| Write a manifest | `tested_with` versions (AC-7) | the lockfile's resolved version: `package-lock.json` → `packages["node_modules/@armoriq/sdk"].version` for npm; the Python lockfile is set by the recipe kit (feature 3) |
| Write a manifest | `tier` | the contributor's claim, confirmed by `.github/official-recipes.txt` |
| Write a manifest | `authors` | contributors' GitHub handles (`Fuzailkazi` for both existing recipes, from the repo they link to) |
| Write a manifest | `requires.services` | one entry per external account whose credential appears in `.env.example` (github-agent: `ARMORIQ_API_KEY`, `GITHUB_PERSONAL_ACCESS_TOKEN`, `GEMINI_API_KEY`; ops-copilot: `ARMORIQ_API_KEY`, `GEMINI_API_KEY`) |
| Write a manifest | `requires.external` | anything the README makes the reader clone, deploy, or sign up for that is not a taxonomy service (ops-copilot: the `armoriq-adk-ops-mcp` repo) |
| Write a manifest | `demonstrates` | only outcomes that the README's demo output shows (github-agent: allowed steps, plus `[BLOCKED] delete_repository` in its README; ops-copilot: ALLOWED, HELD, and BLOCKED, including the injected export) |
| Validate (AC-6) | recipe ID, lane | derived from the path, and the lane from `taxonomy.languages.<language>.lane`, never stored |
| Index / badges | display labels | `taxonomy.yaml` `label` fields |
| Validator alias hints | "use `typescript`" style messages | `taxonomy.languages.*.aliases` |

**Key invariants**:
- One manifest per recipe, named exactly `recipe.yaml`, at the recipe root, holding one YAML document whose top level is a mapping.
- No unknown keys at any level.
- Manifests are parsed with a YAML 1.2 core schema loader (js-yaml 4 in JS tooling; any Python tooling must use a 1.2 loader too, not PyYAML's 1.1 default), so `no` and `yes` stay strings.
- Every value the taxonomy constrains is a string, so a bare number is a type error, never a silent value. Versions in `tested_with` must be quoted strings.
- `variant` exists if and only if `language` is `typescript`. `deprecation_note` exists if and only if `status` is `deprecated`.
- `tier: official` if and only if the recipe ID is on the allowlist.
- `tested_with` versions equal the lockfile's resolved versions.
- The recipe ID and lane are never stored in the manifest.
- A new taxonomy value is added to `taxonomy.yaml` in the same PR that first uses it (0001's rule, extended to every list).

**Schema versus validator**: the JSON Schema enforces only rules inside one file: types, lengths, patterns, list uniqueness, unknown keys, and the linked rules (`variant` by language, `deprecation_note` by status, `tested_with` required by language). Everything else is feature 6's check: taxonomy membership and alias hints, path agreement, tier and allowlist agreement, lockfile versions, README title, `tested_with` holding the right SDK package, sibling IDs existing, `secondary` never repeating the primary, and `authors` unique ignoring case.

**Security model**: manifests are contributor editable and untrusted. Nothing executes from them, and no consumer treats a manifest field as permission. `.github/official-recipes.txt` is the only trust bearing file, protected by CODEOWNERS (feature 11, or feature 12 if that comes first). The live job reads it from `main` only. Manifests hold GitHub handles only, never emails or other personal data. `requires.external` URLs are shown as links only, never fetched by CI.

**Configuration required**: none. No new env vars or credentials.

**Critical test scenarios**:
- Happy path: the github-agent manifest validates and its taxonomy values all resolve, verifies **AC-4**, **AC-7**, **AC-8**
- Failure case: a misspelled key (`framwork`) fails with an error naming `framwork`, verifies **AC-6**
- Failure case: `use_case: 404` (a bare number) fails as a type error naming `use_case`, verifies **AC-6**
- Failure case: `tested_with: {"@armoriq/sdk": "^0.6.10"}` fails the exact version pattern, verifies **AC-6**
- Auth/permission: the allowlist exists and names both official recipes, so a manifest claiming `official` without an entry can be caught by feature 6, verifies **AC-3**

## Build plan

Ordered as a tracer bullet: the GitHub agent goes through the whole contract first, then the rest of the contract fills in around it.

1. Write `schema/taxonomy.yaml` with the seed values, labels, kinds, notes, lanes, and aliases. Satisfies **AC-2**.
2. Write `schema/recipe.schema.json` (draft 2020-12): every field, the patterns, `additionalProperties: false` everywhere, the linked rules (`variant`, `deprecation_note`, `tested_with` required by language) through `if`/`then`/`dependentRequired`, and a `description` on every property. Satisfies **AC-1**.
3. Write `schema/check.mjs` using js-yaml 4 and Ajv (draft 2020-12 build), pinned in the root `package.json`. It validates every fixture and, when given file paths as arguments, those files. Satisfies **AC-6**.
4. Write `recipes/github-agent/recipe.yaml` from *Example manifests* and run `node schema/check.mjs recipes/github-agent/recipe.yaml`. Check its taxonomy values, its version against `package-lock.json`, and its title against the README by hand (feature 6 automates these). Satisfies **AC-4**, **AC-7**, **AC-8**.
5. Add `schema/fixtures/valid/` (copies of both example manifests plus one `config` lane manifest with no `tested_with`) and `schema/fixtures/invalid/` (one file per case in AC-6, each a valid manifest with one change, named after the case, for example `unknown-key.yaml`). Run `node schema/check.mjs`. Satisfies **AC-6**.
6. Write `.github/official-recipes.txt` with both target IDs. Satisfies **AC-3**.
7. Write `recipes/adk-agent/recipe.yaml` from *Example manifests* and check it the same way as step 4. Satisfies **AC-5**, **AC-7**, **AC-8**.

## Consequences

**Positive**:
- Every consumer reads one checked description per recipe, so the index, badges, and live checks agree.
- Mistakes are loud: typos, coerced YAML values, version ranges, and missing required fields all fail.
- Adding a framework, product, or use case is a one line, reviewed change in one file.
- The "tested with" badge is checked against the lockfile, so it is true.

**Negative / tradeoffs**:
- Plain schema validation does not check taxonomy membership. Until feature 6 lands, that check is manual, and editors autocomplete field names but not values.
- `title` and `tested_with` repeat facts held elsewhere (the README, the lockfile). That is deliberate for copied recipes, but it is drift the validator has to police.
- Exact versions mean every SDK bump touches the manifest as well as the lockfile.
- One controlled `use_case` forces a judgment call for recipes that span two areas. Tags carry the rest.
- Strict rejection of unknown keys means even an optional new field needs a schema PR first.

**Neutral**:
- The two existing recipes get manifests in their current folders now. Features 5 and 13 move them, and the manifests move along.
- `schema/` becomes a root folder, alongside the tooling folders 0001 left to features 6 and 7.
- The schema version starts at `1`. A breaking change means a new version that the validator accepts side by side during migration.

## Follow-up

- [ ] Confirm the Python SDK's PyPI package name and add it to `taxonomy.packages`. This blocks features 14 to 16: a Python recipe cannot validate until it lands.
- [ ] Feature 18 (badges): decide what the version badge shows when `tested_with` is absent (config recipes).
- [ ] Feature 3 (recipe kit): name the required lockfile per lane, so `tested_with` has a defined source in Python, and put a `recipe.yaml` with the editor hint comment in each template.
- [ ] Feature 6 (validation check): enforce everything under *Schema versus validator* on top of 0001's invariants, parsing with a YAML 1.2 loader and one document per file. Reuse `schema/fixtures/` and `schema/check.mjs`.
- [ ] Feature 7 and feature 18: read labels from `taxonomy.yaml`, never hardcode them.
- [ ] Feature 11 or 12: add `.github/official-recipes.txt` and `schema/` to CODEOWNERS.
- [ ] Later: consider generating value enums into the schema from `taxonomy.yaml` (with a staleness check), so editors autocomplete values.
- [ ] At public launch: consider pointing the editor hint at the schema's public raw URL, so copied recipes keep their hints.
- [ ] Root `AGENTS.md` (feature 4): one line on `recipe.yaml` with a link to this spec.
