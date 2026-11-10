# Build a Cross-MCP Research Agent with the ArmorIQ SDK

One agent, one signed ArmorIQ intent plan, spanning two different MCP servers: `filesystem` to read a source document, and `memory` to store and recall a summary in the knowledge graph.

Ported from the [`cross-mcp-research-agent` demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/cross-mcp-research-agent) by Naveen-6087.

## What it demonstrates

A single MCP agent cannot show these:

- **One plan, multiple targets.** `session.startPlan()` is called once, with steps named `filesystem__read_file`, `memory__create_entities`, and `memory__search_nodes`. The SDK's `<mcp>__<action>` convention routes each step to the right registered MCP server from a single signed intent token.
- **Policy per server.** Each step is still checked against the policy scoped to its own MCP server. The filesystem read is allowed by the filesystem policy, and the memory write is held by the memory policy. It is all one auditable plan, not three disconnected sessions.
- The same `startPlan`, `check`, execute, `report`, `flushObservability`, `completePlan` lifecycle as the single server recipes, routed to whichever of the two locally spawned MCP servers each step targets.

## Run it offline

No account, no keys, no network, and no MCP server processes:

```bash
npm install
npm run demo:offline    # the real demo.js against local stand-ins
npm run test:offline    # the same run, scripted, as a pass or fail check
```

Offline mode swaps `@armoriq/sdk` and `src/mcpClient.js` for stand-ins in `offline/`. `demo.js` itself runs unchanged. This recipe ships two policy files, `policy.filesystem.yaml` and `policy.memory.yaml`. The stand-in ArmorIQ picks the policy by the `<mcp>__` prefix of each step, then applies the rule for the tool, or `default_action` when no rule names it. Change a rule in either file and the offline result changes with it.

The run reads the source file (allowed by the filesystem policy), stores a summary (held by the memory policy), and recalls it (allowed by the memory policy). The held write is never executed, so the recall comes back empty, which is what the live agent would see too:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline    # the hold prints REJECTED instead of APPROVED
```

## Why `mode: "sdk"` and not `"proxy"`

Both registered MCP servers use the stdio transport. They run as local subprocesses, the way every MCP host normally runs them. ArmorIQ's cloud proxy has no network path to a stdio process on your machine, so `session.dispatch()`, which routes the tool call through the proxy, returns a 502 against them. The original author confirmed this by running it.

`mode: "sdk"` asks ArmorIQ only for the allow, hold, or block decision for each step, whichever MCP it targets. `src/mcpClient.js` spawns both real MCP servers locally and routes each approved call to the one that owns it. The dashboard registrations still matter for policy scope, vulnerability scans, and audit metadata. They just do not decide who runs the process.

## Prerequisites (live run)

1. Both the `filesystem` and `memory` MCP servers registered on your ArmorIQ dashboard (Platform, then MCP Servers). This agent spawns both server processes itself (see `src/mcpClient.js`).
2. An ArmorIQ API key, from `armoriq login` in the SDK's bundled CLI or from the dashboard.
3. Both policies created against their servers in **Platform, Policies, Policy Studio**: `policy.filesystem.yaml` for the filesystem server and `policy.memory.yaml` for the memory server. Policy scope is per MCP server, not per agent, so this recipe reuses the two policies from the filesystem and memory recipes instead of defining a third.

## Run it live

```bash
cp .env.example .env      # fill in ARMORIQ_API_KEY
npm install
mkdir -p research && echo "# Notes on ArmorIQ" > research/source.md
npm run demo               # scripted CLI walkthrough
# or
npm start                  # POST http://localhost:3003/agent {"goal": "research the source file"}
```

## Try different goals

The planner (`src/planner.js`) treats `"research ..."`, `"summarize ..."`, and `"read ..."` as the full read, store, recall plan. Anything else lists the research directory and reads the full memory graph.
