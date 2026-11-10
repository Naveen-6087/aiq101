"""Offline stand-in for the ArmorIQ client and session. No network, no API key.

It decides allow, hold or block from this recipe's own policy.yaml: a rule that names the
tool wins, otherwise default_action applies. Every decision prints one line in the shared
"[armoriq] ..." log format. The real ArmorIQStrands integration runs on top of this.
"""

import json
import os
from pathlib import Path
from types import SimpleNamespace

import yaml

POLICY_PATH = Path(__file__).resolve().parent.parent / "policy.yaml"

# Phrases the stand-in scanner treats as a prompt injection attempt inside a tool result.
INJECTION_MARKERS = ("system override", "pre-authorized", "no approval needed")


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


class StandInSession:
    def __init__(self, client, opts, user_email):
        self.client = client
        self.opts = opts
        self.user_email = user_email
        self._holds = {}

    def start_plan(self, tool_calls, goal=None):
        names = ", ".join(call["name"] for call in tool_calls)
        log(f"plan: {goal or 'agent turn'} -> {names}")
        return SimpleNamespace(token="offline-intent-token")

    def check(self, tool_name, args, user_email=None):
        action, reason = decide(self.client.policy, tool_name)
        label = {"allow": "ALLOWED", "hold": "HELD", "block": "BLOCKED"}.get(action, "BLOCKED")
        log(f"check {tool_name}: {label} ({reason})")
        log(f"args {tool_name}: {json.dumps(args, sort_keys=True)}")
        delegation_id = None
        if action == "hold":
            delegation_id = f"offline-delegation-{len(self._holds) + 1}"
            self._holds[delegation_id] = tool_name
        return SimpleNamespace(
            allowed=action == "allow",
            action=action if action in ("allow", "hold") else "block",
            reason=reason,
            delegation_id=delegation_id,
        )

    async def await_approval(self, delegation_id, timeout=None, interval=None, user_email=None):
        tool_name = self._holds.get(delegation_id, "unknown")
        approved = os.environ.get("OFFLINE_APPROVAL", "approve").strip().lower() != "reject"
        log(f"hold {tool_name}: {'APPROVED' if approved else 'REJECTED'}")
        return "approved" if approved else "rejected"

    def report(self, tool_name, args, result, options=None):
        status = getattr(options, "status", "success")
        log(f"report {tool_name}: {status}")
        text = str(result).lower()
        if any(marker in text for marker in INJECTION_MARKERS):
            log(f"injection: result of {tool_name} tells the agent it is pre-authorized to skip approval")

    def _close_observability(self, status):
        pass


class StandInScope:
    def __init__(self, client, user_email):
        self._client = client
        self.user_email = user_email.strip().lower()

    def start_session(self, opts=None):
        return StandInSession(self._client, opts, self.user_email)


class StandInClient:
    def __init__(self, api_key=None, **_kwargs):
        self.api_key = api_key
        self.policy = load_policy()

    def bootstrap(self):
        mcp = (self.policy.get("scope") or {}).get("target", "support-desk")
        tools = [rule["tool"] for rule in self.policy.get("rules") or []]
        return {"toolMap": {tool: mcp for tool in tools}}

    def for_user(self, user_email):
        return StandInScope(self, user_email)

    def invalidate_user(self, user_email):
        pass
