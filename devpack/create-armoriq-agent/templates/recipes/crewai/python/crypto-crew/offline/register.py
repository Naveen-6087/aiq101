"""Installs the offline stand-ins before the crew code is imported. Import this first.

What is swapped:
  armoriq_sdk.ArmorIQClient   the ArmorIQ client (policy.yaml driven, canned CoinGecko data)
  crewai.llm.LLM              a scripted model in place of Gemini

What stays real: crew.py, crypto_tool.py (its _run is the live CoinGecko call, which ArmorIQCrew
patches out exactly as it does live), CrewAI itself, and armoriq_sdk.integrations.crewai
(ArmorIQCrew: plan capture, token issue, tool patching).
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
# No telemetry or network lookups from CrewAI while offline.
os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("CREWAI_DISABLE_TRACKING", "true")

import armoriq_sdk  # noqa: E402
import crewai.llm  # noqa: E402
import armoriq_standin  # noqa: E402
import scripted_llm  # noqa: E402

armoriq_sdk.ArmorIQClient = armoriq_standin.StandInClient
crewai.llm.LLM = scripted_llm.ScriptedLLM
