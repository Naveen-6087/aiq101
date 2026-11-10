"""Offline stand-in for ArmorIQClient. No network, no API key.

It answers the same calls the agent makes on the real client (capture_plan, get_intent_token,
invoke, invoke_with_policy, close) and raises the real SDK exceptions in the same situations:

  token past its expiry      -> TokenExpiredException   (the real client checks this before sending)
  action not in signed plan  -> IntentMismatchException (the real proxy answers 409)
  policy says block          -> PolicyBlockedException
  policy says hold           -> waits for OFFLINE_APPROVAL, then runs it or raises DelegationException

Decisions come from this recipe's policy.yaml (a rule that names the tool wins, otherwise
default_action). Allowed calls run on the real release_desk_mcp.py, spawned over stdio, which
is the job ArmorIQ's proxy does live. Every decision prints one "[armoriq] ..." log line.
"""

import asyncio
import atexit
import json
import os
import sys
import threading
import time
from pathlib import Path

import yaml
from armoriq_sdk import (
    DelegationException,
    HoldInfo,
    IntentMismatchException,
    IntentToken,
    InvokeOptions,
    MCPInvocationException,
    MCPInvocationResult,
    PlanCapture,
    PolicyBlockedException,
    PolicyHoldException,
    TokenExpiredException,
)
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

RECIPE_DIR = Path(__file__).resolve().parent.parent
POLICY_PATH = RECIPE_DIR / "policy.yaml"
SERVER = RECIPE_DIR / "release_desk_mcp.py"


def log(line):
    print(f"[armoriq] {line}", flush=True)


def load_policy(path=POLICY_PATH):
    with open(path, encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def decide(policy, tool):
    """Return (action, reason) for a tool name, from the policy file only."""
    name = policy.get("name", "policy")
    for rule in policy.get("rules") or []:
        if rule.get("tool") == tool:
            action = rule["action"]
            return action, f"policy {name}: {tool} -> {action}"
    action = policy.get("default_action", "block")
    return action, f"policy {name}: no rule for {tool}, default_action -> {action}"


class McpConnection:
    """One long lived stdio session to release_desk_mcp.py, driven from a background event loop."""

    def __init__(self):
        self._loop = asyncio.new_event_loop()
        threading.Thread(target=self._loop.run_forever, daemon=True).start()
        self._ready = threading.Event()
        self._stop = None
        self._client = None
        asyncio.run_coroutine_threadsafe(self._hold_open(), self._loop)
        if not self._ready.wait(60):
            raise RuntimeError("release_desk_mcp.py did not start")
        atexit.register(self.close)

    async def _hold_open(self):
        self._stop = asyncio.Event()
        server = StdioServerParameters(command=sys.executable, args=[str(SERVER)])
        async with Client(server) as client:
            self._client = client
            self._ready.set()
            await self._stop.wait()

    def call(self, name, args):
        future = asyncio.run_coroutine_threadsafe(self._client.call_tool(name, args), self._loop)
        result = future.result(60)
        text = " ".join(getattr(block, "text", "") for block in result.content).strip()
        if result.is_error:
            raise RuntimeError(text or f"{name} failed")
        content = result.structured_content
        if isinstance(content, dict):
            # Tools that return a list come back wrapped as {"result": [...]}.
            return content.get("result", content) if len(content) == 1 else content
        try:
            return json.loads(text)
        except ValueError:
            return text

    def close(self):
        if self._stop is not None and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._stop.set)
            time.sleep(0.3)


class StandInClient:
    def __init__(self, api_key=None, **_kwargs):
        self.api_key = api_key
        self.policy = load_policy()
        self._mcp = None
        self._tokens = 0
        self._holds = 0

    # Step 1 -------------------------------------------------------------
    def capture_plan(self, llm, prompt, plan=None, metadata=None):
        if not plan or "steps" not in plan:
            raise ValueError("Plan must contain 'steps' key")
        log(f"plan: {plan.get('goal', prompt)} -> {', '.join(s['action'] for s in plan['steps'])}")
        return PlanCapture(plan=plan, llm=llm, prompt=prompt, metadata=metadata or {})

    # Step 2 -------------------------------------------------------------
    def get_intent_token(self, plan_capture, policy=None, validity_seconds=60.0, user_email=None):
        self._tokens += 1
        now = time.time()
        steps = plan_capture.plan["steps"]
        token = IntentToken(
            token_id=f"offline-token-{self._tokens}",
            plan_hash=f"offline-plan-{self._tokens}",
            signature="offline",
            issued_at=now,
            expires_at=now + validity_seconds,
            composite_identity=user_email or "",
            total_steps=len(steps),
            raw_token={"plan": plan_capture.plan},
        )
        log(f"token: {token.token_id} for {len(steps)} step(s), valid {validity_seconds:g}s")
        return token

    # Step 3 -------------------------------------------------------------
    def invoke(self, mcp, action, intent_token, params=None, user_email=None):
        return self._invoke(mcp, action, intent_token, params or {}, InvokeOptions(user_email=user_email))

    def invoke_with_policy(self, mcp, action, intent_token, params=None, options=None):
        return self._invoke(mcp, action, intent_token, params or {}, options or InvokeOptions())

    def _invoke(self, mcp, action, token, params, opts):
        if token.is_expired:
            raise TokenExpiredException(
                f"Intent token expired {abs(token.time_until_expiry):.1f}s ago",
                token_id=token.token_id,
                expired_at=token.expires_at,
            )
        planned = [step["action"] for step in (token.raw_token.get("plan") or {}).get("steps", [])]
        if action not in planned:
            log(f"check {action}: BLOCKED (intent mismatch: {action} is not in signed plan {token.token_id})")
            raise IntentMismatchException(f"Action not in plan: {action}", action=action, plan_hash=token.plan_hash)

        verdict, reason = decide(self.policy, action)
        label = {"allow": "ALLOWED", "hold": "HELD", "block": "BLOCKED"}.get(verdict, "BLOCKED")
        log(f"check {action}: {label} ({reason})")
        log(f"args {action}: {json.dumps(params, sort_keys=True)}")
        matched = self.policy.get("name")
        if verdict == "hold":
            if not opts.wait_for_approval or not opts.user_email:
                raise PolicyHoldException("Action held for approval", matched_policy=matched, reason=reason)
            self._holds += 1
            if opts.on_hold:
                opts.on_hold(HoldInfo(delegation_id=f"offline-delegation-{self._holds}", reason=reason, tool=action, mcp=mcp))
            approved = os.environ.get("OFFLINE_APPROVAL", "approve").strip().lower() != "reject"
            log(f"hold {action}: {'APPROVED' if approved else 'REJECTED'}")
            if not approved:
                raise DelegationException("Delegation rejected", delegation_id=f"offline-delegation-{self._holds}")
        elif verdict != "allow":
            raise PolicyBlockedException(
                "Action blocked by policy", enforcement_action="block", reason=reason, matched_policy=matched
            )

        if self._mcp is None:
            self._mcp = McpConnection()
        start = time.time()
        try:
            result = self._mcp.call(action, params)
        except RuntimeError as e:
            log(f"report {action}: error")
            raise MCPInvocationException(f"MCP tool error: {e}", mcp=mcp, action=action) from e
        log(f"report {action}: success")
        return MCPInvocationResult(mcp=mcp, action=action, result=result, status="success",
                                   execution_time=time.time() - start, verified=True)

    def close(self):
        if self._mcp is not None:
            self._mcp.close()
            self._mcp = None
