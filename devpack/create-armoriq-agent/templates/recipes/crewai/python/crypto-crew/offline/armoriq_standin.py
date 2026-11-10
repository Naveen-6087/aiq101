"""Offline stand-in for the ArmorIQ client used by ArmorIQCrew. No network, no API key.

ArmorIQCrew calls capture_plan, get_intent_token, and then invoke for every tool call. This
stand-in answers those calls locally. It reads this recipe's policy.yaml (a rule that names the
tool wins, otherwise default_action) and serves canned CoinGecko prices in place of the proxy
and the CoinGecko MCP server. Every decision prints one "[armoriq] ..." log line.
"""

import json
import os
import re
from pathlib import Path
from types import SimpleNamespace

import yaml

POLICY_PATH = Path(__file__).resolve().parent.parent / "policy.yaml"

# Canned CoinGecko answers, shaped like the live /simple/price response.
PRICES = {
    "bitcoin": {"usd": 84018.0, "usd_market_cap": 1.69e12, "usd_24h_change": 0.097},
    "ethereum": {"usd": 2685.26, "usd_market_cap": 3.278e11, "usd_24h_change": -0.262},
    "solana": {"usd": 131.4, "usd_market_cap": 6.3e10, "usd_24h_change": 1.35},
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

    def capture_plan(self, llm, prompt, plan):
        goal = re.sub(r"\s+", " ", prompt).strip()
        if len(goal) > 90:
            goal = goal[:87] + "..."
        tools = ", ".join(step["action"] for step in plan["steps"])
        log(f"plan: {goal} -> {tools}")
        return SimpleNamespace(plan=plan, llm=llm)

    def get_intent_token(self, plan, validity_seconds=None, **_kwargs):
        return SimpleNamespace(token="offline-intent-token", validity_seconds=validity_seconds)

    def invoke(self, mcp, action, intent_token, params=None, **_kwargs):
        params = params or {}
        verdict, reason = decide(self.policy, action)
        label = {"allow": "ALLOWED", "hold": "HELD", "block": "BLOCKED"}.get(verdict, "BLOCKED")
        log(f"check {action}: {label} ({reason})")
        log(f"args {action}: {json.dumps(params, sort_keys=True)}")
        if verdict == "hold":
            approved = os.environ.get("OFFLINE_APPROVAL", "approve").strip().lower() != "reject"
            log(f"hold {action}: {'APPROVED' if approved else 'REJECTED'}")
            if not approved:
                raise RuntimeError(f"{action} was held and the hold was rejected")
        elif verdict != "allow":
            raise RuntimeError(f"{action} blocked: {reason}")
        coin = str(params.get("coin_id", ""))
        data = PRICES.get(coin)
        result = str(data) if data else f"No price data found for coin id '{coin}'."
        log(f"report {action}: success")
        return SimpleNamespace(result=result, mcp=mcp, action=action)
