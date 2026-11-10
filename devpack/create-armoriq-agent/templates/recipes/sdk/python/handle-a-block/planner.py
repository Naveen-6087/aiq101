"""Turns a goal into tool calls with Gemini. One call per plan, JSON out, no framework.

plan() returns a list of {"action": <tool name>, "params": {...}}. `avoid` lists tools the
policy already refused, so a re-plan has to find another way. `done` lists steps that
already ran, so a re-plan does not repeat them.
"""

import json
import os

from google import genai
from google.genai import types

MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest")

SYSTEM = (
    "You plan tool calls for a release engineering assistant. Reply with JSON only, in the shape "
    '{"steps": [{"action": "<tool name>", "params": {...}}]}. Use only the tools listed, with the '
    "argument names from their schemas. Plan the fewest steps that reach the goal. Never use a tool "
    "listed under 'Do not use'. If no allowed tool can reach the goal, return the closest safe step "
    "(for example, filing a request for a human) or an empty list."
)


def plan(goal: str, tools: list[dict], avoid=(), done=()) -> list[dict]:
    names = {tool["name"] for tool in tools}
    prompt = json.dumps(
        {
            "goal": goal,
            "tools": tools,
            "Do not use (refused by policy)": list(avoid),
            "Already done (do not repeat)": list(done),
        },
        indent=2,
        default=str,
    )
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=SYSTEM,
            response_mime_type="application/json",
            temperature=0,
        ),
    )
    data = json.loads(response.text or "{}")
    steps = data.get("steps", []) if isinstance(data, dict) else data
    # Drop anything the model invented or was told not to use.
    return [
        {"action": step["action"], "params": step.get("params") or {}}
        for step in steps
        if isinstance(step, dict) and step.get("action") in names and step["action"] not in avoid
    ]
