# 0004. Restyle the local recipe browser in the ArmorIQ V5 design system

**Date**: 2026-10-31
**Status**: Proposed

## Summary

`npm run serve` opens a local recipe browser (`tools/server.mjs`). Today it is one 640 line file with a generic slate and blue Tailwind page inlined as a string, and it hardcodes how to run each recipe. This spec moves the page into its own static files, rebuilds every surface in ArmorIQ V5 (the `aq-*` tokens, Geist type, orange as punctuation, light and dark), and adds a run viewer that turns the offline log contract (spec [0003](0003-aiq-demos-recipes.md)) into a timeline of allowed, held, and blocked calls. The server runs any recipe by convention, so new recipes need no server change.

## Requirements

**User stories**:
- As a reader, I want to browse and filter recipes by language, framework, outcome, and tier so that I find the one that fits.
- As a reader, I want to run a recipe offline and see each call as allowed, held, or blocked so that the policy story is obvious without reading logs.
- As ArmorIQ, I want the browser to look like it already belongs to the ArmorIQ platform.

**Acceptance criteria**:
- **AC-1**: The page lives in `tools/browser/` (`index.html`, `app.js`, `styles.css`, `tokens.css`, `fonts/`, `armormark.svg`). `server.mjs` serves these files and keeps only API routes; no HTML string remains in `server.mjs`.
- **AC-2**: `tokens.css` is a verbatim copy of `/Users/fu2ail/armor/design/design-system/styles/tokens.css` with a one line header naming its source. Fonts (Geist, Geist Mono) are copied from `design-system/assets/fonts/` and loaded with `@font-face`; `armormark.svg` from `design-system/assets/logos/`.
- **AC-3**: Token discipline: no hex, rgb, or hsl color literal and no raw pixel font size anywhere in `styles.css`, `index.html`, or `app.js`. Colors use `var(--color-aq-*)`, type sizes `var(--text-aq-*)`, radii `var(--radius-aq-*)` or the small fixed radii already used by the primitives, motion `var(--duration-aq-*)` and `var(--ease-aq-*)`. A grep for `#[0-9a-fA-F]{3,8}\b` in those three files returns nothing.
- **AC-4**: No Tailwind CDN. The markdown renderer (`marked`) may stay on its CDN.
- **AC-5**: Light theme by default from `prefers-color-scheme`; a header toggle switches `html[data-theme="dark"]`, persisted in `localStorage`.
- **AC-6**: Rail: a search field filters by title, summary, and tags; filter chips for Language, Framework, Outcome (from `demonstrates`), and Tier, combinable; each recipe is a list row with title, meta line (framework label, language label), and a tier chip. Counts update as filters change. Empty result shows a page state ("No recipes match").
- **AC-7**: Recipe view: header with title, summary, product chips, and one status badge per outcome (allow good, hold warn, block bad, prompt injection bad, delegation info, multi server info, audit log neutral). Tabs: Overview (README), Files (tree plus mono code view), Policy, Run.
- **AC-8**: Policy tab parses the recipe's `policy*.yaml` file(s) (server side via the existing js-yaml dependency, new route `GET /api/policy/<id>`) and shows each as a table: tool, action badge, plus `default_action`. Recipes with no policy file show a page state.
- **AC-9**: Run tab: one accent button "Run offline" (the only orange CTA on the view), a segmented control Approve / Reject that sets `OFFLINE_APPROVAL`, a stat strip (Allowed, Held, Blocked counts, live), and a timeline built from the log contract lines: plan row, then one row per `check` with a status badge, held calls rendered as an approval card (tool, MCP prefix if any, args from the `args` line, verdict ledger line from the matching `hold` line), blocked rows with their reason. The raw log sits below in a collapsible section, closed by default. A nonzero exit shows a bad toned banner with the exit code.
- **AC-10**: `server.mjs` runs recipes by convention: TypeScript lane `npm run -s demo:browser` if that script exists, else `demo:offline`; Python lane `.venv/bin/python offline/demo.py` (or the Windows path), with a warn banner telling the reader to run `npm run check:recipes <id>` if `.venv` is missing. No recipe id appears in `server.mjs`. Both pass `OFFLINE_APPROVAL`.
- **AC-11**: Header: armormark plus "ArmorIQ Cookbook", a checks status badge, and a secondary "Run checks" button that calls `/api/check` (status badge shows running with shimmer, then pass or fail).
- **AC-12**: Keyboard and a11y: every control reachable by Tab with the token focus ring; status shown as color plus label plus icon, never color alone; motion wrapped in `@media (prefers-reduced-motion: no-preference)`.
- **AC-13**: `/api/file/` resolves the path and rejects anything outside the recipe dir using `path.relative` (no `..` prefix, not absolute), replacing the current `startsWith` check.
- **AC-14**: All 11 recipes run from the browser and show their timeline, checked by hand in a real browser in both themes.

## Decision

Plain HTML, CSS, and a small vanilla `app.js` (no framework, no build step), because this is repo tooling with zero dependencies beyond the root `package.json`. The design system's React primitives are mirrored as CSS classes with the same names and the same props as modifiers, so the shapes match `@shared/ui` exactly:

| Primitive (components.json) | CSS class | Used for |
|---|---|---|
| Button (primary, secondary, ghost) | `.aq-button`, `--primary`, `--secondary`, `--ghost` | Run offline, Run checks, theme toggle |
| SearchField | `.aq-search` | rail filter |
| Chip (tone, selected, size) | `.aq-chip`, `--good/--warn/--bad/--info/--accent`, `[aria-pressed="true"]` | filters, products, tier |
| StatusBadge (tone, icon, shimmer) | `.aq-status`, tone modifiers, `--shimmer` | outcomes, check status, timeline |
| ListRow (cozy, compact) | `.aq-row` | rail items, timeline rows |
| SectionHeader | `.aq-section-header` | rail groups, tab sections |
| Tabs | `.aq-tabs` with a 2px accent underline | recipe tabs |
| SegmentedControl | `.aq-segmented` | Approve / Reject |
| Banner | `.aq-banner` tone modifiers | run errors, missing venv |
| IapCard | `.aq-iap` | held calls in the timeline |
| Collapsible | `details.aq-collapsible` | raw log |
| PageState | `.aq-page-state` | empty and no policy states |
| StatStrip (section) | `.aq-stats` | Allowed / Held / Blocked counts |

Read `components.json` `variantClasses` and `tokens` for each primitive above and mirror the exact token choices (backgrounds, borders, ink levels, radii, text sizes). Orange (`--color-aq-accent`) appears only on the primary button, the active tab underline, and focus; selection uses `--color-aq-accent-soft` (grey wash), per the design system rules. Body text `--text-aq-base` (14px), dense layout, `--color-aq-bg` page, `--color-aq-surface` panels, hairline `--color-aq-border`.

Icons: inline SVG paths copied from `design-system/primitives/icons` for the handful needed (search, check, clock or pause for held, block, play, sun, moon, chevron, file, folder, shield).

**Implementation skills**: `armoriq-design-system` (tokens, components.json), `transitions-dev` for the few transitions (tab underline, collapsible, badge swap).

## Layout

```
┌ header: [mark] ArmorIQ Cookbook ·········· [● All checks passing] [Run checks] [☾] ┐
├ rail (320) ────────────┬ main ─────────────────────────────────────────────────────┤
│ [search            ]   │ Title                                                    │
│ Language  ○TS ○Py      │ Summary line                                             │
│ Framework ○SDK ○…      │ [SDK][Policies][Approvals]  [✓ Allowed][⏸ Held][⊘ Blocked]│
│ Outcome   ○Held ○…     │ Overview  Files  Policy  Run                              │
│ Tier      ○official …  │ ───────────────────────────────────────────────────────── │
│ 11 recipes             │ Run tab:                                                  │
│ ▸ Filesystem notes     │ [▶ Run offline]  (Approve | Reject)    Allowed 3 Held 1 …  │
│   SDK · TypeScript  [c]│ ● plan: … -> list_directory, write_file, move_file        │
│ ▸ …                    │ ✓ list_directory          Allowed  policy … -> allow      │
│                        │ ┌ Held: write_file  filesystem ────────────────────────┐ │
│                        │ │ path  notes/meeting-notes.md                          │ │
│                        │ │ Approved (offline)                                    │ │
│                        │ └───────────────────────────────────────────────────────┘ │
│                        │ ▸ Raw log                                                 │
└────────────────────────┴───────────────────────────────────────────────────────────┘
```

## Build plan

1. Copy `tokens.css`, fonts, and the mark into `tools/browser/`; write `styles.css` with the primitive classes; static `index.html` shell.
2. Move the client logic into `app.js` (recipes list, filters, recipe view, tabs, files, overview) and point `server.mjs` at the static files; delete the inline HTML.
3. Policy route and Policy tab.
4. Convention based run in `server.mjs`, log contract parser and timeline, stat strip, approve or reject, raw log.
5. Theme toggle, a11y pass, path check fix, then run all 11 recipes in a real browser in both themes and screenshot each tab once.

## Consequences

- `tokens.css` is a copy; when the design system changes, recopy it (noted in its header line).
- The browser depends on the log contract. A recipe that prints differently still runs; it just shows only the raw log and zero counts.

## Follow-up

- If the static gallery site (deferred in scope) is built later, it can reuse `tools/browser/styles.css` as its base.

## Rationale

The user asked that the entire browser follow the ArmorIQ design system. Mirroring primitives as CSS classes (rather than pulling React and the app's build into this repo) keeps the tooling dependency free while keeping the shapes identical to `@shared/ui`. Moving the HTML out of a JS string makes token discipline checkable with a grep.
