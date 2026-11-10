# Build a Release Agent That Handles Blocks with the ArmorIQ SDK

A step by step guide to the ArmorIQ Python SDK with no framework at all: a hand written agent loop that plans, mints an intent token, and invokes each tool call through ArmorIQ. It is the template to copy when your agent has no framework, or when you want to see exactly what the framework adapters do for you.

The other half of the recipe is what happens when ArmorIQ says no. Most examples stop at the first `PolicyBlockedException`. This one keeps going: it re-plans around a blocked tool, stops cleanly when a human rejects a held call, signs a new plan when the agent drifts from the old one, and mints a fresh token when the old one runs out.

## What you'll build

A release desk assistant that reads CI results, deploys to staging and production, and manages environments, all through a small MCP server that ships with the recipe:

```
goal → plan (model) → capture_plan → get_intent_token → invoke_with_policy, step by step
                         ↑                                         │
                         └──── re-plan / re-mint on a refusal ─────┘
```

| Tool | Risk | Policy |
|---|---|---|
| `list_environments`, `get_build_status` | read only | allow |
| `rerun_ci`, `run_smoke_tests`, `deploy_to_staging`, `request_teardown` | low risk write | allow |
| `deploy_to_production` | customer facing | hold |
| `delete_environment` | irreversible | block |

## Run it offline

No accounts, keys, Docker, or network needed. Offline mode runs the real `agent.py` loop, the real `mcp_stdio.py` tool listing, the real `release_desk_mcp.py` server (spawned over stdio), and the SDK's real exception classes and models. Two things are stand-ins, both in `offline/`: the ArmorIQ client, which decides from this recipe's `policy.yaml` and runs allowed calls on the local server (the job ArmorIQ's proxy does live), and the planner, which is rule based instead of Gemini.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python offline/demo.py     # five requests: allowed, held, blocked, off plan, expired token
.venv/bin/python offline/test.py     # the same run as a pass or fail check, approve and reject
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`. The armoriq-sdk 0.8.18 package needs Python 3.10 to 3.13.

The five requests and what each one shows:

| Request | What happens | Recovery |
|---|---|---|
| Deploy checkout build 512 to staging | Both steps allowed | none needed |
| Deploy checkout build 512 to production | `deploy_to_production` is held for a human | approved: it runs. Rejected: the agent stops and says so |
| Tear down the idle staging-eu environment | `delete_environment` is blocked | re-plans without it and files `request_teardown` for a human instead |
| Deploy payments build 77 to staging | The build is red, so the agent wants `rerun_ci`, which is not in the signed plan | catches `IntentMismatchException`, signs a new plan from that step on |
| Run smoke tests, then deploy | A 2 second token, a 3 second smoke test | catches `TokenExpiredException`, mints a fresh token for the same plan, retries |

The block and its recovery, as printed:

```
[armoriq] check delete_environment: BLOCKED (policy release-desk-policy: delete_environment -> block)
[agent] PolicyBlockedException: delete_environment was blocked (...). Re-planning without it.
[agent] re-planned (attempt 2): request_teardown
[armoriq] plan: Tear down the idle staging-eu environment -> request_teardown
[armoriq] check request_teardown: ALLOWED (policy release-desk-policy: request_teardown -> allow)
Answer: Done: list_environments, request_teardown. Refused: delete_environment (blocked by policy).
```

Held calls are approved by default. Set `OFFLINE_APPROVAL=reject` to reject them and watch the agent stop without crashing:

```bash
OFFLINE_APPROVAL=reject .venv/bin/python offline/demo.py
```

```
[armoriq] hold deploy_to_production: REJECTED
[agent] DelegationException: deploy_to_production was not approved (Delegation rejected). Stopping here.
Answer: Done: get_build_status. Refused: deploy_to_production (approval rejected). A human declined that step, so I did not try another route.
```

Edit a rule in `policy.yaml` (say, change `delete_environment` to `allow`) and the offline result changes with it.

## The loop, step by step

Everything below is in `agent.py`, in the `run()` function. Read it top to bottom; it is about a hundred lines.

### Step 1: Plan

```python
steps = planner.plan(goal, tools)
# [{"action": "get_build_status", "params": {...}}, {"action": "deploy_to_staging", "params": {...}}]
```

`planner.py` sends the goal and the tool catalog (read from the MCP server by `mcp_stdio.py`) to Gemini and asks for JSON. Any model works here. The only contract is the list of `{"action", "params"}` steps, and the loop drops any tool the model invents.

### Step 2: Capture the plan

```python
capture = client.capture_plan(
    llm=planner.MODEL,
    prompt=goal,
    plan={"goal": goal, "steps": [{"action": s["action"], "mcp": MCP_NAME, "params": s["params"]} for s in steps]},
)
```

`capture_plan` is local. It checks the plan has `steps` and wraps it in a `PlanCapture`. Every tool the agent is going to call has to be in here, because the token you mint next is bound to exactly this plan.

### Step 3: Mint an intent token

```python
token = client.get_intent_token(capture, validity_seconds=token_seconds, user_email=user_email)
```

This is the first network call. ArmorIQ hashes the plan, signs a token for it, and tags it with the end user. The SDK default lifetime is 60 seconds; this recipe uses 300 (`TOKEN_VALIDITY_SECONDS`). If the plan names a tool the policy denies outright, ArmorIQ can refuse here with `PolicyBlockedException` before anything runs, so the loop catches it at this step too.

### Step 4: Invoke each step

```python
result = client.invoke_with_policy(
    MCP_NAME, step["action"], token,
    params=step["params"],
    options=InvokeOptions(
        user_email=user_email,
        wait_for_approval=True,
        delegation_timeout_ms=300_000,
        on_hold=lambda info: say(f"{info.tool} is waiting for a human approver ({info.reason})"),
    ),
).result
```

`invoke_with_policy` sends the call to ArmorIQ's proxy, which verifies the token, checks the policy, and forwards the call to the registered MCP server. On a hold it creates the approval request, calls `on_hold`, and polls until a human approves (then retries the call), rejects, or the timeout passes. Plain `client.invoke()` is the same call without the hold handling: a hold raises `PolicyHoldException` and stops there.

### Step 5: Recover

Each `except` in the loop answers one question: what would a careful human do next?

| Exception | What it means | What the loop does |
|---|---|---|
| `PolicyBlockedException` | Policy says no to this tool | Never retries it. Adds it to `avoid` and asks the planner for another way to the goal |
| `DelegationException` | The hold was rejected or timed out | Stops and tells the user. A human said no, so it does not route around them |
| `PolicyHoldException` | Held, and the loop could not wait | Tells the user to approve on the dashboard and run again |
| `IntentMismatchException` | The step is not in the plan the token was signed for | Captures a new plan from that step on and mints a new token |
| `TokenExpiredException` | The token outlived its `validity_seconds` | Mints a fresh token for the same plan and retries the step once |
| `MCPInvocationException` | The tool itself failed | Stops and reports it; that is not an ArmorIQ decision |

`main()` also catches the base `ArmorIQException`, so anything the loop does not handle ends in a sentence, not a traceback. The loop gives up after three plans (`MAX_PLANS`), so a planner that keeps choosing refused tools cannot spin forever.

The mismatch case is worth a second look. The agent reacts to results (`react()`): when `get_build_status` comes back red, it wants to `rerun_ci` first. That step was not in the signed plan, and the loop does not try to remember that. It just calls `invoke`, lets ArmorIQ refuse, and handles the refusal in the one place that re-plans. A changed plan always means a new signature.

## Before you start

| Requirement | Why |
|---|---|
| Python 3.10 to 3.13 | Runs the agent |
| An ArmorIQ account | Tokens, policy, approvals, audit |
| A Gemini API key | Drives the planner |
| A way to expose a local port (a tunnel) or somewhere to deploy | ArmorIQ's proxy has to reach the MCP server, see Step 3 |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Install the project

```bash
python3 -m venv .venv
source .venv/bin/activate          # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # fill in ARMORIQ_API_KEY and GEMINI_API_KEY
```

`requirements.txt` pins every package with `==`.

## Step 3: Run the MCP server where ArmorIQ can reach it

`invoke()` does not call your MCP server directly. It sends the call to ArmorIQ's cloud proxy, and the proxy forwards it to the server URL you registered. A stdio process on your laptop is not reachable from there, so for the live path run the same server over streamable HTTP:

```bash
python release_desk_mcp.py --http      # serves http://127.0.0.1:8000/mcp
```

Then expose that port with a tunnel of your choice, or deploy the file somewhere public. The agent still spawns the server over stdio, but only to read the tool list for the planner (`mcp_stdio.py`); it never executes a tool that way.

If you want a local stdio server with no deployment, use a framework adapter in `mode="sdk"` instead (see the Strands recipe), where ArmorIQ decides and your process executes the call.

## Step 4: Register the server and write the policy

1. In the ArmorIQ console, open **MCP Servers**, click **Add MCP Server**, name it `release-desk`, and point it at the public URL from Step 3.
2. Open **Policies → Policy Studio → Single Policy**, set **Target Type** to `mcp_server` and **Target ID** to the `release-desk` server.
3. Set **Default enforcement action** to `block` and paste `policy.yaml` into the YAML editor.
4. Save and activate.

## Step 5: Run it

```bash
python agent.py "Deploy checkout build 512 to staging"
python agent.py "Deploy checkout build 512 to production"      # approve or reject it on the dashboard
python agent.py "Tear down the idle staging-eu environment"
```

The held production deploy waits up to `APPROVAL_TIMEOUT_MS` for a decision. Approve it in the console and the loop retries the call on its own.

## Limitations and honest notes

* **Not run live for this recipe.** The offline run is checked in CI. The live path follows the SDK 0.8.18 source and the docs but has not been run against a deployed release-desk server.
* **Where a block lands.** Depending on the policy, ArmorIQ can refuse a plan at token issuance (the whole plan) or a single call at invoke time. The loop handles both with the same recovery. The offline stand-in only blocks at invoke time.
* **Mismatch checks.** The offline stand-in raises `IntentMismatchException` when the action is not in the signed plan. The docs also say changed `params` can trigger it live; the stand-in does not check arguments.
* **Hold, then expiry.** `invoke_with_policy` retries a call once its hold is approved. If the approval took longer than the token's lifetime, that retry can raise `TokenExpiredException`, and the loop's retry with a fresh token may be held again. Give approval gated plans a longer `TOKEN_VALIDITY_SECONDS`.
* **Docs drift.** Some doc snippets read `e.delegation_id` from `PolicyHoldException` and `result.data` from an invoke result. In 0.8.18 the attributes are `e.delegation_context` (a dict) and `result.result`; this recipe uses the real ones.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `MCPInvocationException: Could not reach the ArmorIQ proxy` | Network or proxy endpoint problem, not policy |
| `MCPInvocationException ... (HTTP 502)` on every call | The proxy cannot reach the registered server URL. See Step 3 |
| Everything is blocked, never held | `default_action: block` and no rule matched. Check the policy is active and its `target` is the registered server's id |
| `TokenExpiredException` on long runs | Raise `TOKEN_VALIDITY_SECONDS`; the SDK default is 60 seconds |
| `No matching distribution found for armoriq-sdk==0.8.18` | Your Python is 3.14 or newer. Use 3.10 to 3.13 |

## What's next

* **Wrap it in a framework.** The CrewAI delegation recipe (`crewai/python/delegated-crew`) runs this same plan, token, invoke pattern inside a CrewAI tool, and adds delegated tokens for a sub-agent.
* **Stream holds into a UI.** Send `on_hold` to your approvals screen instead of printing it.
* **Narrow the blast radius.** Hold `deploy_to_staging` for one service, or add an amount style threshold, and watch the same loop handle the new refusals without code changes.
