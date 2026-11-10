"""Installs the offline stand-ins before the crew code is imported. Import this first.

What is swapped:
  armoriq_sdk.ArmorIQClient   the ArmorIQ client (plan, token, delegate, invoke; policy.yaml driven,
                              runs allowed calls on incident_ops_mcp.py's tool functions in process)
  crewai.llm.LLM              a scripted model in place of Gemini

What stays real: crew.py, armoriq_tools.py (the BaseTool._run that calls invoke), CrewAI itself,
the Ed25519 key generation, and the SDK's exception classes and models.
"""

import os
import sys
from pathlib import Path

OFFLINE_DIR = Path(__file__).resolve().parent
RECIPE_DIR = OFFLINE_DIR.parent
for path in (str(OFFLINE_DIR), str(RECIPE_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

# crew.py reads both keys; the stand-ins never use them.
os.environ.setdefault("ARMORIQ_API_KEY", "offline")
os.environ.setdefault("GEMINI_API_KEY", "offline")
os.environ.setdefault("USER_EMAIL", "you@example.com")
# No telemetry or network lookups from CrewAI while offline.
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_DISABLE_TRACKING", "true")
os.environ.setdefault("CREWAI_TRACING_ENABLED", "false")
# CrewAI prints emoji; a Windows console code page cannot encode them.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

import armoriq_sdk  # noqa: E402
import crewai.llm  # noqa: E402
import armoriq_standin  # noqa: E402
import scripted_llm  # noqa: E402

armoriq_sdk.ArmorIQClient = armoriq_standin.StandInClient
crewai.llm.LLM = scripted_llm.ScriptedLLM
