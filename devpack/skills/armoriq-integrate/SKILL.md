---
name: armoriq-integrate
description: Add ArmorIQ policy enforcement to an existing AI agent. Use when the user wants to govern an agent's tool calls with ArmorIQ, asks which integration to use (SDK, Intent Gateway, a coding-agent plugin such as ArmorClaude or ArmorCodex, or the local armord daemon), or wants to verify that ArmorIQ is enforcing.
---

# Integrate ArmorIQ into an existing agent

ArmorIQ checks each tool call an agent makes against a policy and returns allow, hold (wait for a human) or block. Pick the integration by how the agent runs, make the smallest change, then prove enforcement with a call the policy blocks.

If the docs MCP server (`armoriq-docs`) is available, use `search_docs` and `read_doc` for exact current syntax; do not guess method names. Otherwise read https://docs.armoriq.ai.

## 1. Choose the integration

| The agent is... | Use | Change required |
|---|---|---|
| Claude Code / Claude Desktop | ArmorClaude plugin | `curl -fsSL https://armoriq.ai/install_armorclaude.sh \| bash` (or `claude plugin marketplace add armoriq/armorClaude`, then `claude plugin install armorclaude@armoriq`) |
| Codex | ArmorCodex plugin | `curl -fsSL https://armoriq.ai/install_armorcodex.sh \| bash` |
| Gemini CLI / GitHub Copilot | ArmorGemini / ArmorCopilot | the installers on docs.armoriq.ai (search "armorgemini", "armorcopilot") |
| Any agent using the OpenAI or Anthropic SDK | Intent Gateway | change one base URL, no SDK |
| A Python or Node agent that calls MCP tools | ArmorIQ SDK | `pipx install armoriq-sdk` / `npm install @armoriq/sdk` |
| Cursor, OpenHands, or anything local that needs a decision in under a millisecond, offline | `armord` (see the `armord-setup` skill) | `armord install <host>` |

Ask the user which applies if it is not obvious from the code (look for `openai`, `anthropic`, `langchain`, `crewai`, MCP client code, or a `.claude/` / `.cursor/` folder).

## 2. Prerequisites in the ArmorIQ dashboard

- An organization and an API key (`armoriq login` stores one in `~/.armoriq/credentials.json`). Never write a key into source files, tests or docs; read it from the environment.
- The agent registered, with an active policy. With no active policy ArmorIQ allows every call and only records it, so enforcement tests will look like they pass. Policy format: see the `armoriq-write-policy` skill.

## 3. Wire it in

**Intent Gateway** (no SDK). Create a gateway key under Gateway in the dashboard, choose the agent, then point the SDK you already use at the gateway and keep your provider key unchanged:

```bash
OPENAI_BASE_URL=https://gw.armoriq.ai/v1/t/<gateway-key>/a/<agent-id>
ANTHROPIC_BASE_URL=https://gw.armoriq.ai/v1/t/<gateway-key>/a/<agent-id>
```

The base URL contains the key: keep it out of source control. A blocked call is missing from the model reply and the reply ends with a note such as `Tool call "record_payment" was blocked by policy: block:record_payment#0`. A hold is treated as a block today (the approval request is created, but approving it does not release the agent's next attempt). Pick "No agent" when creating the key to record traffic without blocking (monitor mode).

**SDK (Python)**, the plan, token, invoke loop:

```python
from armoriq_sdk import ArmorIQClient   # pip install armoriq-sdk
plan = client.capture_plan(llm="gpt-4o", prompt=goal, plan={"goal": goal, "steps": [{"action": "list_files", "mcp": "fs-mcp", "params": {...}}]})
token = client.get_intent_token(plan, validity_seconds=300)
result = client.invoke(mcp="fs-mcp", action="list_files", intent_token=token, params={...})
```

`plan` must contain `steps`, and `invoke` params must match the signed plan (otherwise `IntentMismatchException`). Use `invoke_with_policy(mcp, action, intent_token, params, options)` with `InvokeOptions` when a hold should wait for approval and retry. Handle `PolicyBlockedException`, `PolicyHoldException`, `DelegationException`, `IntentMismatchException` and `TokenExpiredException` instead of letting the first block crash the agent; the cookbook recipe `sdk/python/handle-a-block` shows each recovery. The TypeScript SDK is `new ArmorIQClient({ apiKey })` from `@armoriq/sdk`; copy a recipe such as `sdk/typescript/filesystem-notes`. For LangChain, CrewAI, Vercel AI SDK, OpenAI Agents, LangGraph or the Claude Agent SDK, find a matching recipe (`find_recipe` in the docs MCP, or the cookbook repo) and scaffold it with `create-armoriq-agent`.

**Plugins** install and read their policy from the dashboard; there is no code change in the agent.

## 4. Verify enforcement (do not skip)

1. Pick one tool the policy blocks and one it holds. Ask the agent to use each.
2. Confirm the outcome: blocked call absent or refused, held call waiting in the dashboard approvals, allowed call runs.
3. Look at the trace: dashboard Observability, or `armoriq logs`, or for armord `armord logs --verdict block`.
4. Offline or in CI, use the cookbook offline stand-ins: they print the `[armoriq] check <tool>: ALLOWED|HELD|BLOCKED (reason)` contract and `OFFLINE_APPROVAL=reject` turns holds into rejections.

If the block never appears, check, in order: the agent has an active policy; the rule names the tool exactly as the host reports it (MCP tools are `mcp__<server>__<tool>` in coding agents); the policy is not in monitor/shadow mode. Then use the `armoriq-debug-block` skill.

Report what changed, which integration was chosen and why, and the verification result. Do not claim enforcement works until step 4 showed a block.
