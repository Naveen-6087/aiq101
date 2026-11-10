---
name: armord
description: How to behave when armord (the local ArmorIQ policy daemon) blocks or holds a tool call.
---

armord checks every tool call before it runs and answers allow, hold or block.

- **block**: the policy forbids the call. Do not retry it, rephrase it to slip past the rule, or
  reach the same result through another tool. Tell the user what was blocked and why.
- **hold**: a person has to approve. Claude Code shows its own prompt; wait for the answer. If a
  hold id is mentioned, the user can approve with `armord approve <id>`.
- Never edit armord's policy files, hook settings or keys (`~/.armoriq/**`, `.claude/settings.json`).
  Those writes are protected and need the user's approval.
- If you registered an intent plan (`register_intent_plan`), stay inside it. Calls outside the plan
  are refused as intent drift.

Useful commands for the user: `armord status`, `armord holds`, `armord approve <id>`,
`armord policy check <file>`.
