# Build a Delegating CrewAI Crew with the ArmorIQ SDK

A step by step guide to giving a CrewAI sub-agent less authority than its parent. The incident lead holds an ArmorIQ intent token for the whole incident. It hands its log analyst a delegated token that only covers reading metrics and logs. Both agents carry the exact same toolbox, and when the analyst reaches for the restart button, ArmorIQ refuses it, even though the policy allows that restart and the lead makes it a minute later.

This is the lower level pattern the CrewAI crypto recipe (`crewai/python/crypto-crew`) points to in its Limitations section: drive the ArmorIQ client yourself from inside each tool's `_run`, instead of wrapping the crew in `ArmorIQCrew`, so you get a decision per call and per agent.

## What you'll build

```
incident lead:  capture_plan → get_intent_token (metrics, logs, restart)
                     │
                     └─ delegate(allowed_actions=[get_metrics, search_logs]) → analyst token
log analyst:    get_metrics ✓   search_logs ✓   restart_service ✗ (not delegated)
incident lead:  restart_service ✓ (its own token)
```

| Tool | Policy | Incident lead's token | Log analyst's delegated token |
|---|---|---|---|
| `get_metrics` | allow | allowed | allowed |
| `search_logs` | allow | allowed | allowed |
| `restart_service` | allow | allowed | refused, not in `allowed_actions` |

The policy is the same for both. The difference is entirely in the token each agent holds.

## Run it offline

No accounts, keys, Docker, or network needed. Offline mode runs the real `crew.py`, real CrewAI agents and tasks, the real `armoriq_tools.py` (the `BaseTool._run` that calls `invoke`), and real Ed25519 key generation for the analyst. Two things are stand-ins, both in `offline/`: the ArmorIQ client, which reads `policy.yaml`, enforces the delegated token's `allowed_actions`, and runs allowed calls on the tool functions in `incident_ops_mcp.py`, and the Gemini model, which is scripted.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python offline/demo.py     # analyst reads, is refused the restart, lead restarts
.venv/bin/python offline/test.py     # the same run as a pass or fail check
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`. The armoriq-sdk 0.8.18 package needs Python 3.10 to 3.13.

The run prints the shared log lines, plus one for the delegation:

```
[armoriq] plan: Respond to the checkout latency alert -> get_metrics, search_logs, restart_service
[armoriq] delegate log-analyst: get_metrics, search_logs
[armoriq] check get_metrics: ALLOWED (policy incident-ops-policy: get_metrics -> allow; delegated to log-analyst)
[armoriq] check search_logs: ALLOWED (policy incident-ops-policy: search_logs -> allow; delegated to log-analyst)
[armoriq] check restart_service: BLOCKED (delegation log-analyst: restart_service is not in allowed_actions [get_metrics, search_logs])
[armoriq] check restart_service: ALLOWED (policy incident-ops-policy: restart_service -> allow; parent token)
[armoriq] report restart_service: success
```

The refusal goes back to the analyst as a tool observation (`REFUSED by ArmorIQ: log-analyst may not call restart_service ...`), so it reports what it found and hands the restart to the lead instead of failing the crew. Remove `restart_service` from `CHILD_ACTIONS` in `crew.py` (or add it) and the offline result changes with it. `OFFLINE_APPROVAL=reject` is read like everywhere else, but this policy holds nothing.

## Before you start

| Requirement | Why |
|---|---|
| Python 3.10 to 3.13 | Runs the crew |
| An ArmorIQ account | Tokens, delegation, policy, audit |
| A Gemini API key | Drives both agents |
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

`requirements.txt` pins every package with `==`. CrewAI stays on 1.15, the range the SDK's `crewai` extra allows (`crewai<1.16,>=1.15`). CrewAI 1.15 needs `mcp<2`, so the MCP server here uses `FastMCP` from `mcp==1.30.0`, not the `MCPServer` name from `mcp` 2.

## Step 3: Run the MCP server where ArmorIQ can reach it

`invoke()` sends each call to ArmorIQ's cloud proxy, which forwards it to the server URL you registered. A process on your laptop is not reachable from there, so run the server over streamable HTTP and expose it with a tunnel, or deploy it:

```bash
python incident_ops_mcp.py --http      # serves http://127.0.0.1:8000/mcp
```

## Step 4: Register the server and write the policy

1. In the ArmorIQ console, open **MCP Servers**, click **Add MCP Server**, name it `incident-ops`, and point it at the public URL from Step 3.
2. Open **Policies → Policy Studio → Single Policy**, set **Target Type** to `mcp_server` and **Target ID** to the `incident-ops` server.
3. Set **Default enforcement action** to `block` and paste `policy.yaml` into the YAML editor.
4. Save and activate.

Note that the policy allows `restart_service`. Nothing in it singles out the analyst. That is the point: delegation narrows authority below what policy grants.

## Step 5: How the crew is built

### The lead's token

`crew.py` captures one plan for the whole incident and mints one token for it, for the end user the crew acts on behalf of:

```python
plan = client.capture_plan(llm=model_name, prompt=..., plan={"goal": ..., "steps": [
    {"action": "get_metrics", "mcp": MCP_NAME, "params": {"service": "checkout"}},
    {"action": "search_logs", "mcp": MCP_NAME, "params": {"service": "checkout"}},
    {"action": "restart_service", "mcp": MCP_NAME, "params": {"service": "checkout"}},
]})
lead_token = client.get_intent_token(plan, validity_seconds=1800, user_email=user_email)
```

### The delegation

The analyst gets its own Ed25519 key, and the lead delegates a token bound to that key, limited to two actions and 15 minutes:

```python
analyst_key = Ed25519PrivateKey.generate()
delegation = client.delegate(
    lead_token,
    delegate_public_key=public_key_hex(analyst_key),
    validity_seconds=900,
    allowed_actions=["get_metrics", "search_logs"],
    target_agent="log-analyst",
    subtask={"goal": "Diagnose the checkout latency alert", "service": "checkout"},
)
analyst_token = delegation.delegated_token
```

A delegate can only receive a subset of what its parent holds. Asking for an action outside the parent's plan fails the delegation itself.

### The tools

`armoriq_tools.py` has one `BaseTool` subclass. Each instance is bound to an `Authority` (the agent's label, the client, its token, the user, and the MCP name), and `_run` is the raw client pattern from the ArmorIQ docs:

```python
def _run(self, **params) -> str:
    auth = self.authority
    try:
        result = auth.client.invoke(mcp=auth.mcp, action=self.action, intent_token=auth.token,
                                    params=params, user_email=auth.user_email)
        return json.dumps(result.result, default=str)
    except PolicyBlockedException as e:
        return f"REFUSED by ArmorIQ: {auth.agent} may not call {self.action} ({e.reason or e}). ..."
    except ArmorIQException as e:
        return f"REFUSED by ArmorIQ: {type(e).__name__}: {e}"
```

Both agents get `incident_tools(authority)`, the same three tools, each bound to that agent's token. Returning the refusal as text (instead of raising) lets CrewAI hand it to the model as an observation, so the agent adapts instead of the crew failing.

The crew runs with `cache=False`. CrewAI caches tool results by tool name and input across the crew, and without that the analyst's refused `restart_service(checkout)` could be served from cache when the lead makes the same call.

## Step 6: Run it

```bash
python crew.py
```

Open **Intent** in the ArmorIQ console, filtered by your `USER_EMAIL`, to see the lead's plan, the delegation, and each call with the token it used.

## Limitations and honest notes

* **Not run live for this recipe.** The offline run is checked in CI. The live path follows the SDK 0.8.18 source and the `delegate()` docs but has not been run against a deployed incident-ops server.
* **`delegate()` is marked legacy in the SDK source.** In 0.8.18 the code comment says to prefer `delegate_subtree()`, which bounds a child to a subtree of the parent's plan instead of a list of actions. This recipe uses `delegate()` because `allowed_actions` is the clearest way to show narrowing; the tool code does not change if you switch.
* **How the refusal arrives live is not confirmed.** The offline stand-in raises `PolicyBlockedException` for an action outside `allowed_actions`. Live, the proxy could also answer with a token error (`InvalidTokenException`, HTTP 401 or 403). The tool catches the base `ArmorIQException` too, so either way the analyst gets a refusal, not a crash.
* **A delegated token without an expiry is already expired.** The SDK builds the delegated token with `expires_at` from the response, defaulting to 0 if the backend omits it, and `invoke()` checks expiry before sending. If every analyst call fails with `TokenExpiredException`, inspect `delegation.delegated_token.expires_at`.
* **The offline stand-in runs the tool functions in process.** It calls the functions in `incident_ops_mcp.py` directly instead of going over MCP, which is the proxy's job live.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `DelegationException` at startup | The delegation endpoint refused the request, or the parent token expired. The crew prints the reason and stops |
| The analyst's reads are refused too | `allowed_actions` does not match the action names in the plan, or the delegated token has no expiry (see Limitations) |
| `MCPInvocationException ... (HTTP 502)` | The proxy cannot reach the registered server URL. See Step 3 |
| `No matching distribution found for armoriq-sdk==0.8.18` | Your Python is 3.14 or newer. Use 3.10 to 3.13 |
| Windows console shows `'charmap' codec can't encode character` | Cosmetic. CrewAI prints emoji your code page cannot render. The offline demo switches stdout to UTF-8 for this reason |

## What's next

* **Handle refusals in a plain loop.** The `sdk/python/handle-a-block` recipe runs the same plan, token, invoke calls with no framework and shows the recovery for each ArmorIQ exception.
* **Delegate per task.** Mint a delegation per CrewAI task instead of per agent, so a sub-agent's authority ends when its task does.
* **Chain it.** A delegated token can be delegated again with an even narrower `allowed_actions`, for a three level crew.
