"""Scripted offline walkthrough: the real crew.py, wrapped by the real ArmorIQCrew.

    .venv/bin/python offline/demo.py

One coin, one tool call, allowed by policy.yaml. Needs no API keys, no Docker, no network.
OFFLINE_APPROVAL is read for consistency with the other recipes, but this policy holds nothing.
"""

import os

import register  # noqa: F401  installs the stand-ins; must come before crew

os.environ["COINS"] = "bitcoin"

import crew

crew.main()
