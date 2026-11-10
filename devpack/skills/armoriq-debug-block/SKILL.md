---
name: armoriq-debug-block
description: Diagnose why an agent tool call was blocked, held or unexpectedly allowed by ArmorIQ or armord, and fix the policy or the agent. Use when a user pastes an [armoriq] log line, a "blocked by policy" message, an unexpected approval prompt, or says enforcement is not working.
---

# Debug an ArmorIQ block, hold or missing enforcement

Work from the evidence to the rule. Do not loosen a policy to make an error go away until you know which rule fired and the user agrees the action should be allowed.

## 1. Read the log contract

Cookbook recipes and offline stand-ins print one event per line:

```
[armoriq] plan: <goal> -> <tool>, <tool>
[armoriq] check <tool>: ALLOWED (<reason>)
[armoriq] check <tool>: HELD (<reason>)
[armoriq] check <tool>: BLOCKED (<reason>)
[armoriq] hold <tool>: APPROVED | REJECTED
[armoriq] report <tool>: <status>
```

`<reason>` names the rule, for example `policy release-desk-policy: delete_environment -> block`. The Intent Gateway reports `Tool call "<tool>" was blocked by policy: block:<tool>#0` at the end of the reply (`<tool>#<n>` is the rule position). armord reasons look like `block by <policyId>#st-bash-0 (agent layer)`; the part after `#` is the statement id. Other armord reasons: `policy-bundle-unavailable`, `policy-bundle-stale`, `agent_inactive`, `no_active_policy`, `intent drift`, `schema_drift` (tool definition changed), and self-protection blocks.

## 2. Find the verdict and the rule

```bash
armord logs --verdict block -n 20          # recent decisions with reasons
armord decide Bash '{"command":"<the command>"}'   # replays one call; prints verdict, rule, derived fields
armord status                              # loaded policies, remote bundle state, pending holds
armord doctor                              # policies compile? daemon up? bundle reachable? audit chain intact?
```

`armord decide` prints `derived` fields (program, hosts, paths, pipeToShell, obfuscated, ...). Match them against the `when` conditions of the rule named in the reason: most surprises are a derived field you did not expect (a read of `~/.ssh/id_rsa` inside a pipeline, a hidden `rm`, an obfuscated command).

Without armord, use the dashboard: Observability for the trace, Policies for the rule, Held Actions for pending approvals.

## 3. Classify

| Symptom | Likely cause | Fix |
|---|---|---|
| Blocked, rule is a `block` you wrote | Working as designed | Change the agent's plan, or narrow the rule with a more specific allow before it, after the user agrees |
| Held and nothing happens | No approver acting; Gateway treats a hold as a block today; armord hold timed out (counts as rejected) | Approve with `armord watch` / `armord approve <id>` or in the dashboard; for CI use a policy that never holds (`armor-ci`) |
| Blocked with `policy-bundle-unavailable` / `stale` | armord cannot reach the control plane (fails closed after the bundle is 5 minutes old) | Check network and API key (`armord doctor`); `ARMORD_ON_STALE=last-known` only if the user accepts the risk |
| Allowed but should be blocked | Agent has no active policy (`no_active_policy` allows); rule keyed to a different tool name; section (`files`, `network`) not written | Activate a policy; use the host's tool name or the bare MCP tool name; add the section |
| `IntentMismatchException` (SDK) | `invoke` params or action differ from the signed plan | Re-plan and re-sign, or fix params to match the plan |
| `TokenExpiredException` | Intent token outlived `validity_seconds` | Mint a new token for the same plan |
| `PolicyBlockedException` at token issuance | A planned step is already denied | Re-plan without it; see recipe `sdk/python/handle-a-block` |
| Gateway: tool call silently missing | A blocked call is removed from the reply | Read the trailing "was blocked by policy" note |

## 4. Fix and prove it

1. Edit the policy, then add or extend a case in the cases file for the exact call that surprised the user (both the blocked and the allowed side).
2. `armord policy test <cases.yaml> <policy.yaml>` must pass.
3. Re-run the original call (`armord decide ...` or the agent) and show the new verdict and reason.

Report: the call, the verdict, the rule that decided, why, what you changed, and the test result. If the right answer is "the block is correct", say that and stop.
