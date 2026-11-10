---
description: List tool calls armord is holding for a human decision
allowed-tools: Bash(armord holds:*)
---

Run `armord holds` and list each pending hold with its id, tool and reason. Do not approve or
reject anything yourself: only the user decides, with `/armord-approve <id>` or `armord reject <id>`.
