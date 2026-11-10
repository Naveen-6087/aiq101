"""Scripted offline walkthrough: five release requests through the real agent.py loop.

    .venv/bin/python offline/demo.py

Set OFFLINE_APPROVAL=reject to reject the held production deploy instead of approving it.
Needs no API keys, no Docker, and no network.
"""

import os
import sys

import register  # noqa: F401  installs the stand-ins; must come before agent

import agent

REQUESTS = [
    ("Allowed: deploy to staging", "Deploy checkout build 512 to staging", None),
    ("Held: deploy to production", "Deploy checkout build 512 to production", None),
    ("Blocked, then re-planned", "Tear down the idle staging-eu environment", None),
    ("Off plan step, then re-planned", "Deploy payments build 77 to staging", None),
    # A 2 second token and a 3 second smoke test: the token runs out mid plan.
    ("Expired token, then re-minted", "Run smoke tests on checkout build 512, then deploy it to staging", "2"),
]

for title, goal, token_seconds in REQUESTS:
    print(f"\n##### {title}", flush=True)
    os.environ["TOKEN_VALIDITY_SECONDS"] = token_seconds or "300"
    sys.argv = ["agent.py", goal]
    agent.main()
print("\nDone.", flush=True)
