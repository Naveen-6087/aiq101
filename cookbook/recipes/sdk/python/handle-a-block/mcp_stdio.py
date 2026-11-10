"""Reads the release-desk tool catalog over MCP stdio, so the planner knows what it can ask for.

The agent never calls a release-desk tool itself: every call goes through ArmorIQ's invoke(),
and ArmorIQ's proxy forwards it to the MCP server you registered. This file only answers
"which tools exist and what arguments do they take".
"""

import asyncio
import sys
from functools import cache
from pathlib import Path

from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

SERVER = Path(__file__).resolve().parent / "release_desk_mcp.py"


@cache
def list_tools() -> list[dict]:
    """Name, description, and input schema of every tool the server offers (read once per process)."""

    async def go():
        server = StdioServerParameters(command=sys.executable, args=[str(SERVER)])
        async with Client(server) as client:
            listed = await client.list_tools()
            return [
                {"name": t.name, "description": t.description or "", "input_schema": t.input_schema}
                for t in listed.tools
            ]

    return asyncio.run(go())
