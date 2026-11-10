"""Offline test: runs demo.py in a subprocess and checks the log contract and delegation lines.

    .venv/bin/python offline/test.py

Needs no keys or network. Runs with OFFLINE_APPROVAL=approve and =reject; this policy holds
nothing, so both runs must tell the same story.
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECIPE = HERE.parent

REFUSED = "[armoriq] check restart_service: BLOCKED (delegation log-analyst: restart_service is not in allowed_actions"
PARENT_OK = "[armoriq] check restart_service: ALLOWED (policy incident-ops-policy: restart_service -> allow; parent token)"
EXPECTED = [
    "[armoriq] plan: Respond to the checkout latency alert -> get_metrics, search_logs, restart_service",
    # delegation: a narrower token for the child
    "[armoriq] delegate log-analyst: get_metrics, search_logs",
    # the child is allowed its subset
    "[armoriq] check get_metrics: ALLOWED (policy incident-ops-policy: get_metrics -> allow; delegated to log-analyst)",
    "[armoriq] check search_logs: ALLOWED (policy incident-ops-policy: search_logs -> allow; delegated to log-analyst)",
    "[armoriq] report search_logs: success",
    # the child is refused what its parent can do, and the parent does it
    REFUSED,
    "REFUSED by ArmorIQ: log-analyst may not call restart_service",
    PARENT_OK,
    "[armoriq] report restart_service: success",
    "INCIDENT UPDATE:",
]


def run(mode):
    env = {k: v for k, v in os.environ.items() if k not in ("ARMORIQ_API_KEY", "GEMINI_API_KEY")}
    env["OFFLINE_APPROVAL"] = mode
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.run(
        [sys.executable, str(HERE / "demo.py")],
        cwd=RECIPE, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=300,
    )
    out = proc.stdout
    sys.stdout.write(out.encode("ascii", "replace").decode("ascii"))
    problems = []
    if proc.returncode != 0:
        problems.append(f"demo exited {proc.returncode}\n{proc.stderr[-2000:]}")
    problems += [f"missing: {line}" for line in EXPECTED if line not in out]
    if REFUSED in out and PARENT_OK in out and out.index(REFUSED) > out.index(PARENT_OK):
        problems.append("the parent's restart ran before the child's refusal")
    if out.count("[armoriq] report restart_service: success") != 1:
        problems.append("restart_service should run exactly once, for the parent")
    if "Traceback" in out:
        problems.append("unexpected: Traceback")
    return problems


failed = False
for mode in ("approve", "reject"):
    print(f"\n=== OFFLINE_APPROVAL={mode}")
    problems = run(mode)
    if problems:
        failed = True
        print(f"FAIL offline run ({mode})")
        for problem in problems:
            print(f"  {problem}")
    else:
        print(f"PASS offline run ({mode}): {len(EXPECTED)} expected lines seen")
sys.exit(1 if failed else 0)
