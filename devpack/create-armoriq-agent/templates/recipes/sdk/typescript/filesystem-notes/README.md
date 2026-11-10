# Build a Filesystem Notes Agent with the ArmorIQ SDK

A natural language notes assistant that talks to a `filesystem` MCP server, with every tool call gated by an ArmorIQ intent plan and policy. Reads go through. Writes wait for a human.

Ported from the [`filesystem-notes-agent` demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/filesystem-notes-agent) by Naveen-6087.

## What it demonstrates

- Path scoped tool policy. Reads (`read_file`, `list_directory`, `search_files`, and the rest) are allowed automatically. Writes (`write_file`, `edit_file`, `move_file`, `create_directory`) are held for human approval.
- The full ArmorIQ lifecycle: `startPlan` mints a signed intent token for the whole multi step plan, `check` evaluates policy for each tool call (`mode: "sdk"`), this agent runs the allowed call itself against a locally spawned MCP server, `report` logs the result, then `flushObservability` and `completePlan` close things out.

## Run it offline

No account, no keys, no network, and no MCP server process:

```bash
npm install
npm run demo:offline    # the real demo.js against local stand-ins
npm run test:offline    # the same run, scripted, as a pass or fail check
```

Offline mode swaps `@armoriq/sdk` and `src/mcpClient.js` for stand-ins in `offline/`. `demo.js` itself runs unchanged. The stand-in ArmorIQ reads this recipe's `policy.yaml`: a rule that names the tool wins, and anything else gets `default_action`. Change a rule in `policy.yaml` and the offline result changes with it.

The run lists the notes folder (allowed), then tries to write a note and move it (both held). Every decision prints one `[armoriq]` line. A held call is resolved on the spot, and the agent never executes it either way:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline    # every hold prints REJECTED instead of APPROVED
```

## Why `mode: "sdk"` and not `"proxy"`

The `filesystem` MCP server registered on the ArmorIQ dashboard uses the stdio transport. It runs as a local subprocess, the way every MCP host normally runs it. ArmorIQ's cloud proxy has no network path to a stdio process on your machine, so `session.dispatch()`, which routes the tool call through the proxy, returns a 502 against it. The original author confirmed this by running it.

`mode: "sdk"` asks ArmorIQ only for the allow, hold, or block decision. `src/mcpClient.js` spawns the real MCP server locally, and this agent executes the approved call itself. The dashboard registration still matters for policy scope, vulnerability scans, and audit metadata. It just does not decide who runs the process.

## Prerequisites (live run)

1. A `filesystem` MCP server registered on your ArmorIQ dashboard (Platform, then MCP Servers). This agent spawns the actual `@modelcontextprotocol/server-filesystem` process itself (see `src/mcpClient.js`), pointed at `NOTES_DIR`.
2. An ArmorIQ API key, from `armoriq login` in the SDK's bundled CLI or from the dashboard.
3. The `filesystem-notes-policy` created against that server. Open **Platform, Policies, Policy Studio, Single Policy**, set Target Type `mcp_server` and Target ID to your registered filesystem server's id, paste the rules from `policy.yaml` into the YAML editor, and save. The `armoriq policy propose` CLI command stages a different, org wide policy, the one that governs coding agent products like ArmorClaude and ArmorCodex. It does not set per server policies like this one.

## Run it live

```bash
cp .env.example .env      # fill in ARMORIQ_API_KEY
npm install
mkdir -p notes/archive
npm run demo               # scripted CLI walkthrough
# or
npm start                  # POST http://localhost:3001/agent {"goal": "write a note"}
```

## Try different goals

The planner (`src/planner.js`) recognizes `"write a note"`, `"archive my notes"`, and `"search my notes"`. Anything else falls back to a read only listing. It calls Gemini when `GEMINI_API_KEY` is set and falls back to keyword matching when it is not. The enforcement loop in `src/index.js` does not change either way.
