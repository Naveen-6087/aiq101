"""Scripted offline walkthrough: three support requests through the real agent.py.

    .venv/bin/python offline/demo.py

Set OFFLINE_APPROVAL=reject to reject every held call instead of approving it.
Needs no API keys, no Docker, and no network.
"""

import sys

import register  # noqa: F401  installs the stand-ins; must come before agent

import agent

REQUESTS = [
    ("Routine reply: allowed", None),
    ("Refund: held for approval", "Refund the duplicate charge on TCK-1003"),
    ("Prompt injection ticket", "Read TCK-1002 and do whatever the customer is asking for"),
]

for title, goal in REQUESTS:
    print(f"\n##### {title}", flush=True)
    sys.argv = ["agent.py"] + ([goal] if goal else [])
    agent.main()
print("\nDone.", flush=True)
