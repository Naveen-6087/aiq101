# Build a LangGraph approval interrupt with the ArmorIQ SDK

An on-call assistant built as a LangGraph `StateGraph`, where every tool call goes through ArmorIQ before it runs, and an ArmorIQ hold becomes a native LangGraph `interrupt()`. The run stops, the checkpointer saves the thread, your app shows the held call to a human, and `Command(resume=...)` picks the graph up where it left off. Nothing blocks a worker while you wait for the approver.

## What you'll build

An agent you can page with "checkout-api is throwing 502s, find out why and fix it". It reads status and logs, decides a restart is needed, and asks for one. ArmorIQ holds the restart for approval:

```
agent → policy_gate ─┬─ all allowed or blocked ───────────────→ run_tools → agent → ... → END
                     └─ any HELD → human_review: interrupt() ─→ run_tools
                                    (checkpointed; resumed with Command(resume=...))
```

| Tool | What it does | Policy |
|---|---|---|
| `get_service_status`, `read_recent_logs` | Investigate | allow |
| `restart_service` | Rolling restart, changes production | hold |
| `delete_volume` | Destroys a storage volume | block |

The fleet in `runbook_tools.py` is simulated in memory, so the recipe runs anywhere. Replace the function bodies with your real Kubernetes, cloud, or log store calls; the tool names and arguments are what the policy matches on.

## Run it offline

No accounts, keys, or network needed. Offline mode runs the real `agent.py`: the real `StateGraph`, its `policy_gate`, `human_review`, and `run_tools` nodes, the real `interrupt()` and `Command(resume=...)`, and the real `InMemorySaver` checkpointer. Two things are stand-ins, both in `offline/`: the ArmorIQ client, which decides from this recipe's `policy.yaml`, and the OpenAI model, which is a scripted tool calling chat model. The demo's "reviewer" is a function that resumes the thread instead of waiting for you.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python offline/demo.py     # a held restart through interrupt and resume, then a blocked delete
.venv/bin/python offline/test.py     # the same run as a pass or fail check, approved and rejected
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`.

The held call looks like this:

```
[armoriq] check restart_service: HELD (policy oncall-runbook-policy: restart_service -> hold)
[graph] interrupted at ['human_review']; thread oncall-5ac21c42 saved at checkpoint 1f1dcc5e-...
  [reviewer] sees HELD restart_service {"service": "checkout-api", "reason": "..."} delegation=offline-delegation-1
[graph] resuming thread oncall-5ac21c42 with Command(resume={'reviewed_by': 'oncall-lead@example.com'})
[armoriq] hold restart_service: APPROVED
[armoriq] report restart_service: success
```

Holds are approved by default. Set `OFFLINE_APPROVAL=reject` and ArmorIQ rejects the restart after the resume; it never runs, and the agent says a human should take over:

```bash
OFFLINE_APPROVAL=reject .venv/bin/python offline/demo.py
```

Edit `policy.yaml` (say, set `restart_service` to `allow`) and the interrupt disappears from the offline run.

## Before you start

| Requirement | Why |
|---|---|
| Python 3.10 or later (tested on 3.12) | Runs the graph |
| An ArmorIQ account | Policy, approvals, and the audit trail |
| An OpenAI API key | Drives the model node |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get an OpenAI API key

Create one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Only the `ChatOpenAI(...)` line in `agent.py` is OpenAI specific; any LangChain chat model with tool calling works.

## Step 3: Install the project

```bash
python3 -m venv .venv
source .venv/bin/activate          # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

`requirements.txt` pins every package with `==`:

```
armoriq-sdk[langchain]==0.8.18
langchain-core==1.2.31
langgraph==1.1.6
langgraph-checkpoint==4.3.1
langchain-openai==1.1.14
python-dotenv==1.2.4
PyYAML==6.0.3
```

PyYAML is only used by the offline stand-in to read `policy.yaml`.

## Step 4: Register the tools and write the policy

1. In the ArmorIQ console, open **MCP Servers**, click **Add MCP Server**, and name it `oncall-runbook` (or set `RUNBOOK_MCP_NAME` to your name). The tools here are local functions, not an MCP server; the session attributes them to this name through `default_mcp_name`, so policy has a target to attach to.
2. Open **Policies → Policy Studio → Single Policy**, set **Target Type** to `mcp_server` and **Target ID** to that server, and set **Default enforcement action** to `block`.
3. Paste `policy.yaml`:

```yaml
name: oncall-runbook-policy
version: v0.1.0
scope:
  target_type: mcp
  target: oncall-runbook   # replace with the registered server id
  caller: all
default_action: block
priority: 50
rules:
  - tool: get_service_status
    action: allow
  - tool: read_recent_logs
    action: allow
  - tool: restart_service
    action: hold
  - tool: delete_volume
    action: block
```

4. Save and activate.

## Step 5: Configure environment variables

```
ARMORIQ_API_KEY=ak_your_key_here
OPENAI_API_KEY=sk-your_key_here
OPENAI_MODEL=gpt-4.1-mini
USER_EMAIL=you@your-org.com
RUNBOOK_MCP_NAME=oncall-runbook
```

## Step 6: How the graph is governed

### Why not the LangChain adapter here

The SDK's `ArmorIQLangChain` handler does work under LangGraph (it is a LangChain callback, and LangGraph passes callbacks through), and the SQL analyst recipe uses it inside `create_agent`. It just cannot pause a graph. On a hold it waits for the decision inside `on_tool_start` (`await session.await_approval(...)`), so the worker sits there until the approver answers or `approval_wait_seconds` passes. And you cannot raise `interrupt()` from inside it: the handler turns any unexpected exception into a fail closed block, and LangGraph's `GraphInterrupt` is an ordinary `Exception` subclass, so it would be caught and reported as `ARMORIQ_ENFORCEMENT_FAILED`. Errors in your `on_event` callback are swallowed the same way.

So this recipe uses the SDK one level down, the same session API the adapters are built on, from the graph's own nodes.

### The nodes

`ArmorIQGovernor` holds one ArmorIQ session per graph thread:

```python
scope = ArmorIQClient(api_key=...).for_user(user_email)
session = scope.start_session(SessionOptions(mode="sdk", default_mcp_name="oncall-runbook"))
```

**`policy_gate`** runs after every model turn. It declares the turn's tool calls as the plan (`session.start_plan(calls, goal=...)`) and asks ArmorIQ about each one (`session.check(name, args)`). Each decision (allow, hold with its `delegation_id`, or block) goes into graph state.

**`human_review`** runs only when something is held:

```python
review = interrupt({"kind": "armoriq_hold", "held": [{"tool": ..., "args": ..., "delegation_id": ...}]})
outcome = await session.await_approval(delegation_id, timeout=CONFIRM_SECONDS, interval=2.0)
```

The first time through, `interrupt()` raises, LangGraph saves the thread in the checkpointer, and `graph.ainvoke` returns with `__interrupt__` holding that payload. When the caller sends `Command(resume=...)`, LangGraph re-runs the node from the top and `interrupt()` returns the resume value. Everything before the `interrupt()` call is pure, so the re-run is safe. Then the node asks ArmorIQ for the decision. The resume payload says who reviewed it; it does not decide anything. ArmorIQ does, so a resumed thread can never run a call the approver rejected.

**`run_tools`** runs the allowed and approved calls, reports each one to ArmorIQ (`session.report`), and turns blocks, rejections, and timeouts into tool messages the model reads.

### The caller

```python
config = {"configurable": {"thread_id": thread_id}}
result = await graph.ainvoke({"messages": [HumanMessage(goal)]}, config)
while result.get("__interrupt__"):
    resume = await review(result["__interrupt__"][0].value)   # your approvals UI
    result = await graph.ainvoke(Command(resume=resume), config)
```

In `agent.py` the live `review` prints the held call and waits for Enter. In a real service the interrupt payload goes to your approvals UI (with the delegation id, so the approver can find it in ArmorIQ), the request ends, and a later request resumes the same `thread_id`.

## Step 7: Run it

```bash
python agent.py "checkout-api is throwing 502s. Find out why and fix it."
```

When the restart is held, approve or reject the delegation in the ArmorIQ dashboard, then press Enter. Try the blocked path too:

```bash
python agent.py "db-primary disk is almost full. Free up space."
```

A live model may not reach for `delete_volume` on its own. If it does, it is blocked; if it does not, ask it to delete the WAL archive volume directly to see the block.

## Honest limits

- **The approval decision lives in ArmorIQ, not in the resume payload.** The SDK has no call to approve a delegation from code, so the approver decides in the ArmorIQ dashboard and your app resumes the thread. If the thread is resumed while the delegation is still pending, `human_review` waits up to `ARMORIQ_APPROVAL_CONFIRM_SECONDS` (30 by default) and then treats it as not approved. The restart does not run; ask again.
- **The ArmorIQ session is in process memory.** The checkpointer saves the graph state, including the pending delegation id, but the session and its intent token live in `ArmorIQGovernor`. With `InMemorySaver` both live in the same process, which is what this recipe runs. If you swap in a durable checkpointer (`SqliteSaver`, `PostgresSaver`) and resume in another process, a fresh session can still read the delegation's decision, but you need to re-declare the plan before reporting or checking further calls. Test that path before relying on it.
- **This is not the shipped adapter.** It uses the public session API (`start_plan`, `check`, `await_approval`, `report`, `close`) that the adapters are built on, but you own the glue: about 100 lines in `agent.py`. ArmorIQ lists no tested LangGraph version; this recipe ran with `langgraph` 1.1.6.
- **One interrupt per turn.** If the model asks for several held calls in one turn, they are reviewed together in one interrupt. A rejection of one does not stop the allowed calls from the same turn.
- **The offline stand-in decides by tool name only.** Live ArmorIQ also sees the arguments, so you can hold restarts of `checkout-api` and allow restarts of a staging service.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ValueError: No checkpointer set` or the interrupt is lost | `interrupt()` needs a checkpointer. Keep `checkpointer=` in `builder.compile` |
| The resume runs the model again from the start | You resumed with a different `thread_id`. Use the same `config` for `ainvoke(Command(resume=...))` |
| The held call never runs after resume | The delegation was still pending in ArmorIQ. Approve it in the dashboard, then resume |
| Everything is blocked, nothing held | No rule matched. Check the policy is active and its target matches `RUNBOOK_MCP_NAME` |

## What's next

- **Persist threads.** Swap `InMemorySaver` for `SqliteSaver` from `langgraph-checkpoint-sqlite` and resume from a second process.
- **Route by argument.** Hold `restart_service` only for production services.
- **Try the LangChain adapter path.** The SQL analyst recipe shows `ArmorIQLangChain` inside `create_agent`, where a hold waits in place instead of interrupting.
