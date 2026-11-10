"""Offline stand-in for ArmorIQClient: plan, token, delegate, invoke. No network, no API key.

Decisions, in the order the stand-in applies them:
  1. A delegated token only covers its allowed_actions. Anything else is refused with
     PolicyBlockedException, even when the policy would allow it for the parent.
  2. The action must be in the plan the parent token was signed for (IntentMismatchException).
  3. This recipe's policy.yaml: a rule that names the tool wins, otherwise default_action.

Allowed calls run the real tool functions from incident_ops_mcp.py in process, which is the job
ArmorIQ's proxy and the registered MCP server do live. Every decision prints one "[armoriq] ..." line.
"""

import json
import os
import re
import time
from pathlib import Path

import yaml
from armoriq_sdk import (
    DelegationException,
    DelegationResult,
    IntentMismatchException,
    IntentToken,
    MCPInvocationException,
    MCPInvocationResult,
    PlanCapture,
    PolicyBlockedException,
    PolicyHoldException,
    TokenExpiredException,
)

import incident_ops_mcp

POLICY_PATH = Path(__file__).resolve().parent.parent / "policy.yaml"
TOOLS = {
    "get_metrics": incident_ops_mcp.get_metrics,
    "search_logs": incident_ops_mcp.search_logs,
    "restart_service": incident_ops_mcp.restart_service,
}


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


class StandInClient:
    def __init__(self, api_key=None, **_kwargs):
        self.api_key = api_key
        self.policy = load_policy()
        self._count = 0

    def capture_plan(self, llm, prompt, plan=None, metadata=None):
        if not plan or "steps" not in plan:
            raise ValueError("Plan must contain 'steps' key")
        goal = re.sub(r"\s+", " ", plan.get("goal") or prompt).strip()
        log(f"plan: {goal} -> {', '.join(s['action'] for s in plan['steps'])}")
        return PlanCapture(plan=plan, llm=llm, prompt=prompt, metadata=metadata or {})

    def _token(self, plan, validity_seconds, **token_fields):
        self._count += 1
        now = time.time()
        return IntentToken(
            token_id=f"offline-token-{self._count}",
            plan_hash="offline-plan-hash",
            signature="offline",
            issued_at=now,
            expires_at=now + validity_seconds,
            composite_identity="offline",
            total_steps=len(plan["steps"]),
            raw_token={"plan": plan, "token": token_fields},
        )

    def get_intent_token(self, plan_capture, policy=None, validity_seconds=60.0, user_email=None):
        token = self._token(plan_capture.plan, validity_seconds, holder="parent", user_email=user_email)
        log(f"token: {token.token_id} for {len(plan_capture.plan['steps'])} step(s), valid {validity_seconds:g}s")
        return token

    def delegate(self, intent_token, delegate_public_key, validity_seconds=3600, allowed_actions=None,
                 target_agent=None, subtask=None):
        if intent_token.is_expired:
            raise DelegationException("parent token expired", target_agent=target_agent)
        parent_plan = intent_token.raw_token["plan"]
        parent_actions = [step["action"] for step in parent_plan["steps"]]
        allowed = list(allowed_actions or parent_actions)
        extra = [a for a in allowed if a not in parent_actions]
        if extra:
            # A delegate can never get more than its parent holds.
            raise DelegationException(f"cannot delegate actions the parent does not hold: {extra}",
                                      target_agent=target_agent)
        child = self._token(parent_plan, validity_seconds, holder=target_agent, allowed_actions=allowed,
                            delegate_public_key=delegate_public_key, parent_token_id=intent_token.token_id)
        log(f"delegate {target_agent}: {', '.join(allowed)}")
        return DelegationResult(
            delegation_id=f"offline-delegation-{self._count}",
            delegated_token=child,
            delegate_public_key=delegate_public_key,
            target_agent=target_agent,
            expires_at=child.expires_at,
            status="delegated",
        )

    def invoke(self, mcp, action, intent_token, params=None, user_email=None):
        params = params or {}
        if intent_token.is_expired:
            raise TokenExpiredException("Intent token expired", token_id=intent_token.token_id,
                                        expired_at=intent_token.expires_at)
        fields = intent_token.raw_token.get("token") or {}
        holder = fields.get("holder", "parent")
        allowed = fields.get("allowed_actions")
        if allowed is not None and action not in allowed:
            reason = f"delegation {holder}: {action} is not in allowed_actions [{', '.join(allowed)}]"
            log(f"check {action}: BLOCKED ({reason})")
            log(f"args {action}: {json.dumps(params, sort_keys=True)}")
            raise PolicyBlockedException("Action outside delegated authority", enforcement_action="block",
                                         reason=reason)
        planned = [step["action"] for step in intent_token.raw_token["plan"]["steps"]]
        if action not in planned:
            log(f"check {action}: BLOCKED (intent mismatch: {action} is not in the signed plan)")
            raise IntentMismatchException(f"Action not in plan: {action}", action=action)

        verdict, reason = decide(self.policy, action)
        reason += "; parent token" if allowed is None else f"; delegated to {holder}"
        label = {"allow": "ALLOWED", "hold": "HELD", "block": "BLOCKED"}.get(verdict, "BLOCKED")
        log(f"check {action}: {label} ({reason})")
        log(f"args {action}: {json.dumps(params, sort_keys=True)}")
        if verdict == "hold":
            approved = os.environ.get("OFFLINE_APPROVAL", "approve").strip().lower() != "reject"
            log(f"hold {action}: {'APPROVED' if approved else 'REJECTED'}")
            if not approved:
                raise PolicyHoldException("Action held for approval and rejected", reason=reason)
        elif verdict != "allow":
            raise PolicyBlockedException("Action blocked by policy", enforcement_action="block", reason=reason)

        try:
            result = TOOLS[action](**params)
        except Exception as e:
            log(f"report {action}: error")
            raise MCPInvocationException(f"MCP tool error: {e}", mcp=mcp, action=action) from e
        log(f"report {action}: success")
        return MCPInvocationResult(mcp=mcp, action=action, result=result, status="success", verified=True)

    def close(self):
        pass
