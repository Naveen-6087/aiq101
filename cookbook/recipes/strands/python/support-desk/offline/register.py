"""Installs the offline stand-ins before the agent is imported. Import this first.

What is swapped (all in sys.modules):
  armoriq_sdk.client / armoriq_sdk.session   the ArmorIQ client and session (policy.yaml driven)
  strands.models.gemini                       a scripted model in place of Gemini

What stays real: agent.py, support_desk_mcp.py (spawned over stdio), the Strands Agent, and
armoriq_sdk.integrations.strands (ArmorIQStrands and its hooks).
"""

import importlib
import os
import sys
import types
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
import scripted_model  # noqa: E402


def _copy_module(name, **overrides):
    real = importlib.import_module(name)
    standin = types.ModuleType(name)
    standin.__dict__.update({k: v for k, v in vars(real).items() if not k.startswith("__")})
    standin.__dict__.update(overrides)
    return standin


client_module = _copy_module(
    "armoriq_sdk.client",
    ArmorIQClient=armoriq_standin.StandInClient,
    ArmorIQUserScope=armoriq_standin.StandInScope,
)
session_module = _copy_module("armoriq_sdk.session", ArmorIQSession=armoriq_standin.StandInSession)

# The integrations were imported with the real client when armoriq_sdk loaded. Drop them,
# swap the core modules, and import them again so the real integration code binds to the stand-ins.
for name in [n for n in sys.modules if n.startswith("armoriq_sdk.integrations")]:
    del sys.modules[name]
sys.modules["armoriq_sdk.client"] = client_module
sys.modules["armoriq_sdk.session"] = session_module
armoriq_sdk.client = client_module
armoriq_sdk.session = session_module
armoriq_sdk.ArmorIQClient = armoriq_standin.StandInClient
importlib.import_module("armoriq_sdk.integrations.strands")

gemini_module = types.ModuleType("strands.models.gemini")
gemini_module.GeminiModel = scripted_model.ScriptedModel
sys.modules["strands.models.gemini"] = gemini_module
