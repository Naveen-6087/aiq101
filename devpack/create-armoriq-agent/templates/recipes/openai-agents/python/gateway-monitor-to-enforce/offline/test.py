"""Offline test: runs demo.py in a subprocess and checks the log contract lines.

    .venv/bin/python offline/test.py

Run 1 uses policy.yaml as shipped. Run 2 uses a copy where record_payment is allowed, to prove
the stand-in decides from the policy file. Needs no keys or network beyond localhost.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
RECIPE = HERE.parent

SHIPPED = {
    "expected": [
        # Phase 1: record only
        "[gateway] recorded: lookup_invoice (no agent in the URL, nothing checked)",
        "[ledger] payment recorded: INV-1041",
        # Phase 2: monitor mode, the payment still goes through
        "[armoriq] plan: Pay invoice INV-1042",
        "[armoriq] check lookup_invoice: ALLOWED (monitor mode; policy ap-clerk-policy: lookup_invoice -> allow)",
        "[armoriq] check record_payment: BLOCKED (monitor mode: would block, nothing stopped; "
        "policy ap-clerk-policy: record_payment -> block)",
        "[ledger] payment recorded: INV-1042",
        "[gateway] What policy would have done: 1 would block, 0 would hold, 1 allowed",
        # Phase 3: enforced
        "[armoriq] plan: Pay invoice INV-1043",
        "[armoriq] check record_payment: BLOCKED (policy ap-clerk-policy: record_payment -> block)",
        "[armoriq] args record_payment: ",
        'Tool call "record_payment" was blocked by policy: block:record_payment#0',
        "(Intent Gateway stopped a tool call; the note above names the rule.)",
        "[gateway] request from dana@example.com",
    ],
    "forbidden": ["[ledger] payment recorded: INV-1043", "Traceback"],
}
LOOSENED = {
    "expected": [
        "[armoriq] check record_payment: ALLOWED (policy ap-clerk-policy: record_payment -> allow)",
        "[ledger] payment recorded: INV-1043",
    ],
    "forbidden": ["was blocked by policy"],
}


def run(policy_path=None):
    drop = ("OPENAI_API_KEY", "ARMORIQ_GATEWAY_KEY", "ARMORIQ_AGENT_ID", "ARMORIQ_GATEWAY_HOST", "OFFLINE_POLICY")
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    if policy_path:
        env["OFFLINE_POLICY"] = str(policy_path)
    proc = subprocess.run(
        [sys.executable, str(HERE / "demo.py")],
        cwd=RECIPE, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", timeout=120,
    )
    sys.stdout.write(proc.stdout)
    return proc


def verify(name, proc, spec):
    problems = []
    if proc.returncode != 0:
        problems.append(f"demo exited {proc.returncode}\n{proc.stderr[-2000:]}")
    problems += [f"missing: {line}" for line in spec["expected"] if line not in proc.stdout]
    problems += [f"unexpected: {line}" for line in spec["forbidden"] if line in proc.stdout + proc.stderr]
    if problems:
        print(f"FAIL offline run ({name})")
        for problem in problems:
            print(f"  {problem}")
        return False
    print(f"PASS offline run ({name}): {len(spec['expected'])} expected lines seen")
    return True


ok = True
print("\n=== policy.yaml as shipped")
ok &= verify("shipped policy", run(), SHIPPED)

print("\n=== policy.yaml with record_payment -> allow")
policy = yaml.safe_load((RECIPE / "policy.yaml").read_text(encoding="utf-8"))
for rule in policy["rules"]:
    if rule["tool"] == "record_payment":
        rule["action"] = "allow"
with tempfile.TemporaryDirectory() as tmp:
    loosened = Path(tmp) / "policy.yaml"
    loosened.write_text(yaml.safe_dump(policy), encoding="utf-8")
    ok &= verify("record_payment allowed", run(loosened), LOOSENED)

sys.exit(0 if ok else 1)
