"""Offline walkthrough of the rollout: record only, then monitor mode, then enforce.

    .venv/bin/python offline/demo.py

Starts the stand-in gateway on a free 127.0.0.1 port, points the real agent.py at it by
changing only ARMORIQ_GATEWAY_HOST, and runs one payment request per phase. Needs no API
keys and no network beyond localhost.
"""

import os
import sys
from pathlib import Path

OFFLINE_DIR = Path(__file__).resolve().parent
sys.path[:0] = [str(OFFLINE_DIR), str(OFFLINE_DIR.parent)]

# agent.py reads these; the stand-in checks only that a provider key is sent.
os.environ.setdefault("OPENAI_API_KEY", "offline")
os.environ.setdefault("ARMORIQ_GATEWAY_KEY", "offline-gateway-key")
os.environ.setdefault("USER_EMAIL", "dana@example.com")
os.environ["OPENAI_AGENTS_DISABLE_TRACING"] = "1"  # traces would upload to OpenAI

from gateway import StandInGateway  # noqa: E402

import agent  # noqa: E402

PHASES = [
    ("Phase 1: record only (base URL without an agent)", "", False, "Pay invoice INV-1041 from Northwind Paper in full"),
    ("Phase 2: agent in the URL, Monitor mode on", "ap-clerk", True, "Pay invoice INV-1042 from Acme Supplies in full"),
    ("Phase 3: Monitor mode off, policy enforced", "ap-clerk", False, "Pay invoice INV-1043 from Contoso Freight in full"),
]

gateway = StandInGateway()
os.environ["ARMORIQ_GATEWAY_HOST"] = gateway.start()
print(f"[offline] stand-in gateway on {os.environ['ARMORIQ_GATEWAY_HOST']}; OpenAI is scripted, no keys used.", flush=True)

try:
    for title, agent_id, monitor, goal in PHASES:
        print(f"\n##### {title}", flush=True)
        os.environ["ARMORIQ_AGENT_ID"] = agent_id
        gateway.monitor_mode = monitor
        print(f"[offline] base URL: {agent.gateway_base_url()}", flush=True)
        sys.argv = ["agent.py", goal]
        agent.main()
        if monitor:
            gateway.print_report()
finally:
    gateway.stop()
print("\nDone.", flush=True)
