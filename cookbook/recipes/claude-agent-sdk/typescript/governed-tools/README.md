# Build a Claude Agent SDK Release Assistant with the ArmorIQ SDK

A release assistant built on Anthropic's [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), with every tool call checked by ArmorIQ before it runs. Claude can list releases and read build status freely. Deploying to production waits for a human. Deleting an environment is blocked.

The ArmorIQ check lives in one place: the Agent SDK's `canUseTool` permission callback.

## What it demonstrates

- **Custom tools, in process.** The four release tools are defined with the Agent SDK's `tool()` and served by `createSdkMcpServer()` (`src/tools.mjs`). No separate MCP server process.
- **ArmorIQ in `canUseTool`** (`src/governance.mjs`). For each tool call Claude makes:
  1. The call joins the turn's plan, and `session.startPlan()` captures it and mints a signed intent token (on later calls in the turn it records the plan growth against the same token).
  2. `session.check(tool, args, userEmail)` asks ArmorIQ for allow, hold, or block. The session runs in `mode: "sdk"`: ArmorIQ decides, and the tool still runs here, in process.
  3. Allow returns `{ behavior: "allow" }`. Block returns `{ behavior: "deny", message }`, and Claude sees the reason and can tell the user. Hold calls `session.awaitApproval()` and allows the call only after an explicit approval in the ArmorIQ console.
  4. After a tool runs, its handler calls `session.report()` so the result lands in the audit log.
- **No built-ins.** `tools: []` gives the agent no Bash, file, or web tools, `disallowedTools` names them again for good measure, and `canUseTool` denies any tool that is not one of this app's own in-process tools.

| Tool | Policy | What you see |
|---|---|---|
| `list_releases` | allow | runs |
| `get_build_status` | allow | runs |
| `deploy_to_production` | hold | waits for a human, runs only if approved |
| `delete_environment` | block | denied, Claude is told why |

## Run it offline

No account, no keys, no network, and no Claude Code process:

```bash
npm install
npm run demo:offline    # the real src/agent.mjs against local stand-ins
npm run test:offline    # the same run, approved and rejected, as a pass or fail check
```

Offline mode swaps two imports with Node module hooks (`offline/register.mjs`, `offline/hooks.mjs`):

- `@anthropic-ai/claude-agent-sdk` becomes `offline/claude-agent-sdk.mjs`, a scripted Claude. Its `query()` replays one turn (list releases, check the build, deploy, delete the old staging environment) through the **same** `canUseTool` callback and the **same** tool handlers the real code passes in, and it follows the SDK's permission order: `disallowedTools` removes a tool, `allowedTools` skips `canUseTool`, everything else asks. The script is fixed, so the prompt does not change what it does.
- `@armoriq/sdk` becomes `offline/armoriq-sdk.mjs`, which decides from this recipe's `policy.yaml`: a rule that names the tool wins, and anything else gets `default_action`. Change a rule and the offline result changes with it.

`src/` runs unchanged. Every decision prints one `[armoriq]` line:

```text
[armoriq] check release__list_releases: ALLOWED (policy release-assistant-policy: list_releases -> allow)
[armoriq] check release__deploy_to_production: HELD (policy release-assistant-policy: deploy_to_production -> hold)
[armoriq] hold release__deploy_to_production: APPROVED
[armoriq] check release__delete_environment: BLOCKED (policy release-assistant-policy: delete_environment -> block)
```

Play the approver who says no:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline    # the deploy prints REJECTED and never runs
```

## This is not ArmorClaude

ArmorIQ has two ways to govern Claude, and they sit at different layers.

- **ArmorClaude** is a plugin for the **Claude Code host**: the `claude` CLI and Claude Desktop that you, a developer, work in. You install it once, and it governs the coding agent's own tools (Bash, Edit, Write, MCP) through Claude Code hooks. You write no code. Its recipes live under `claude-code/`.
- **This recipe** is for **your own product built on the Claude Agent SDK**: a support bot, a release assistant, an ops agent you ship to your users. You define the tools, you own the agent loop, and you call the ArmorIQ SDK yourself from `canUseTool`.

Use this pattern when:

- the agent is part of your application, runs on your servers, and acts for your end users (each check carries that user's email, so policy and audit are per user);
- the tools are your own business actions (deploy, refund, delete) rather than a developer's shell and files;
- you want the decision in code you control: what to tell Claude on a block, how long to wait for an approver, what to do on a timeout.

Use ArmorClaude when the thing to govern is Claude Code itself on a developer's machine.

## Prerequisites (live run)

1. An ArmorIQ API key (dashboard, or `armoriq login` with the Python CLI; both SDKs read the same credentials file).
2. The policy. Open **Platform, Policies, Policy Studio, Single Policy**, paste the rules from `policy.yaml`, and scope it to the `release` server. Each check sends `mcp: "release"` and the bare tool name (for example `deploy_to_production`).
3. Claude credentials for the Agent SDK, usually `ANTHROPIC_API_KEY`. The SDK runs Claude Code under the hood; its platform binary comes in through `npm install`.

## Run it live

```bash
cp .env.example .env      # fill in ARMORIQ_API_KEY, ANTHROPIC_API_KEY, USER_EMAIL
npm install
npm start -- "Ship 2.4.0 to production, then clean up the staging-old environment."
```

When Claude asks to deploy, the agent prints the delegation id and waits up to `ARMORIQ_APPROVAL_WAIT_SECONDS` (default 300) for someone to approve it in the ArmorIQ console. The release system in `src/tools.mjs` is in memory; replace the handler bodies with calls to your CI/CD API.

## Honest limits

- **`canUseTool` only sees calls that need permission.** A tool listed in `allowedTools`, a matching allow rule from Claude settings, or `permissionMode: "bypassPermissions"` skips the callback, and so skips ArmorIQ. This agent leaves its tools out of `allowedTools`, keeps `permissionMode: "default"`, and passes `settingSources: []` so no `~/.claude` or project rule can pre-approve a tool. Keep it that way, or move the check into a `PreToolUse` hook, which runs for every call.
- **The plan grows one call at a time.** Claude reveals its plan as it goes, not up front, so each new call is added to the plan before it is checked. ArmorIQ records every growth, but this is weaker than a plan declared before the first tool runs.
- **Waiting blocks the turn.** `awaitApproval()` polls until the approver decides or the wait runs out; the Claude turn sits on that call. A timeout is treated as a rejection. A cancelled turn stops the wait, but the delegation stays open in the console.
- **Docs gap.** The TypeScript SDK page lists `forUser()` and session mode as "not yet" in TypeScript. `@armoriq/sdk` 0.8.24 ships both (`ArmorIQClient.forUser`, `ArmorIQSession`), and this recipe uses them. It still passes `userEmail` on every `check()` and `awaitApproval()`, which is what the docs recommend.
- **Not run live yet.** The offline mode runs the real governance code, but against stand-ins for Claude and ArmorIQ. A live run against both services is still to do (it is `community` tier).
