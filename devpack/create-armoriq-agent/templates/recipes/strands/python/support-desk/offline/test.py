"""Offline test: runs demo.py in a subprocess and checks the log contract lines.

    .venv/bin/python offline/test.py

Checks the approve run and the OFFLINE_APPROVAL=reject run. Needs no keys or network.
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECIPE = HERE.parent

COMMON = [
    "[armoriq] plan: ",
    "[armoriq] check get_ticket: ALLOWED (policy support-desk-policy: get_ticket -> allow)",
    "[armoriq] check reply_to_ticket: ALLOWED",
    "[armoriq] report reply_to_ticket: success",
    "[armoriq] check issue_refund: HELD (policy support-desk-policy: issue_refund -> hold)",
    "[armoriq] args issue_refund: ",
    "[armoriq] injection: ",
    "[armoriq] check close_account: BLOCKED (policy support-desk-policy: close_account -> block)",
]
EXPECTED = {
    "approve": COMMON + ["[armoriq] hold issue_refund: APPROVED", "[armoriq] report issue_refund: success"],
    "reject": COMMON + ["[armoriq] hold issue_refund: REJECTED"],
}
FORBIDDEN = {
    "approve": ["hold issue_refund: REJECTED"],
    "reject": ["hold issue_refund: APPROVED", "report issue_refund:"],
}


def run(mode):
    env = {k: v for k, v in os.environ.items() if k not in ("ARMORIQ_API_KEY", "GEMINI_API_KEY")}
    env["OFFLINE_APPROVAL"] = mode
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.run(
        [sys.executable, str(HERE / "demo.py")],
        cwd=RECIPE, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120,
    )
    out = proc.stdout
    sys.stdout.write(out)
    problems = []
    if proc.returncode != 0:
        problems.append(f"demo exited {proc.returncode}\n{proc.stderr[-2000:]}")
    problems += [f"missing: {line}" for line in EXPECTED[mode] if line not in out]
    problems += [f"unexpected: {line}" for line in FORBIDDEN[mode] if line in out]
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
        print(f"PASS offline run ({mode}): {len(EXPECTED[mode])} expected lines seen")
sys.exit(1 if failed else 0)
