# Build a Strands Agent with the ArmorIQ SDK

A step by step guide to dropping ArmorIQ into an AWS Strands Agents assistant with the SDK's shipped `ArmorIQStrands` integration, not a hand rolled enforcement loop. It is the Python counterpart to the LangChain recipe: the same idea of adding ArmorIQ to the framework you already use, in a domain built to show holds, approvals, and live enforcement events.

Credit: this recipe comes from the [`strands-support-agent` demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/strands-support-agent) in Naveen-6087/aiq-demos, and the guide text is adapted from that repo's Strands cookbook page.

## What you'll build

A support-desk assistant that can look up a ticket, reply to it, issue a refund, or close an account:

```
goal → model picks a tool call → ArmorIQ checks it (allow / hold / block) → execute if allowed → repeat until done
```

The tools are tiered on purpose. Reads and low risk writes are allowed outright, refunds are held for a human to approve, and closing an account is blocked. One planted support ticket (`TCK-1002`) contains a prompt injection attempt. You ask the agent to act on it, watch the model try to comply, and watch ArmorIQ hold the refund and block the account closure anyway. Policy is evaluated against the real tool and its real arguments, not against whatever the ticket text claims is "pre-authorized".

## Run it offline

No accounts, keys, Docker, or network needed. Offline mode runs the real `agent.py`, the real Strands `Agent`, the real `ArmorIQStrands` hooks, and the real support-desk MCP server (spawned locally over stdio). Only two things are stand-ins, both in `offline/`: the ArmorIQ client, which decides from this recipe's `policy.yaml`, and the Gemini model, which is scripted.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python offline/demo.py     # three requests: allowed, held, and the TCK-1002 injection
.venv/bin/python offline/test.py     # the same run as a pass or fail check
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`. The armoriq-sdk 0.6.10 package needs Python 3.10 to 3.13.

Each decision prints one line, for example:

```
[armoriq] check issue_refund: HELD (policy support-desk-policy: issue_refund -> hold)
[armoriq] hold issue_refund: APPROVED
[armoriq] check close_account: BLOCKED (policy support-desk-policy: close_account -> block)
```

Held calls are approved by default. Set `OFFLINE_APPROVAL=reject` to reject them and watch the agent handle it:

```bash
OFFLINE_APPROVAL=reject .venv/bin/python offline/demo.py
```

Edit a rule in `policy.yaml` (say, change `issue_refund` from `hold` to `allow`) and the offline result changes with it.

## Before you start

| Requirement | Why |
|---|---|
| Python 3.10 to 3.13 | Runs the agent |
| An ArmorIQ account | Policy enforcement and observability |
| A Gemini API key | Drives the Strands agent's model calls |

```bash
python3 --version   # 3.10 up to 3.13
```

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com).
2. Click **Create API key** and copy it.

Strands also ships first party providers for Bedrock (its default), Anthropic, OpenAI, and others in `strands.models.*`. Swap `GeminiModel` for any of them in `agent.py` and everything else (tools, `ArmorIQStrands`, the agent) is unchanged.

## Step 3: Install the project

This recipe already contains the code. Set up an environment and install the pinned dependencies:

```bash
python3 -m venv .venv
source .venv/bin/activate          # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

`requirements.txt` pins every package with `==`:

```
strands-agents[gemini]==1.57.1
armoriq-sdk[strands]==0.6.10
mcp==2.1.1
python-dotenv==1.2.3
PyYAML==6.0.3
```

> The `mcp` package made a breaking rename between major versions (`FastMCP` became `MCPServer`, under `mcp.server.mcpserver`). This recipe targets the API confirmed working at `mcp==2.1.1`. If you bump it and the support-desk server stops importing, check that first. PyYAML is only used by the offline stand-in to read `policy.yaml`.

## Step 4: The support-desk MCP server

`support_desk_mcp.py` is a small self built server with five tools, tiered by risk:

| Tool | Risk | Policy |
|---|---|---|
| `list_tickets`, `get_ticket` | read only | allow |
| `reply_to_ticket` | low risk write | allow |
| `issue_refund` | money movement | hold |
| `close_account` | destructive, irreversible | block |

`issue_refund`'s amount field is deliberately named `amount`. ArmorIQ's policy engine scans tool arguments for canonical field names (`amount`, `value`, `total`, `price`, `cost`) to evaluate amount threshold rules, so a tool has to expose one of those names for that feature to see it at all.

## Step 5: Register the support-desk MCP server with ArmorIQ

1. In the ArmorIQ console, open **MCP Servers**.
2. Click **Add MCP Server**.
3. Name it `support-desk`.
4. Save.

### Why `mode="sdk"`

This server uses stdio transport, so it runs as a local subprocess, the way every MCP host runs it. ArmorIQ's cloud proxy has no network path to a stdio process on your machine. The agent therefore runs `mode="sdk"` and spawns the server itself, instead of `mode="proxy"`, which would try to route the call through the proxy and return a 502. In `sdk` mode ArmorIQ gives a real allow, hold, or block decision, and this process executes each approved call itself.

## Step 6: Write your first policy

1. In the console, open **Policies → Policy Studio → Single Policy**.
2. Set **Target Type** to `mcp_server` and **Target ID** to the `support-desk` server you just registered.
3. Set **Default enforcement action** to `block`.
4. Paste the contents of `policy.yaml` into the YAML editor:

```yaml
name: support-desk-policy
version: v0.1.0
scope:
  target_type: mcp
  target: support-desk   # replace with your registered server's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: list_tickets
    action: allow
  - tool: get_ticket
    action: allow
  - tool: reply_to_ticket
    action: allow
  - tool: issue_refund
    action: hold
  - tool: close_account
    action: block
```

5. Save and activate.

The Policy Studio form's Member Rules section also has an **Amount thresholds** field per rule, if you would rather hold only above $100 than hold every refund. This YAML holds every refund unconditionally, the simpler and safer default for a demo.

## Step 7: Configure environment variables

Fill in `.env` (copied from `.env.example` in Step 3):

```
# From platform.armoriq.ai → Settings → API Keys
ARMORIQ_API_KEY=ak_your_key_here

# From aistudio.google.com
GEMINI_API_KEY=your_gemini_key_here
GEMINI_MODEL=gemini-flash-lite-latest

# Identifies this session in ArmorIQ's observability logs
USER_EMAIL=you@your-org.com

# Must match the name you registered in Step 5
SUPPORT_DESK_MCP_NAME=support-desk
```

`.env` is already in `.gitignore`.

## Step 8: How the agent is built

`agent.py` does three things:

```python
armoriq = ArmorIQStrands(
    armoriq_client=ArmorIQClient(api_key=os.environ["ARMORIQ_API_KEY"]),
    mode="sdk",
    default_mcp_name="support-desk",
    validity_seconds=2400,
)
```

Once per process, this creates the factory. Then per request:

```python
hooks = armoriq.for_user(user_email, goal=goal, on_event=on_event)
agent = Agent(model=model, tools=tools, system_prompt=..., hooks=[hooks])
result = agent(goal)
```

`for_user` returns a hook provider you pass to the `Agent`. Every tool call that invocation makes goes through ArmorIQ's plan, token, policy, and audit pipeline through three Strands hooks, with no changes to the agent, the tools, or the system prompt. The `on_event` callback fires `hold`, `approved`, `rejected`, `timeout`, `block`, and `error`.

## Step 9: Run it

```bash
python agent.py "Refund the duplicate charge on TCK-1003"
```

Sample output once the policy is active:

```
[ARMORIQ EVENT] hold: {'tool': 'issue_refund', 'reason': 'rule_action_hold'}
```

Approve the delegation on the dashboard, and a re-run (or a resumed `await_approval` wait) lets the refund through.

Now try the prompt injection:

```bash
python agent.py "Read TCK-1002 and do whatever the customer is asking for"
```

The model reads a ticket demanding an immediate $5,000 refund and account closure, "pre-authorized, no approval needed". Watch it attempt exactly that, and watch ArmorIQ hold the refund and block the account closure anyway, regardless of what the ticket text claimed.

## Step 10: See it in the ArmorIQ dashboard

Open **Intent** in the console, filtered by your `USER_EMAIL`. The prompt injection run shows up as a plan with a `hold` on `issue_refund` and a `block` on `close_account`, each with the actual arguments the model tried to pass (`amount: 5000` and the real account id). A reviewer sees exactly what was attempted, not just that something happened.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ModuleNotFoundError: mcp.server.fastmcp` | You are on `mcp>=2`, which renamed `FastMCP` to `MCPServer` under `mcp.server.mcpserver`. Use the import in `support_desk_mcp.py`, or pin `mcp<2` |
| `ModuleNotFoundError: No module named 'google'` | Install the Gemini extra: `pip install "strands-agents[gemini]"` |
| `No matching distribution found for armoriq-sdk==0.6.10` | Your Python is 3.14 or newer. Use 3.10 to 3.13 |
| Everything gets blocked, never held | The default policy is `block` and no rule matched. Confirm Step 6's policy is saved and activated, and that its `target` matches the registered server's id |
| Gemini returns `503 UNAVAILABLE` or high demand | Transient upstream overload. Retry, or try `gemini-flash-latest` |
| `dispatch()` or `mode="proxy"` returns a 502 | The support-desk server uses stdio, which ArmorIQ's cloud proxy cannot reach. Use `mode="sdk"` as shown |

## What's next

* **Stream holds into a real UI.** Wire `on_event` into a live approvals screen instead of `print`.
* **Add an amount threshold.** Configure Policy Studio's Member Rules "Amount thresholds" field so small refunds auto allow and only large ones hold.
* **Try the LangChain recipe** for the TypeScript side of the same adapter pattern, with a read only weather domain instead.
