# Build a Postgres Agent with the ArmorIQ SDK

A CLI agent that answers questions about a Postgres database in plain English, with every SQL query checked against your organization's policy, and held for human review, before it runs.

Ported from the [`postgres-notes-agent` demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/postgres-notes-agent) by Naveen-6087.

## What you'll build

An agent that turns a goal like `"show me employee salaries"` into SQL and runs it through this loop:

```
goal → pick SQL → check against ArmorIQ policy → execute against Postgres MCP server → show result (or hold or denial)
```

Unlike a GitHub or filesystem MCP server, the reference Postgres MCP server exposes exactly one tool, `query`, that accepts arbitrary SQL. There is no `select_rows` versus `delete_rows` tool name to allowlist separately. So the policy holds every query for a human to read the actual SQL text before approving it, instead of guessing intent from a tool name that cannot carry it.

## Run it offline

No account, no keys, no network, and no Docker:

```bash
npm install
npm run demo:offline    # the real demo.js against local stand-ins
npm run test:offline    # the same run, scripted, as a pass or fail check
```

Offline mode swaps `@armoriq/sdk` and `src/mcpClient.js` for stand-ins in `offline/`. `demo.js` itself runs unchanged. The stand-in ArmorIQ reads this recipe's `policy.yaml`, where the `query` rule says `hold`. The stand-in Postgres MCP server returns canned rows for the `notes` and `employees` tables, read from the seed data in `db/init.sql`. Like the real server, it refuses anything that is not a `SELECT`.

The run submits three queries: a read of `notes`, a read of `employees` that includes salaries, and a `DELETE`. All three are held, and the log shows the SQL each time so a reviewer reads the query, not just its name:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline    # every hold prints REJECTED instead of APPROVED
```

## Before you start (live run)

| Requirement | Why |
|---|---|
| Node.js v18 or later, and npm | Runs the agent |
| Docker | Runs a disposable local Postgres to test against |
| An ArmorIQ account | Policy enforcement and observability |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings, API Keys**.
3. Click **Generate new key** and copy it.

You will add it to your `.env` file in Step 3. It is a single secret credential. ArmorIQ does not split keys into a publishable tier and a secret tier. Treat whichever key you generate as fully sensitive.

## Step 2: Start a local Postgres

This recipe ships `docker-compose.yml` and `db/init.sql`. The seed schema has a `salary` column, so the demo has a realistic reason to gate SQL access.

```bash
docker compose up -d
```

## Step 3: Register the Postgres MCP server and write the policy

1. In the ArmorIQ console, open **MCP Servers**, click **Add MCP Server**, name it `postgres`, and save.
2. Open **Policies, Policy Studio, Single Policy**. Set **Target Type** to `mcp_server`, **Target ID** to the `postgres` server, and **Default enforcement action** to `block`.
3. Paste the rules from `policy.yaml` into the YAML editor, then save and activate.

```yaml
name: postgres-policy
version: v0.1.0
scope:
  target_type: mcp
  target: postgres   # replace with your registered postgres MCP server's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: query
    action: hold
```

The Postgres MCP server uses the stdio transport, so it runs as a local subprocess. ArmorIQ's cloud proxy has no network path to a stdio process on your machine. That is why this recipe runs `mode: "sdk"` and spawns the server itself (`src/mcpClient.js`), instead of `mode: "proxy"`, which would try to route the call through the proxy and return a 502. The dashboard registration still matters for policy scope, vulnerability scans, and audit metadata. It just does not decide who runs the process.

> **Defense in depth.** Even if a query were approved, the reference Postgres MCP server runs every statement inside a read only transaction, so a stray `DELETE`, `UPDATE`, or `DROP` fails at the database layer whatever ArmorIQ decided. Policy and the MCP server are two independent controls.

With this policy, every `query` call is held for a human to approve after reading the actual SQL.

## Step 4: Configure and run

```bash
cp .env.example .env      # fill in ARMORIQ_API_KEY
npm install
npm run demo               # scripted CLI walkthrough
# or
npm start                  # POST http://localhost:3004/agent {"goal": "show me employee salaries"}
```

The key settings in `.env`:

| Variable | Purpose |
|---|---|
| `ARMORIQ_API_KEY` | From platform.armoriq.ai, Settings, API Keys |
| `ARMORIQ_MODE` | `sdk`: ArmorIQ decides, this process executes the approved call |
| `USER_EMAIL` | Identifies the session in ArmorIQ's observability logs |
| `POSTGRES_MCP_NAME` | Must match the name you registered in Step 3 |
| `DATABASE_URL` | Matches the port in `docker-compose.yml` |

## Pick SQL from a goal

The reference Postgres MCP server has one tool, so planning here means picking the SQL. `src/planner.js` matches a few phrases (`salary`, `employee`, anything else reads `notes`) and calls Gemini when `GEMINI_API_KEY` is set. Swap in a real LLM to SQL step later. Only `src/planner.js` changes. The enforcement loop does not.

## What a run looks like

Once the policy holds the query for review, the live loop prints the hold and a delegation id. Approve the delegation on the dashboard, or with the SDK's `session.awaitApproval(delegationId)`, then run it again. Or point the agent at a goal the policy allows outright once you have reviewed the query pattern and decided it is safe to loosen.

Open **Intent** in the console, filtered by your `USER_EMAIL`. Each run shows up as a plan with its outcome (`Completed`, `Held`, or `Blocked`) and the exact SQL text submitted for review. That is what makes holding arbitrary SQL usable: a reviewer is not approving "a query", they are reading the query.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every query is blocked, never held | The policy is not yet activated, or the `target` in `policy.yaml` does not match the registered server's id |
| `dispatch()` or `mode: "proxy"` returns a 502 | The Postgres MCP server uses stdio, which ArmorIQ's cloud proxy cannot reach. Use `mode: "sdk"` and execute the call yourself |
| `ECONNREFUSED` connecting to Postgres | `docker compose up -d` has not finished starting, or the port in `DATABASE_URL` does not match `docker-compose.yml` |
| `npx` hangs on the first call | It is downloading `@modelcontextprotocol/server-postgres`. Wait it out once, it is cached after |
| A `DELETE` or `UPDATE` fails even though the policy allowed it | The MCP server runs every statement in a read only transaction by design. This is a second, independent control, not a bug |

## What's next

- **Tier the policy differently.** This recipe holds every query because the tool surface cannot tell safe SQL from unsafe SQL by name. If your team is comfortable pre approving read only patterns, look at the amount threshold and time restriction rule types in Policy Studio.
- **Combine with another MCP server.** One ArmorIQ intent plan can span several MCP servers in a single signed token. See the Cross-MCP Research recipe in this repo.
