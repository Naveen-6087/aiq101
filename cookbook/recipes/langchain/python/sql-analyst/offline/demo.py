"""Scripted offline walkthrough: three analyst requests through the real agent.py.

    .venv/bin/python offline/demo.py

Set OFFLINE_APPROVAL=reject to reject every held call instead of approving it.
Needs no API keys and no network. Uses a fresh throwaway copy of the database each run.
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

import register  # noqa: F401  installs the stand-ins; must come before agent

import agent

REQUESTS = [
    ("Read only question: allowed", "Which product made the most revenue in October 2026? Show the top three."),
    ("Write: held for approval", "Order 1042 was returned. Mark it as refunded."),
    ("Prompt injection in the data", "Summarize this week's customer feedback."),
]

workdir = Path(tempfile.mkdtemp(prefix="sql-analyst-offline-"))
os.environ["ANALYTICS_DB"] = str(workdir / "analytics.db")
try:
    for title, goal in REQUESTS:
        print(f"\n##### {title}", flush=True)
        sys.argv = ["agent.py", goal]
        agent.main()
finally:
    shutil.rmtree(workdir, ignore_errors=True)
print("\nDone.", flush=True)
