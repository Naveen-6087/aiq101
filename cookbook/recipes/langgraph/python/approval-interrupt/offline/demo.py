"""Scripted offline walkthrough: two on-call requests through the real agent.py graph.

    .venv/bin/python offline/demo.py

The first request is held: the graph interrupts, the checkpointer saves the thread, and an
automatic "reviewer" resumes it with Command(resume=...). Set OFFLINE_APPROVAL=reject to have
ArmorIQ (the stand-in) reject the hold instead of approving it.
Needs no API keys and no network, and never reads stdin.
"""

import asyncio
import json

import register  # noqa: F401  installs the stand-ins; must come before agent

import agent

REQUESTS = [
    ("Investigate and fix: reads allowed, restart held", "checkout-api is throwing 502s. Find out why and fix it."),
    ("Disk pressure: delete blocked", "db-primary disk is almost full. Free up space."),
]


async def offline_reviewer(payload: dict) -> dict:
    """Stands in for your approvals UI: show the held calls, then resume the thread."""
    for item in payload["held"]:
        print(f"  [reviewer] sees HELD {item['tool']} {json.dumps(item['args'])} delegation={item['delegation_id']}", flush=True)
    return {"reviewed_by": "oncall-lead@example.com"}


for title, goal in REQUESTS:
    print(f"\n##### {title}", flush=True)
    print(f"Goal: {goal}\n", flush=True)
    answer = asyncio.run(agent.run(goal, review=offline_reviewer))
    print("--------------------------------------------------")
    print("Final answer:", answer)
    print("--------------------------------------------------", flush=True)
print("\nDone.", flush=True)
