"""A release-desk agent written as a plain plan -> intent token -> invoke loop on the ArmorIQ SDK.

No agent framework. The loop plans with a model, mints one intent token for that plan, invokes
each step through ArmorIQ, and when ArmorIQ says no (a block, a rejected hold, an expired token,
a step outside the signed plan) it recovers: it re-plans, re-mints, or tells the user, instead
of crashing.

    python agent.py "Deploy checkout build 512 to staging"
"""

import json
import os
import sys

from dotenv import load_dotenv

from armoriq_sdk import (
    ArmorIQClient,
    ArmorIQException,
    DelegationException,
    IntentMismatchException,
    InvokeOptions,
    MCPInvocationException,
    PolicyBlockedException,
    PolicyHoldException,
    TokenExpiredException,
)

import mcp_stdio
import planner

load_dotenv()

MCP_NAME = os.environ.get("RELEASE_DESK_MCP_NAME", "release-desk")
MAX_PLANS = 3  # first plan plus two re-plans, then give up and say so


def say(line: str) -> None:
    print(f"[agent] {line}", flush=True)


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"[ERROR] {name} environment variable is required. Copy .env.example to .env and fill it in.")
        sys.exit(1)
    return value


def react(step: dict, result) -> dict | None:
    """Look at what a step returned and decide whether the agent wants an extra step.

    A red build makes the agent want to rerun CI before it deploys. That step was not in the
    plan the token was signed for, which is exactly what IntentMismatchException is about.
    """
    if step["action"] == "get_build_status" and isinstance(result, dict) and result.get("status") == "failed":
        say(f"build {result.get('build_id')} is red ({result.get('failing_test', 'a failing test')}), "
            "so I want to rerun CI first")
        return {"action": "rerun_ci", "params": dict(step["params"])}
    return None


class Run:
    """What happened during one goal, for the answer at the end."""

    def __init__(self, goal: str):
        self.goal = goal
        self.done: list[str] = []
        self.refused: list[str] = []

    def answer(self, stopped: str | None = None) -> str:
        parts = [f"Done: {', '.join(self.done)}." if self.done else "Nothing was done."]
        if self.refused:
            parts.append("Refused: " + "; ".join(self.refused) + ".")
        if stopped:
            parts.append(stopped)
        return " ".join(parts)


def run(goal: str, *, client: ArmorIQClient, user_email: str, token_seconds: float = 300.0) -> str:
    tools = mcp_stdio.list_tools()
    record = Run(goal)
    avoid: list[str] = []
    steps = planner.plan(goal, tools)

    for attempt in range(1, MAX_PLANS + 1):
        steps = [s for s in steps if s["action"] not in avoid]
        if not steps:
            return record.answer("No allowed way to finish this, so I stopped and am telling you instead.")
        if attempt > 1:
            say(f"re-planned (attempt {attempt}): {', '.join(s['action'] for s in steps)}")

        # Step 1: capture the plan. Every tool call the agent may make must be in here.
        capture = client.capture_plan(
            llm=planner.MODEL,
            prompt=goal,
            plan={
                "goal": goal,
                "steps": [{"action": s["action"], "mcp": MCP_NAME, "params": s["params"]} for s in steps],
            },
        )

        # Step 2: mint an intent token bound to that plan. A plan that names a denied tool can be
        # refused here, before anything runs.
        try:
            token = client.get_intent_token(capture, validity_seconds=token_seconds, user_email=user_email)
        except PolicyBlockedException as e:
            denied = list((e.metadata or {}).get("denied_tools") or [])
            say(f"PolicyBlockedException at token issuance: {e.reason or e}. Re-planning without {denied or 'it'}.")
            avoid += denied or [s["action"] for s in steps]
            record.refused.append(f"plan refused at token issuance ({e.reason or e})")
            steps = planner.plan(goal, tools, avoid=avoid, done=record.done)
            continue

        # Step 3: invoke each step through ArmorIQ, and recover from each kind of "no".
        next_plan = None
        retried_expiry = False
        i = 0
        while i < len(steps):
            step = steps[i]
            try:
                result = client.invoke_with_policy(
                    MCP_NAME,
                    step["action"],
                    token,
                    params=step["params"],
                    options=InvokeOptions(
                        user_email=user_email,
                        wait_for_approval=True,  # a hold waits for a human, then retries once approved
                        delegation_timeout_ms=int(os.environ.get("APPROVAL_TIMEOUT_MS", "300000")),
                        on_hold=lambda info: say(f"{info.tool} is waiting for a human approver ({info.reason})"),
                    ),
                ).result
            except TokenExpiredException as e:
                if retried_expiry:
                    raise
                # Same plan, fresh token. Nothing about the intent changed, only the clock.
                say(f"TokenExpiredException: {e}. Minting a fresh token for the same plan and retrying {step['action']}.")
                token = client.get_intent_token(capture, validity_seconds=token_seconds, user_email=user_email)
                retried_expiry = True
                continue
            except IntentMismatchException as e:
                # The agent drifted from the plan it signed. Make the drift the new plan, sign it, go on.
                say(f"IntentMismatchException: {step['action']} is not in the signed plan. "
                    "Capturing a new plan from here and minting a new token.")
                next_plan = steps[i:]
                break
            except PolicyBlockedException as e:
                # A hard no. Never retry the same tool; ask the planner for another way.
                say(f"PolicyBlockedException: {step['action']} was blocked ({e.reason or e}). "
                    "Re-planning without it.")
                avoid.append(step["action"])
                record.refused.append(f"{step['action']} (blocked by policy)")
                next_plan = planner.plan(goal, tools, avoid=avoid, done=record.done)
                break
            except DelegationException as e:
                # The hold was rejected or timed out. A human said no: stop and say so, no workaround.
                say(f"DelegationException: {step['action']} was not approved ({e}). Stopping here.")
                record.refused.append(f"{step['action']} (approval {str(e).replace('Delegation ', '')})")
                return record.answer("A human declined that step, so I did not try another route.")
            except PolicyHoldException as e:
                # Held, but we could not wait (no user email to attribute the approval to).
                say(f"PolicyHoldException: {step['action']} needs approval ({e.reason or e}).")
                record.refused.append(f"{step['action']} (waiting for approval)")
                return record.answer("Approve it on the ArmorIQ dashboard and run me again.")
            except MCPInvocationException as e:
                say(f"MCPInvocationException: the release-desk server failed on {step['action']} ({e}).")
                record.refused.append(f"{step['action']} (tool error)")
                return record.answer("The tool itself failed, so I stopped.")

            say(f"{step['action']} -> {json.dumps(result, default=str)}")
            record.done.append(step["action"])
            extra = react(step, result)
            if extra:
                steps.insert(i + 1, extra)
            retried_expiry = False
            i += 1

        if next_plan is None:
            return record.answer()
        steps = next_plan

    return record.answer(f"Gave up after {MAX_PLANS} plans.")


def main() -> None:
    api_key = require_env("ARMORIQ_API_KEY")
    require_env("GEMINI_API_KEY")
    user_email = os.environ.get("USER_EMAIL", "developer@armoriq.ai")
    token_seconds = float(os.environ.get("TOKEN_VALIDITY_SECONDS", "300"))
    goal = sys.argv[1] if len(sys.argv) > 1 else "Deploy checkout build 512 to staging"

    print(f"Goal: {goal}", flush=True)
    client = ArmorIQClient(api_key=api_key)
    try:
        answer = run(goal, client=client, user_email=user_email, token_seconds=token_seconds)
    except ArmorIQException as e:
        # Last line of defence: anything the loop did not handle still ends in a sentence, not a traceback.
        say(f"{type(e).__name__}: {e}")
        answer = "ArmorIQ refused this in a way I could not recover from, so nothing more was done."
    finally:
        client.close()
    print(f"Answer: {answer}", flush=True)


if __name__ == "__main__":
    main()
