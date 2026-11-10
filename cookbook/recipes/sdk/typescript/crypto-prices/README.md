# Build a Crypto Prices Agent with the ArmorIQ SDK

A step by step guide to a crypto prices assistant you can ask open ended questions, such as "what's SOL worth in EUR" or "how's Bitcoin doing today". Gemini plans the tool calls, a self built CoinGecko MCP server answers them, and ArmorIQ checks every call.

Adapted from the [coingecko-crypto-agent demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/coingecko-crypto-agent) by Naveen-6087.

## What you'll build

```
goal → Gemini picks tool call(s) → ArmorIQ checks each one → execute against a self built CoinGecko MCP server → answer
```

Crypto market data is read only public information. Nothing here is destructive, so the policy allows every tool outright instead of splitting tools into allow, hold, and block. The interesting part of this recipe is the planner. It is a real LLM call instead of keyword matching, so the agent can answer whatever you ask, not just a few fixed phrases.

## Run it offline

See the whole loop before you create any account. Offline mode runs the real `demo.js` with local stand-ins for ArmorIQ, CoinGecko, and the planner (in `offline/`). It needs no keys and no network.

```bash
npm install
npm run demo:offline    # ask about Solana in EUR: search_coin, then get_price
npm run test:offline    # the same run, scripted, as a pass or fail check
```

The offline ArmorIQ stand-in reads this recipe's `policy.yaml`: it looks for a rule by tool name, then falls back to `default_action`. Change a rule in that file and the offline result changes with it. Offline runs print `[armoriq] ...` lines for the plan, each check, and each report.

## Before you start

| Requirement | Why |
|---|---|
| Node.js v18 or later, and npm | Runs the agent |
| An ArmorIQ account | Policy enforcement and observability |
| A Gemini API key | Plans tool calls from natural language goals |
| A CoinGecko API key (optional) | Free Demo tier. Keyless access also works, just slower |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com).
2. Click **Create API key** and copy it.

Without a Gemini key the agent falls back to a keyword planner in `src/planner.js` that only answers Bitcoin questions.

## Step 3: Get a CoinGecko API key (optional)

1. Go to [coingecko.com/en/api/pricing](https://www.coingecko.com/en/api/pricing).
2. Register for the free **Demo** plan (30 calls a minute) and copy your key.

Keyless access works too, capped at 5 calls a minute. If you skip this step, leave `COINGECKO_API_KEY` blank in Step 6.

## Step 4: Register a CoinGecko MCP server with ArmorIQ

1. In the ArmorIQ console, open **MCP Servers**.
2. Click **Add MCP Server**.
3. Name it `coingecko`.
4. Save.

This is a custom entry. `coingecko` is not one of ArmorIQ's built in catalog listings the way `filesystem` and `github` are, because this recipe builds its own small MCP server (`coingecko-mcp-server.js`) instead of using a published one.

### Why `mode: "sdk"`

The CoinGecko MCP server uses stdio transport, the way every MCP host runs a local server. ArmorIQ's cloud proxy has no network path to a stdio process on your machine, so `mode: "proxy"` would fail with a 502. In `mode: "sdk"` ArmorIQ only makes the allow, hold, or block decision, and this process spawns the server and runs each approved call itself.

## Step 5: Write your first policy

1. In the console, open **Policies → Policy Studio → Single Policy**.
2. Set **Target Type** to `mcp_server` and **Target ID** to the `coingecko` server you just registered.
3. Set **Default enforcement action** to `block`.
4. Paste the contents of `policy.yaml` into the YAML editor:

```yaml
name: coingecko-policy
version: v0.1.0
scope:
  target_type: mcp
  target: coingecko   # replace with your registered coingecko MCP server's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: search_coin
    action: allow
  - tool: get_price
    action: allow
  - tool: get_market_data
    action: allow
```

5. Save and activate.

## Step 6: Configure the project

```bash
cp .env.example .env     # fill in ARMORIQ_API_KEY, GEMINI_API_KEY, and optionally COINGECKO_API_KEY
npm install
```

`COINGECKO_MCP_NAME` must match the name you registered in Step 4.

## Step 7: The pieces

- `coingecko-mcp-server.js` is the MCP server. It has three read only tools over CoinGecko's public API: `search_coin`, `get_price`, and `get_market_data`. It is deliberately not a generic "call any endpoint" tool, so the policy stays easy to read.
- `src/mcpClient.js` spawns that server over stdio and calls its tools.
- `src/planner.js` asks Gemini to turn a goal into a JSON list of tool calls. When the model does not know a coin's CoinGecko id, it starts with `search_coin` and chains a price lookup.
- `demo.js` is the agent loop: plan, check, execute, report.

Every step follows the same four moves:

```javascript
const toolCalls = await planWithLlm(goal);
const token = await session.startPlan(toolCalls, goal);

for (const call of toolCalls) {
  const decision = await session.check(call.name, call.args, userEmail);
  if (!decision.allowed) continue;                       // held or blocked: do not run it
  const result = await callTool(cgClient, actionFromToolName(call.name), call.args);
  await session.report(call.name, call.args, result, { status: "success" });
}
```

`src/index.js` serves the same loop over HTTP (`npm start`, then `POST /agent {"goal": "..."}`).

## Step 8: Run it

```bash
npm run demo "how's Solana doing today, in EUR?"
```

Sample output once the policy is active:

```
Plan: coingecko__search_coin -> coingecko__get_price

STATUS     : [ALLOWED] BY ARMORIQ POLICY
Result     : [{"id":"solana","name":"Solana","symbol":"SOL","market_cap_rank":7}]

STATUS     : [ALLOWED] BY ARMORIQ POLICY
Result     : {"solana":{"eur":142.31,"eur_market_cap":78331902841,"eur_24h_change":-1.2}}
```

Gemini chose to resolve the coin id first and then chain the price lookup. It was not told to use two steps for this question. It inferred that from the tool descriptions. Other goals to try: "what's the market cap of Ethereum", "search for Dogecoin", "compare Bitcoin and Solana's 24h change".

## Step 9: See it in the ArmorIQ dashboard

Open **Intent** in the console, filtered by your `USER_EMAIL`. Each run shows both tool calls the model chose, in order, each checked and audited on its own even though they came from one goal and one Gemini call.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Gemini call fails with "Unexpected end of JSON input" | The Gemini API returned an error body (for example a 503 for high demand) instead of candidates. Log the raw response before parsing to see the real error |
| A specific Gemini model id returns 404 | Some dated model ids are deprecated for new API keys. Use `gemini-flash-lite-latest` or another `-latest` alias |
| Everything gets blocked | Default policy is `block` with no matching rule. Confirm the Step 5 policy is saved and activated, and that its `target` matches the registered server's id |
| `mode: "proxy"` returns a 502 | The CoinGecko MCP server uses stdio transport and the cloud proxy cannot reach it. Use `mode: "sdk"` |
| CoinGecko returns `429` | Rate limit exceeded. Keyless is capped at 5 calls a minute and Demo at 30 |

## What's next

- Try the CrewAI crypto recipe for a multi agent take on the same CoinGecko data.
- Add more tools. CoinGecko's API covers exchanges, NFTs, DeFi, and on chain data. `coingecko-mcp-server.js` wraps only three endpoints, and the pattern extends to any of them.
