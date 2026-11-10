"""Installs the offline stand-ins before the agent is imported. Import this first.

What is swapped (all in sys.modules):
  armoriq_sdk.client / armoriq_sdk.session   the ArmorIQ client and session (policy.yaml driven)
  langchain_openai                            a scripted tool calling chat model in place of OpenAI

What stays real: agent.py (the LangGraph StateGraph, its policy_gate / human_review / run_tools
nodes, interrupt(), Command(resume=...), and the InMemorySaver checkpointer) and runbook_tools.py.
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
os.environ.setdefault("OPENAI_API_KEY", "offline")
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
sys.modules["armoriq_sdk.client"] = client_module
sys.modules["armoriq_sdk.session"] = session_module
armoriq_sdk.client = client_module
armoriq_sdk.session = session_module
armoriq_sdk.ArmorIQClient = armoriq_standin.StandInClient

openai_module = types.ModuleType("langchain_openai")
openai_module.ChatOpenAI = scripted_model.ScriptedChatModel
sys.modules["langchain_openai"] = openai_module
