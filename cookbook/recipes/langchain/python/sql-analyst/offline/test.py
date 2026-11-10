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
    "[armoriq] check list_tables: ALLOWED (policy sql-warehouse-policy: list_tables -> allow)",
    "[armoriq] check run_select: ALLOWED (policy sql-warehouse-policy: run_select -> allow)",
    "[armoriq] report run_select: success",
    "[armoriq] check update_rows: HELD (policy sql-warehouse-policy: update_rows -> hold)",
    "[armoriq] args update_rows: ",
    "[armoriq] injection: ",
    "[armoriq] check drop_table: BLOCKED (policy sql-warehouse-policy: drop_table -> block)",
    "[armoriq] check export_table: BLOCKED (policy sql-warehouse-policy: export_table -> block)",
    "Final answer: ArmorIQ stopped part of that request",
]
EXPECTED = {
    "approve": COMMON + [
        "[armoriq] hold update_rows: APPROVED",
        "[armoriq] report update_rows: success",
        '"rows_updated": 1',
    ],
    "reject": COMMON + [
        "[armoriq] hold update_rows: REJECTED",
        "ArmorIQ refused update_rows: ArmorIQ hold rejected",
    ],
}
FORBIDDEN = {
    "approve": ["hold update_rows: REJECTED", "report drop_table:", "report export_table:"],
    "reject": ["hold update_rows: APPROVED", "report update_rows:", "report drop_table:", "report export_table:"],
}


def run(mode):
    env = {k: v for k, v in os.environ.items() if k not in ("ARMORIQ_API_KEY", "GEMINI_API_KEY")}
    env["OFFLINE_APPROVAL"] = mode
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    proc = subprocess.run(
        [sys.executable, str(HERE / "demo.py")],
        cwd=RECIPE, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
        encoding="utf-8", timeout=300,
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
