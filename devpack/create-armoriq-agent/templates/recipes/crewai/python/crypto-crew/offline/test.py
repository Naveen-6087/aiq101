"""Offline test: runs demo.py in a subprocess and checks the log contract lines.

    .venv/bin/python offline/test.py

Needs no keys or network.
"""

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RECIPE = HERE.parent

EXPECTED = [
    "[armoriq] plan: ",
    "-> get_price",
    "[armoriq] check get_price: ALLOWED (policy coingecko-policy: get_price -> allow)",
    "[armoriq] args get_price: ",
    "[armoriq] report get_price: success",
    "FINAL BRIEF:",
]


def run(mode):
    env = {k: v for k, v in os.environ.items() if k not in ("ARMORIQ_API_KEY", "GEMINI_API_KEY")}
    env["OFFLINE_APPROVAL"] = mode
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.run(
        [sys.executable, str(HERE / "demo.py")],
        cwd=RECIPE, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180,
    )
    sys.stdout.write(proc.stdout)
    problems = []
    if proc.returncode != 0:
        problems.append(f"demo exited {proc.returncode}\n{proc.stderr[-2000:]}")
    problems += [f"missing: {line}" for line in EXPECTED if line not in proc.stdout]
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
