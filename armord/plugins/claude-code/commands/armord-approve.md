---
description: Approve a held tool call by id (the user must type this command)
argument-hint: <hold-id>
allowed-tools: Bash(armord approve:*)
disable-model-invocation: true
---

Run `armord approve $ARGUMENTS` and report the result. This command is user-initiated only: never
run it on your own to get past a held call.
