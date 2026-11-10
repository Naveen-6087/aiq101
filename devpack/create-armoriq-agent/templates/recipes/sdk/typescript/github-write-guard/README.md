# Build a GitHub Write Guard with the ArmorIQ SDK

A GitHub assistant planned by Gemini and governed by ArmorIQ. Reads (search, list, get file contents) are allowed. Writes (pull requests, file edits) are held until a human approves. `delete_repository` is blocked.

Adapted from the [github-agent demo](https://github.com/Naveen-6087/aiq-demos/tree/main/demos/github-agent) by Naveen-6087. It sits next to the cookbook's read only GitHub agent and shows the other half: what happens when an agent can change things.

## What you'll build

```
goal → planner picks tool call(s) → ArmorIQ checks each one → allow: run it
                                                            → hold: wait for a human, then run or skip
                                                            → block: refuse
```

| Tool | Policy action | What happens |
|---|---|---|
| `search_repositories`, `list_commits`, `list_issues`, `get_file_contents` | allow | Runs immediately |
| `create_pull_request`, `create_or_update_file` | hold | Waits for approval in the ArmorIQ console |
| `delete_repository` | block | Never runs |
| anything else | block (default) | Never runs |

## Run it offline

Offline mode runs the real `demo.js` with local stand-ins for ArmorIQ, GitHub, and the planner (in `offline/`). It needs no keys, no token, and no network.

```bash
npm install
npm run demo:offline    # one goal that searches, opens a pull request, then tries to delete the repo
npm run test:offline    # approves the held call, then runs again and rejects it
```

The offline ArmorIQ stand-in reads this recipe's `policy.yaml`: it looks for a rule by tool name, then falls back to `default_action`. Change a rule in that file and the offline result changes with it. A held call is approved after a short pause, standing in for a person in the console. To play the person who says no:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline
```

The held call is then rejected, never runs, and the agent carries on with the next step.

## Before you start

1. A `github` MCP server registered on your ArmorIQ dashboard (**MCP Servers → Add MCP Server**).
2. An ArmorIQ API key.
3. A GitHub personal access token with `repo` scope.
4. A Gemini API key. It is optional: without one, a small keyword planner is used.
5. The `github-policy` created against the registered server. The rules are in `policy.yaml`.

### Why `mode: "sdk"`

The GitHub MCP server runs as a local stdio process, which ArmorIQ's cloud proxy cannot reach. In `mode: "sdk"` ArmorIQ only decides allow, hold, or block, and this process runs each approved call itself, with your token. The token never leaves your machine.

## The policy

```yaml
name: github-policy
default_action: block
rules:
  - tool: search_repositories
    action: allow
  - tool: list_commits
    action: allow
  - tool: list_issues
    action: allow
  - tool: get_file_contents
    action: allow
  - tool: create_pull_request
    action: hold
  - tool: create_or_update_file
    action: hold
  - tool: delete_repository
    action: block
```

Author it in **Policies → Policy Studio → Single Policy** with Target Type `mcp_server` and Target ID set to your registered `github` server. See `policy.yaml` for the full file.

## Run it

```bash
cp .env.example .env     # fill in ARMORIQ_API_KEY, GITHUB_PERSONAL_ACCESS_TOKEN, GITHUB_USER
npm install
npm run demo "search my repositories"
npm run demo "open a pull request"      # held until you approve it in the console
npm run demo "delete the repository"    # blocked
# or serve the same loop over HTTP
npm start
```

When a call is held, `demo.js` prints `[HELD]` and then waits for the decision with `session.awaitApproval(...)`. It waits up to five minutes (set `ARMORIQ_APPROVAL_WAIT_SECONDS` to change that). Only an explicit approval runs the call. A rejection or a timeout skips it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Everything gets blocked | Default policy is `block` with no matching rule. Check the policy covers the tool names the agent calls |
| A held call never finishes | Nobody approved it yet. Open the ArmorIQ console, find the pending approval for your `USER_EMAIL`, and decide |
| `401` from GitHub calls | The token is missing the `repo` scope, or has a trailing space in `.env` |
| MCP connection times out on first run | `npx` is downloading the GitHub MCP server package. Retry once it is cached |
