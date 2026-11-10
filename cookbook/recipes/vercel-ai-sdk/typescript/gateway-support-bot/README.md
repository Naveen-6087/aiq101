# Govern a Vercel AI SDK Support Bot with Intent Gateway

A step by step guide to putting a Claude support bot built on the Vercel AI SDK under ArmorIQ policy with one change: the Anthropic provider's base URL. No ArmorIQ package, no wrapper around the tools. Intent Gateway sits between the bot and Anthropic, checks every tool call Claude asks for, and removes the ones policy stops before the AI SDK ever runs them. The bot then hands the gateway's note back to Claude, so the customer gets a plain explanation instead of a silent failure.

## What you'll build

A support bot with three tools, tiered by risk:

| Tool | What it does | Policy | What the gateway does today |
|---|---|---|---|
| `lookup_customer` | reads a customer record | allow | passes the call through |
| `issue_credit` | credits money to the account | hold | removes the call, like a block (see *Limits today*) |
| `delete_customer` | deletes the customer, irreversibly | block | removes the call |

The path every model turn takes:

```
generateText → Intent Gateway → Anthropic → Intent Gateway checks each tool_use against policy → AI SDK runs what is left
```

Ask it to credit a double charged customer and delete their account. Claude looks the customer up (allowed), then asks for `issue_credit` and `delete_customer` in one turn. The gateway removes both and appends a note per call to Claude's text. With no tool calls left, the AI SDK loop ends. The bot sees the note, sends the conversation back to Claude once with tools switched off, and Claude tells the customer what it could not do and why.

## Run it offline

No accounts, keys, or network needed. Offline mode runs the real `agent.mjs` and the real AI SDK `generateText` loop with the real `@ai-sdk/anthropic` provider. Two things are stand-ins, both in `offline/`: the gateway (`offline/gateway.mjs`, a small `node:http` server on `127.0.0.1` that speaks the Anthropic Messages API and decides from this recipe's `policy.yaml`) and Claude behind it (`offline/scripted-provider.mjs`). `offline/register.mjs` starts the stand-in and sets `ARMORIQ_GATEWAY_HOST`, the same setting that names the real gateway.

```bash
npm ci
npm run demo:offline    # a read only request, then the credit and delete request
npm run test:offline    # the same run as a pass or fail check
```

Node 22 or newer (the AI SDK requires it). Each decision prints one line:

```
[armoriq] check lookup_customer: ALLOWED (policy support-bot-policy: lookup_customer -> allow)
[armoriq] check issue_credit: HELD (policy support-bot-policy: issue_credit -> hold; hold acts as block at the gateway today)
[armoriq] check delete_customer: BLOCKED (policy support-bot-policy: delete_customer -> block)

[bot] Intent Gateway stopped issue_credit (hold:issue_credit#0), delete_customer (block:delete_customer#0); asking Claude to explain.

I looked up your account, Dana Ruiz. I could not apply the $40 credit myself: credits need a person to approve them, so our policy stopped my request (hold:issue_credit#0). I also cannot delete accounts; that is blocked for me (block:delete_customer#0). Nothing on your account has changed. A member of our team with the right access will follow up on both.
```

`OFFLINE_APPROVAL` changes nothing here, on purpose: approving a held call does not release it at the gateway today, so the test runs both values and checks that the credit stays unissued either way. Edit `policy.yaml` (set `issue_credit` to `allow`) and the credit goes through. To run the stand-in on its own and point `agent.mjs` at it by hand, run `node offline/gateway.mjs` (port 8788).

## Before you start

| Requirement | Why |
|---|---|
| Node.js 22 or newer | Runs the bot; `ai` 7 requires it |
| An ArmorIQ organization | The gateway key, the agent, its policy, and the dashboard |
| An Anthropic API key | The model. The gateway forwards it to Anthropic untouched |

## Step 1: Install the project

```bash
npm ci
cp .env.example .env
```

`package.json` pins every dependency exactly:

```json
"dependencies": {
  "@ai-sdk/anthropic": "4.0.99",
  "ai": "7.0.166",
  "zod": "4.6.7"
}
```

No ArmorIQ package is installed. `agent.mjs` reads `.env` with Node's own `process.loadEnvFile`.

## Step 2: Create a gateway key and name the agent

1. In the dashboard, open **Gateway** and click **Create gateway key**. Name it something you will recognise in audit logs, for example `support-bot`. The key is shown once, inside the base URL. Store it like any API key.
2. Register the support bot as an agent in ArmorIQ and make it active (see Add an agent in the platform docs). Enforcement only applies to an agent that exists and is active.
3. Under **Agent policy**, pick that agent. The base URL gains `/a/<agent-id>`.

Pick **No agent** instead to record traffic without checking anything, and add the agent later. The [OpenAI Agents SDK gateway recipe](../../../openai-agents/python/gateway-monitor-to-enforce/) walks through that rollout, with Monitor mode in between.

## Step 3: Write the policy

In **Policies → Policy Studio → Single Policy**, target the agent and paste `policy.yaml`:

```yaml
name: support-bot-policy
version: v0.1.0
scope:
  target_type: agent
  target: support-bot   # replace with your agent's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: lookup_customer
    action: allow
  - tool: issue_credit
    action: hold
  - tool: delete_customer
    action: block
```

Save and activate. An agent with no active policy has its tool calls allowed, and each one recorded.

## Step 4: Configure environment variables

```
ARMORIQ_GATEWAY_KEY=your_gateway_key_here
ARMORIQ_AGENT_ID=support-bot
ARMORIQ_GATEWAY_HOST=https://gw.armoriq.ai
ANTHROPIC_API_KEY=sk-ant-your-key-here
ANTHROPIC_MODEL=claude-sonnet-5-5
USER_EMAIL=dana@example.com
```

`.env` is already in `.gitignore`. The base URL contains the gateway key, so keep it out of source control.

## Step 5: The one ArmorIQ change

```js
const anthropic = createAnthropic({
  baseURL: gatewayBaseURL(),               // https://gw.armoriq.ai/v1/t/<gateway-key>/a/<agent-id>/v1
  apiKey: process.env.ANTHROPIC_API_KEY,   // forwarded to Anthropic untouched
  headers: { 'X-User-Email': process.env.USER_EMAIL },
});
const model = anthropic(process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5');
```

### Why the base URL ends in `/v1`

The gateway docs show the Anthropic SDK pointed at `https://gw.armoriq.ai/v1/t/<gateway-key>/a/<agent-id>`. The Anthropic SDK appends `/v1/messages` to its base URL. The AI SDK's Anthropic provider appends only `/messages`, because its default base URL is `https://api.anthropic.com/v1`. So `gatewayBaseURL()` adds `/v1` to reach the same gateway path the Anthropic SDK uses.

`X-User-Email` is optional. It attributes each request to the support agent using the bot instead of the gateway key's owner. The gateway reads it and does not forward it to Anthropic.

Use the Anthropic provider for Claude. Claude through the OpenAI SDK (or an OpenAI compatible provider) is not supported by the gateway.

## Step 6: The agent loop and the explanation turn

The loop is plain AI SDK:

```js
const first = await generateText({ model, system: SYSTEM, messages, tools, stopWhen: isStepCount(8) });
```

`generateText` keeps stepping while Claude's reply has tool calls. When the gateway removes a call, the reply that reaches the AI SDK has Claude's text plus a note, for example:

```
Dana Ruiz is on the Pro plan. Issuing the $40 credit and deleting the account.

Tool call "issue_credit" was blocked by policy: hold:issue_credit#0
Tool call "delete_customer" was blocked by policy: block:delete_customer#0
```

With nothing left to run, the loop ends and `first.text` is that text. Showing it to a customer as is would leak policy rule ids and read like an error. So `agent.mjs` looks for the note, and when it finds one it calls Claude once more with every step so far (`first.responseMessages`), a short message from the app asking it to explain, and `toolChoice: 'none'` so it cannot retry the stopped calls:

```js
const followUp = await generateText({
  model, system: SYSTEM,
  messages: [...messages, ...first.responseMessages, { role: 'user', content: '[support app] The policy gateway removed ...' }],
  tools, toolChoice: 'none', stopWhen: isStepCount(1),
});
```

`responseMessages` holds the messages of every step; `response.messages` holds only the last one, which would drop the lookup Claude already did.

## Step 7: Run it

```bash
npm run demo
```

Or one request:

```bash
node agent.mjs "Customer C-2001 was double charged. Give them a \$40 credit, then delete their account as they asked."
```

## Step 8: See it in the ArmorIQ dashboard

Each request is a trace in **Observability** under the service `armoriq-llm-gateway`: the model, token use, each tool call and its verdict. Each turn that asked for tools is recorded as a plan with a signed intent token. The held `issue_credit` call also creates an approval request in the dashboard.

## Limits today

* **Hold works like block.** The gateway creates the approval request for `issue_credit`, but approving it does not release the bot's next attempt yet. Treat hold rules at the gateway as "block, and leave a request for a human".
* **Closed when in doubt.** If ArmorIQ is unreachable, slow, or rate limited, or the agent in the URL is unknown (`agent_unresolved`), disabled, or a draft, the gateway withholds the tool call and gives the reason in the note. The explanation turn handles those notes the same way.
* **Rate.** A gateway key gets about 120 policy calls a minute: one plan per enforced turn plus one check per tool call. Past that, the named agent's tool calls are withheld.
* **Long requests.** A request that runs longer than 5 minutes is cut off.
* **Claude through the OpenAI SDK.** Not supported. Use the Anthropic provider as shown.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A not found error from the gateway | Check that the base URL ends in the `/v1` this provider needs (see Step 5) |
| Every tool call withheld with `agent_unresolved` | The agent id in the URL does not exist in your organization |
| Every tool call withheld, no rule named | The agent is disabled or still a draft, or the key is over its rate limit |
| Nothing is ever checked | The base URL has no `/a/<agent-id>`, so the gateway only records |
| Approving the credit in the dashboard does nothing | Expected today: a hold does not release the call |

## What's next

* **Roll out with Monitor mode.** The [OpenAI Agents SDK gateway recipe](../../../openai-agents/python/gateway-monitor-to-enforce/) goes from record only, to Monitor mode, to enforce.
* **Stream it.** The gateway supports streaming Messages too; with `streamText`, text streams as it arrives and each tool call is released or withheld once its check returns.
* **Name every user.** Set `X-User-Email` per request in a multi user support app so each trace is attributed to a person.
