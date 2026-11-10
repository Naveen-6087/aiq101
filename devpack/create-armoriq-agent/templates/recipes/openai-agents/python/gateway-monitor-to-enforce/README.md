# Govern an OpenAI Agents SDK Agent with Intent Gateway

A step by step guide to putting an OpenAI Agents SDK agent under ArmorIQ policy without adding an SDK, a wrapper, or a single line of enforcement code. The agent's OpenAI client points at Intent Gateway instead of OpenAI. You roll it out the way you would in production: record traffic first, then turn on Monitor mode to see what policy would do, then switch Monitor mode off and let the gateway enforce.

## What you'll build

An accounts payable clerk with two tools:

| Tool | What it does | Policy |
|---|---|---|
| `lookup_invoice` | reads an invoice | allow |
| `record_payment` | pays the supplier | block |

The path every model turn takes:

```
agent → Intent Gateway → OpenAI → Intent Gateway checks each tool call against policy → agent runs what is left
```

You ask it to pay an invoice three times, once per rollout phase:

| Phase | Base URL | Monitor mode | What happens to `record_payment` |
|---|---|---|---|
| 1. Record only | `/v1/t/<gateway-key>` | (n/a) | runs; the request is recorded, nothing is checked |
| 2. Monitor | `/v1/t/<gateway-key>/a/<agent-id>` | on | runs; the gateway records "would block" |
| 3. Enforce | `/v1/t/<gateway-key>/a/<agent-id>` | off | removed from the model's reply, with a note naming the rule |

## Run it offline

No accounts, keys, or network needed. Offline mode runs the real `agent.py` and the real Agents SDK `Runner`. Two things are stand-ins, both in `offline/`: the gateway (`offline/gateway.py`, a small stdlib HTTP server on `127.0.0.1` that speaks Chat Completions and decides from this recipe's `policy.yaml`) and OpenAI behind it (`offline/scripted_provider.py`, a scripted model). The demo points the agent at the stand-in by changing only `ARMORIQ_GATEWAY_HOST`, the same one setting you change for the real gateway.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python offline/demo.py     # the three phases: record, monitor, enforce
.venv/bin/python offline/test.py     # the same run as a pass or fail check
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`. openai-agents 0.24.0 needs Python 3.10 or newer.

The monitor phase lets the payment through and records what policy thought of it:

```
[armoriq] check record_payment: BLOCKED (monitor mode: would block, nothing stopped; policy ap-clerk-policy: record_payment -> block)
[ledger] payment recorded: INV-1042 $1,250.00 to Acme Supplies
[gateway] What policy would have done: 1 would block, 0 would hold, 1 allowed
```

The enforce phase removes it:

```
[armoriq] check record_payment: BLOCKED (policy ap-clerk-policy: record_payment -> block)

INV-1043 from Contoso Freight is approved for $4,800.00. Recording the payment.

Tool call "record_payment" was blocked by policy: block:record_payment#0
```

Edit `policy.yaml` (change `record_payment` to `allow`) and run the demo again: phase 3 pays the invoice. `offline/test.py` checks both versions. To run the stand-in on its own and point `agent.py` at it by hand, run `python offline/gateway.py` (port 8787; `OFFLINE_MONITOR_MODE=on` for monitor mode).

## Before you start

| Requirement | Why |
|---|---|
| Python 3.10 or newer | Runs the agent |
| An ArmorIQ organization | The gateway key, the agent, its policy, and the dashboard |
| An OpenAI API key | The model. The gateway forwards it to OpenAI untouched |

## Step 1: Install the project

```bash
python3 -m venv .venv
source .venv/bin/activate          # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

`requirements.txt` pins every package with `==`:

```
openai-agents==0.24.0
openai==3.48.0
python-dotenv==1.2.4
PyYAML==6.0.3
```

No ArmorIQ package is installed. PyYAML is only used by the offline stand-in to read `policy.yaml`.

## Step 2: The one ArmorIQ change

`agent.py` is a plain Agents SDK agent. The only ArmorIQ line is the client's base URL:

```python
client = AsyncOpenAI(
    base_url=gateway_base_url(),            # https://gw.armoriq.ai/v1/t/<gateway-key>[/a/<agent-id>]
    api_key=os.environ["OPENAI_API_KEY"],   # forwarded to OpenAI untouched
    default_headers={"X-User-Email": os.environ.get("USER_EMAIL", "dana@example.com")},
)
model = OpenAIChatCompletionsModel(model=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"), openai_client=client)
agent = Agent(name="AP clerk", instructions=..., model=model, tools=[lookup_invoice, record_payment])
```

### Why `OpenAIChatCompletionsModel`

The Agents SDK calls OpenAI's Responses API by default. Intent Gateway supports Chat Completions (streaming and non streaming, with tool calls), not the Responses API. Passing an `OpenAIChatCompletionsModel` built on the gateway client makes this agent use Chat Completions. If you would rather set it once for every agent in the process, `set_default_openai_client(client)` plus `set_default_openai_api("chat_completions")` does the same.

`X-User-Email` is optional. It attributes each request to the person using the agent instead of the gateway key's owner. The gateway reads it and does not forward it to OpenAI.

## Step 3: Phase 1, record only

1. In the dashboard, open **Gateway** and click **Create gateway key**. Name it something you will recognise in audit logs, for example `ap-clerk`. The key is shown once, inside the base URL. Store it like any API key.
2. Under **Agent policy**, pick **No agent**.
3. In `.env`, set `ARMORIQ_GATEWAY_KEY` and your `OPENAI_API_KEY`, and leave `ARMORIQ_AGENT_ID` empty.

```bash
python agent.py "Pay invoice INV-1041 from Northwind Paper in full"
```

The agent behaves exactly as it did against OpenAI. The **Gateway** page shows **Gateway traffic seen**, and each request appears in **Observability** under the service `armoriq-llm-gateway`, with the model, token use, and each tool call.

## Step 4: Phase 2, name the agent and turn on Monitor mode

1. Register the agent in ArmorIQ and make it active (see Add an agent in the platform docs). Enforcement only applies to an agent that exists and is active.
2. Author its policy in **Policies → Policy Studio → Single Policy**, targeting that agent. Paste `policy.yaml`:

```yaml
name: ap-clerk-policy
version: v0.1.0
scope:
  target_type: agent
  target: ap-clerk   # replace with your agent's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: lookup_invoice
    action: allow
  - tool: record_payment
    action: block
```

3. Open **Gateway** and turn on **Monitor mode** under the page title (org admins and IAM admins can change it). It applies within about 90 seconds, to every agent in the organization that reaches ArmorIQ through the gateway. Agents using the ArmorIQ SDK are not affected.
4. Set `ARMORIQ_AGENT_ID` in `.env`. The base URL becomes `/v1/t/<gateway-key>/a/<agent-id>`.

```bash
python agent.py "Pay invoice INV-1042 from Acme Supplies in full"
```

The payment still goes through. Monitor mode checks every tool call and records the verdict, but your agent receives every call exactly as the model wrote it, with no added delay: the gateway relays the reply first and checks after.

## Step 5: Read "What policy would have done"

Below the Monitor mode switch, **What policy would have done** covers the last 7 days: totals of calls that would be blocked, would be held, and were allowed, a row per tool and verdict with the policy that decided it, and the latest calls policy would have stopped, with the reason. Here it shows `record_payment` as would block under `ap-clerk-policy`.

Let real traffic run for a week or two. If a row shows a call you do not want stopped, use **Adjust policies** to change the rule and watch the counts on new traffic. When the report only shows calls you want stopped, move on.

## Step 6: Phase 3, switch Monitor mode off

Turn **Monitor mode** off on the **Gateway** page. Nothing changes in your code or `.env`.

```bash
python agent.py "Pay invoice INV-1043 from Contoso Freight in full"
```

The model asks for `record_payment`. The gateway removes that tool call from the reply and appends a note naming the rule:

```
INV-1043 from Contoso Freight is approved for $4,800.00. Recording the payment.

Tool call "record_payment" was blocked by policy: block:record_payment#0
```

That reply now has no tool calls left, and the Agents SDK treats a reply with no tool calls as the final answer. So `result.final_output` is the model's text plus the note, and the run ends there. `agent.py` checks for `was blocked by policy` and tells the user a call was stopped. If you want the model to explain the block in its own words, run it again with the note in the conversation.

## How the gateway decides

For each model turn on a URL that names an agent, the gateway registers the reply's tool calls with ArmorIQ as a plan, gets a signed intent token for it, checks each call against the agent's active policy, and then relays the reply: allowed calls unchanged, blocked calls removed with a note. An agent with no active policy has its tool calls allowed, and each one is recorded.

If the check cannot complete (ArmorIQ unreachable, slow, or rate limited, the agent unknown, disabled, or still a draft), the gateway withholds the tool call and gives the reason in the note. Calls are never released just because a check failed. An unknown agent id shows up as `agent_unresolved`.

## Limits today

* **Hold works like block.** A `hold` rule removes the call. The gateway creates an approval request, but approving it does not release the agent's next attempt yet. In Monitor mode a held call shows as "would hold" and creates no approval.
* **Rate.** A gateway key gets about 120 policy calls a minute, shared between plans (one per enforced turn) and checks (one per tool call). Past that, a named agent's tool calls are withheld when enforcing; in Monitor mode they are recorded as not checked and still run.
* **Long requests.** A request that runs longer than 5 minutes is cut off.
* **Responses API.** Not supported through the gateway; use Chat Completions as shown in Step 2.
* **Claude through the OpenAI SDK.** Not supported. Use the Anthropic SDK for Claude models (see the Vercel AI SDK gateway recipe).
* **Monitor mode is org wide.** It is one switch for every gateway agent in the organization, not per agent.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Errors from a `/responses` endpoint | The agent is using the Responses API. Use `OpenAIChatCompletionsModel` (or `set_default_openai_api("chat_completions")`) |
| Every tool call withheld with `agent_unresolved` | The agent id in the URL does not exist in your organization |
| Every tool call withheld, no rule named | The agent is disabled or still a draft, or the key is over its rate limit |
| Nothing is ever checked | The base URL has no `/a/<agent-id>`, so the gateway only records |
| Calls still run after you turned Monitor mode off | The switch takes about 90 seconds to apply |

## What's next

* **Add a hold.** Change `record_payment` to `hold` to collect approval requests in the dashboard, knowing approving does not release the call yet.
* **Name the user.** Set `X-User-Email` per request in a multi user app so every trace is attributed to a person.
* **Try the Vercel AI SDK gateway recipe** for the same gateway with the Anthropic provider, where the model reads the gateway's note and explains it to the user.
