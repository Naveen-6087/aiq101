# Build a LangChain Agent with the ArmorIQ SDK

A step by step guide to dropping ArmorIQ into a real LangChain tool calling agent with the SDK's shipped `ArmorIQLangChain` integration, not a hand rolled enforcement loop. Every tool call the model chooses goes through ArmorIQ's plan, token, policy, and audit pipeline via one extra callback passed at invocation time.

Adapted from the [langchain-tool-agent demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/langchain-tool-agent) by Naveen-6087.

## What you'll build

A weather assistant. Ask it what the weather is like somewhere, and it searches for the place, then fetches current conditions for the coordinates it gets back. That is two sequential tool calls chosen by the model itself, each checked by ArmorIQ before it runs.

```
goal → model picks a tool call → ArmorIQ checks it → execute → result fed back to model → repeat until done
```

The agent, the tools, and the prompt are all plain LangChain. ArmorIQ is one extra callback.

## Run it offline

See the whole loop before you create any account. Offline mode runs the real `agent.js`, the real `createAgent`, and the real `ArmorIQLangChain` callback handler. Three things are local stand-ins (in `offline/`): the ArmorIQ client, a scripted tool calling chat model in place of Gemini, and canned weather data in place of `weather-mcp`. It needs no keys and no network.

```bash
npm install
npm run demo:offline    # the scripted model searches for Bengaluru, then fetches its conditions
npm run test:offline    # the same run as a pass or fail check
```

The offline ArmorIQ stand-in reads this recipe's `policy.yaml`: it looks for a rule by tool name, then falls back to `default_action`. Change a rule in that file and the offline result changes with it. For example, set `get_current_conditions` to `block`, and the handler stops that tool and the agent explains that it could not finish.

## Before you start

| Requirement | Why |
|---|---|
| Node.js v18 or later, and npm | Runs the agent |
| An ArmorIQ account | Policy enforcement and observability |
| A Gemini API key | Drives the LangChain agent's model calls |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com).
2. Click **Create API key** and copy it.

Only the model construction in `agent.js` is Gemini specific. Swap in `ChatOpenAI` from `@langchain/openai`, `ChatAnthropic` from `@langchain/anthropic`, or any other `@langchain/core` chat model, and everything else (the tools, `ArmorIQLangChain`, the agent) is unchanged.

## Step 3: Register a weather MCP server with ArmorIQ

1. In the ArmorIQ console, open **MCP Servers**.
2. Click **Add MCP Server**.
3. Name it `weather`.
4. Save.

This recipe uses [`weather-mcp`](https://github.com/weather-mcp/weather-mcp), a published MCP server with no API key (17 tools over NOAA and Open-Meteo). Nothing to sign up for beyond the ArmorIQ and Gemini keys.

### Why `mode: "sdk"`

`weather-mcp` uses stdio transport, the way every MCP host runs it. ArmorIQ's cloud proxy has no network path to a stdio process on your machine, so `mode: "proxy"` would fail with a 502. In `mode: "sdk"` ArmorIQ makes the allow, hold, or block decision and this process spawns the server and runs each approved call itself.

## Step 4: Write your first policy

1. In the console, open **Policies → Policy Studio → Single Policy**.
2. Set **Target Type** to `mcp_server` and **Target ID** to the `weather` server you just registered.
3. Set **Default enforcement action** to `block`.
4. Paste the contents of `policy.yaml` into the YAML editor:

```yaml
name: weather-policy
version: v0.1.0
scope:
  target_type: mcp
  target: weather   # replace with your registered weather MCP server's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: search_location
    action: allow
  - tool: get_current_conditions
    action: allow
```

5. Save and activate.

`weather-mcp` only exposes read only public data lookups. Nothing is destructive or sensitive, so this policy allows both tools outright. Not every integration needs holds. Match the policy to what the tool can do.

## Step 5: Configure the project

```bash
cp .env.example .env     # fill in ARMORIQ_API_KEY and GEMINI_API_KEY
npm install
```

`WEATHER_MCP_NAME` must match the name you registered in Step 3.

## Step 6: The pieces

- `src/mcpClient.js` spawns `weather-mcp` over stdio and calls its tools. The first run downloads it with `npx`, so expect a short delay.
- `src/tools.js` wraps the two MCP tools as LangChain tools. Their names use ArmorIQ's `<mcp>__<action>` convention (`weather__search_location`), so the handler's policy lookups resolve to the registered server with no extra mapping.
- `agent.js` builds the model, the agent, and the ArmorIQ handler:

```javascript
// Once per process.
const armoriq = new ArmorIQLangChain({
  client: new ArmorIQClient({ apiKey: armoriqApiKey }),
  mode: "sdk",
  defaultMcpName: process.env.WEATHER_MCP_NAME || "weather",
  validitySeconds: 2400,
});

const agent = createAgent({ model, tools, prompt });

// Per request: one extra callback, no changes to the agent, tools, or prompt.
const handler = await armoriq.forUser(userEmail, { goal, onEvent });
const result = await agent.invoke({ messages: [{ role: "user", content: goal }] }, { callbacks: [handler] });
```

Two LangChain callbacks in the handler do the work. `handleLLMEnd` captures the tool calls the model chose as the plan. `handleToolStart` checks each call before the tool runs, and throws on a block or a rejected hold so LangChain skips the tool. The `onEvent` callback streams `hold`, `approved`, `rejected`, `timeout`, `block`, and `error` as they happen.

This recipe targets `langchain` 1.x and its `createAgent` API.

## Step 7: Run it

```bash
npm start
# or ask something else
node agent.js "What's the weather like in Tokyo right now?"
```

Before the policy is active you will see the fail closed default:

```
[ARMORIQ EVENT] block: {"tool":"weather__search_location","reason":"no_matching_policy"}
```

Once the policy is saved and activated, the same run executes both tool calls and prints an answer.

## Step 8: See it in the ArmorIQ dashboard

Open **Intent** in the console, filtered by your `USER_EMAIL`. Each run shows the two tool calls the model chose, in order, each with its own decision and matched policy, even though they came from one `agent.invoke()` call and one callback handler.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Model call fails with "no longer available to new users" | Some Gemini model ids are deprecated for new API keys. Use `gemini-flash-lite-latest` or check what your key can use |
| Everything gets blocked | Default policy is `block` with no matching rule. Confirm the Step 4 policy is saved and activated, and that its `target` matches the registered server's id |
| `mode: "proxy"` returns a 502 | `weather-mcp` uses stdio transport and the cloud proxy cannot reach it. Use `mode: "sdk"` |
| The agent says it is "unable to retrieve" data after a block | Working as intended. The handler throws on a block, LangChain surfaces it as a tool error, and the model explains the failure instead of crashing |

## What's next

- Add a live approval UI. Wire the `onEvent` stream into a real interface instead of `console.log`.
- Try the Strands recipe for the same pattern in Python, with holds and amount thresholds.
- Try the Postgres recipe for a tool surface where one tool can do anything.
