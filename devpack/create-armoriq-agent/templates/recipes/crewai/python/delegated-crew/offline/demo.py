"""Scripted offline walkthrough: the real crew.py, with a delegated token for the log analyst.

    .venv/bin/python offline/demo.py

The analyst reads metrics and logs (allowed by its delegated token), tries to restart checkout
(refused: not delegated), and the incident lead restarts it with its own token (allowed).
Needs no API keys, no Docker, no network. OFFLINE_APPROVAL is read for consistency with the
other recipes, but this policy holds nothing.
"""

import register  # noqa: F401  installs the stand-ins; must come before crew

import crew

crew.main()
