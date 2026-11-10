# Build a Memory Knowledge Agent with the ArmorIQ SDK

A "remember this" and "what do you know about X" assistant backed by a `memory` MCP server (a knowledge graph), with ArmorIQ protecting the agent's long term memory from unattended writes and wipes.

Ported from the [`memory-knowledge-agent` demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/memory-knowledge-agent) by Naveen-6087.

## What it demonstrates

- Tiered policy on a single MCP server. Reads (`search_nodes`, `open_nodes`, `read_graph`) are allowed. New facts (`create_entities`, `create_relations`, `add_observations`) are held for human review before they are trusted. Destructive calls (`delete_entities`, `delete_relations`, `delete_observations`) are blocked outright.
- The "malicious prompt tries to wipe agent memory" scenario from the ArmorIQ SDK docs. `demo.js` includes a `delete_entities` step on purpose, to show it getting stopped.

## Run it offline

No account, no keys, no network, and no MCP server process:

```bash
npm install
npm run demo:offline    # the real demo.js against local stand-ins
npm run test:offline    # the same run, scripted, as a pass or fail check
```

Offline mode swaps `@armoriq/sdk` and `src/mcpClient.js` for stand-ins in `offline/`. `demo.js` itself runs unchanged. The stand-in ArmorIQ reads this recipe's `policy.yaml`: a rule that names the tool wins, and anything else gets `default_action`. Change a rule in `policy.yaml` and the offline result changes with it.

The run tries to store a fact about Isha (held), searches memory (allowed), and then tries to delete the entity (blocked). The held write is never executed, so the search finds nothing, which is what the live agent would see too:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline    # the hold prints REJECTED instead of APPROVED
```

## Why `mode: "sdk"` and not `"proxy"`

The `memory` MCP server registered on the ArmorIQ dashboard uses the stdio transport. It runs as a local subprocess, the way every MCP host normally runs it. ArmorIQ's cloud proxy has no network path to a stdio process on your machine, so `session.dispatch()`, which routes the tool call through the proxy, returns a 502 against it. The original author confirmed this by running it.

`mode: "sdk"` asks ArmorIQ only for the allow, hold, or block decision. `src/mcpClient.js` spawns the real MCP server locally, and this agent executes the approved call itself. The dashboard registration still matters for policy scope, vulnerability scans, and audit metadata. It just does not decide who runs the process.

## Prerequisites (live run)

1. A `memory` MCP server registered on your ArmorIQ dashboard (Platform, then MCP Servers). This agent spawns the actual `@modelcontextprotocol/server-memory` process itself (see `src/mcpClient.js`).
2. An ArmorIQ API key, from `armoriq login` in the SDK's bundled CLI or from the dashboard.
3. The `memory-knowledge-policy` created against that server. Open **Platform, Policies, Policy Studio, Single Policy**, set Target Type `mcp_server` and Target ID to your registered memory server's id, paste the rules from `policy.yaml` into the YAML editor, and save. The `armoriq policy propose` CLI command stages a different, org wide policy, the one that governs coding agent products like ArmorClaude and ArmorCodex. It does not set per server policies like this one.

## Run it live

```bash
cp .env.example .env      # fill in ARMORIQ_API_KEY
npm install
npm run demo               # scripted CLI walkthrough
# or
npm start                  # POST http://localhost:3002/agent {"goal": "remember that ..."}
```

## Try different goals

The planner (`src/planner.js`) recognizes `"remember that ..."`, `"forget ..."` or `"wipe ..."`, and `"what do you know about ..."` or `"recall"`. Anything else falls back to a full graph read. It calls Gemini when `GEMINI_API_KEY` is set and falls back to keyword matching when it is not. The enforcement loop in `src/index.js` does not change either way.
