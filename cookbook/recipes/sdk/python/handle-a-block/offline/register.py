"""Installs the offline stand-ins before the agent is imported. Import this first.

What is swapped:
  armoriq_sdk.ArmorIQClient   the ArmorIQ client (policy.yaml driven; runs allowed calls on the
                              local release-desk server over stdio, which is the proxy's job live)
  planner                     offline/rule_planner.py in place of the Gemini planner

What stays real: agent.py and its whole loop, mcp_stdio.py, release_desk_mcp.py, and the SDK's
exception classes and models (InvokeOptions, IntentToken, PolicyBlockedException, ...).
"""

import os
import sys
from pathlib import Path

OFFLINE_DIR = Path(__file__).resolve().parent
RECIPE_DIR = OFFLINE_DIR.parent
for path in (str(OFFLINE_DIR), str(RECIPE_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

# agent.py insists on both keys; the stand-ins never read them.
os.environ.setdefault("ARMORIQ_API_KEY", "offline")
os.environ.setdefault("GEMINI_API_KEY", "offline")
os.environ.setdefault("USER_EMAIL", "you@example.com")

import armoriq_sdk  # noqa: E402
import armoriq_standin  # noqa: E402
import rule_planner  # noqa: E402

armoriq_sdk.ArmorIQClient = armoriq_standin.StandInClient
sys.modules["planner"] = rule_planner
