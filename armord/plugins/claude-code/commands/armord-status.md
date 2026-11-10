---
description: Show armord's loaded policy, decision counts and latency
allowed-tools: Bash(armord status:*)
---

Run `armord status` and summarise the result: which policy set is loaded, whether a remote ArmorIQ
bundle is current, how many calls were allowed, held and blocked, and any policy problems. If the
command cannot reach the daemon, say so and suggest `armord start`.
