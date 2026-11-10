"""A rule based planner that stands in for planner.py (Gemini). Same plan() signature, keywords in, steps out."""

import re

MODEL = "offline-rule-planner"


def plan(goal: str, tools: list[dict], avoid=(), done=()) -> list[dict]:
    text = goal.lower()
    build = re.search(r"(checkout|payments) build (\d+)", text)
    target = {"service": build.group(1), "build_id": build.group(2)} if build else {}
    env = re.search(r"(staging-[a-z]+)", text)

    if env and ("tear down" in text or "delete" in text):
        name = env.group(1)
        if "delete_environment" in avoid:
            # The direct route was refused, so ask a human to do it instead.
            steps = [{"action": "request_teardown", "params": {"environment": name, "reason": goal}}]
        else:
            steps = [
                {"action": "list_environments", "params": {}},
                {"action": "delete_environment", "params": {"name": name}},
            ]
    elif "smoke" in text:
        steps = [
            {"action": "run_smoke_tests", "params": dict(target)},
            {"action": "deploy_to_staging", "params": dict(target)},
        ]
    elif "production" in text:
        steps = [
            {"action": "get_build_status", "params": dict(target)},
            {"action": "deploy_to_production", "params": dict(target)},
        ]
    else:
        steps = [
            {"action": "get_build_status", "params": dict(target)},
            {"action": "deploy_to_staging", "params": dict(target)},
        ]
    return [s for s in steps if s["action"] not in avoid and s["action"] not in done]
