"""Offline test: runs demo.py in a subprocess and checks the log contract lines and the recoveries.

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
    # allow
    "[armoriq] plan: Deploy checkout build 512 to staging -> get_build_status, deploy_to_staging",
    "[armoriq] check get_build_status: ALLOWED (policy release-desk-policy: get_build_status -> allow)",
    "[armoriq] check deploy_to_staging: ALLOWED (policy release-desk-policy: deploy_to_staging -> allow)",
    "[armoriq] report deploy_to_staging: success",
    # hold
    "[armoriq] check deploy_to_production: HELD (policy release-desk-policy: deploy_to_production -> hold)",
    "[armoriq] args deploy_to_production: ",
    # block, then a re-plan that asks a human instead
    "[armoriq] check delete_environment: BLOCKED (policy release-desk-policy: delete_environment -> block)",
    "[agent] PolicyBlockedException: delete_environment was blocked",
    "[armoriq] plan: Tear down the idle staging-eu environment -> request_teardown",
    "[armoriq] check request_teardown: ALLOWED",
    "Refused: delete_environment (blocked by policy).",
    # off plan step, then a new plan and token
    "[armoriq] check rerun_ci: BLOCKED (intent mismatch: rerun_ci is not in signed plan",
    "[agent] IntentMismatchException: rerun_ci is not in the signed plan.",
    "[armoriq] plan: Deploy payments build 77 to staging -> rerun_ci, deploy_to_staging",
    "[armoriq] check rerun_ci: ALLOWED (policy release-desk-policy: rerun_ci -> allow)",
    "Answer: Done: get_build_status, rerun_ci, deploy_to_staging.",
    # expired token, then a fresh one for the same plan
    "[agent] TokenExpiredException: Intent token expired",
    "Answer: Done: run_smoke_tests, deploy_to_staging.",
    "\nDone.",
]
EXPECTED = {
    "approve": COMMON + [
        "[armoriq] hold deploy_to_production: APPROVED",
        "[armoriq] report deploy_to_production: success",
        "Answer: Done: get_build_status, deploy_to_production.",
    ],
    "reject": COMMON + [
        "[armoriq] hold deploy_to_production: REJECTED",
        "[agent] DelegationException: deploy_to_production was not approved",
        "Refused: deploy_to_production (approval rejected).",
    ],
}
FORBIDDEN = {
    "approve": ["hold deploy_to_production: REJECTED", "Traceback"],
    "reject": ["hold deploy_to_production: APPROVED", "report deploy_to_production:", "Traceback"],
}


def run(mode):
    env = {k: v for k, v in os.environ.items() if k not in ("ARMORIQ_API_KEY", "GEMINI_API_KEY")}
    env["OFFLINE_APPROVAL"] = mode
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.run(
        [sys.executable, str(HERE / "demo.py")],
        cwd=RECIPE, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=300,
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
