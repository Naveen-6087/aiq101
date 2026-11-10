"""ArmordSecurityAnalyzer: an OpenHands SDK security analyzer backed by the local armord daemon.

OpenHands (agent SDK, openhands-sdk >= 1.x) asks the conversation's security analyzer for a
`SecurityRisk` per pending action, and the confirmation policy (e.g. `ConfirmRisky(threshold=HIGH)`)
pauses the conversation for a human when the risk is at or above the threshold. An analyzer can
not reject an action by itself; the caller does that with `conversation.reject_pending_actions()`.

Verdict mapping:

    allow                      -> LOW
    hold                       -> HIGH (OpenHands asks the user to confirm)
    hold, wait_on_hold=True    -> waits on armord's hold queue (`armord approve <id>`):
                                  approved -> LOW, rejected / timed out -> treated as block
    block                      -> HIGH, with the reason in `details`; `rejection_for()` returns it
                                  so the caller can reject instead of offering a confirmation
    armord unreachable / error -> block (fail closed)
"""

from __future__ import annotations

from typing import Any

from .client import ArmordClient, ArmordUnavailable
from .mapping import build_request

try:  # the real SDK types when OpenHands is installed
    from openhands.sdk.security.analyzer import SecurityAnalysis, SecurityAnalyzerBase
    from openhands.sdk.security.risk import SecurityRisk

    HAVE_OPENHANDS_SDK = True
except ImportError:  # protocol tests and non-OpenHands callers
    from ._shim import SecurityAnalysis, SecurityAnalyzerBase, SecurityRisk

    HAVE_OPENHANDS_SDK = False

__all__ = ["ArmordSecurityAnalyzer", "HAVE_OPENHANDS_SDK", "SecurityRisk", "confirm_risky_policy", "pending_actions", "reject_blocked", "risk_for"]


def risk_for(decision: dict[str, Any]) -> SecurityRisk:
    """armord decision -> OpenHands risk. Anything but a clear allow is HIGH."""
    return SecurityRisk.LOW if decision.get("final") == "allow" else SecurityRisk.HIGH


def _block(reason: str) -> dict[str, Any]:
    return {"verdict": "block", "final": "block", "reason": reason, "tool": None}


def confirm_risky_policy() -> Any:
    """`ConfirmRisky(threshold=HIGH)`: what makes a HIGH risk stop for confirmation."""
    from openhands.sdk.security.confirmation_policy import ConfirmRisky

    return ConfirmRisky(threshold=SecurityRisk.HIGH)


class ArmordSecurityAnalyzer(SecurityAnalyzerBase):
    """Ask armord about every action. Configure with pydantic fields (the SDK base is a model)."""

    socket_path: str | None = None
    """armord socket / named pipe. Default: $ARMORD_SOCKET, else the per-user default."""
    timeout: float = 5.0
    """Seconds to wait for armord (plus the hold timeout when waiting on holds)."""
    cwd: str | None = None
    """Agent working directory, so relative paths resolve the way the agent sees them."""
    session_id: str | None = None
    wait_on_hold: bool = False
    """Wait on armord's own hold queue instead of using OpenHands' confirmation prompt."""
    hold_timeout_ms: int = 120_000

    # Private state (pydantic turns underscore annotations into private attributes).
    _decisions: dict[str, dict[str, Any]] | None = None

    # -- the SecurityAnalyzerBase interface ----------------------------------------------------

    def security_risk(self, action: Any) -> SecurityRisk:
        return risk_for(self.decide(action))

    def analyze_action(self, action: Any) -> SecurityAnalysis:
        d = self.decide(action)
        details = {
            "armord": {
                "verdict": d.get("verdict"),
                "final": d.get("final"),
                "reason": d.get("reason"),
                "statementId": d.get("statementId"),
                "holdId": d.get("holdId"),
                "holdOutcome": d.get("holdOutcome"),
            }
        }
        if d.get("final") == "block":
            details["rejection_reason"] = f"ArmorIQ blocked this action: {d.get('reason')}"
        return SecurityAnalysis(risk=risk_for(d), details=details)

    # -- armord ------------------------------------------------------------------------------

    def _client(self, extra_wait: float = 0.0) -> ArmordClient:
        return ArmordClient(self.socket_path, timeout=self.timeout + extra_wait)

    def decide(self, action: Any) -> dict[str, Any]:
        """The armord decision for an ActionEvent (or legacy Action). Never raises; fails closed."""
        try:
            req = build_request(action, cwd=self.cwd, session_id=self.session_id)
        except Exception as exc:  # noqa: BLE001
            return self._remember(action, _block(f"armord could not read this action ({exc}); failing closed"))
        extra = 0.0
        if self.wait_on_hold:
            req["waitOnHold"] = True
            req["holdTimeoutMs"] = int(self.hold_timeout_ms)
            extra = self.hold_timeout_ms / 1000.0
        try:
            d = self._client(extra).decide(req)
        except ArmordUnavailable as exc:
            d = _block(f"{exc}; failing closed")
        return self._remember(action, d)

    def _remember(self, action: Any, d: dict[str, Any]) -> dict[str, Any]:
        if self._decisions is None:
            self._decisions = {}
        self._decisions[_key(action)] = d
        if len(self._decisions) > 1000:
            for k in list(self._decisions)[:200]:
                del self._decisions[k]
        return d

    def last_decision(self, action: Any) -> dict[str, Any] | None:
        return (self._decisions or {}).get(_key(action))

    def rejection_for(self, pending_actions: Any) -> str | None:
        """The reason to reject, if armord blocked any of these pending actions; else None."""
        for action in pending_actions or []:
            d = self.last_decision(action) or self.decide(action)
            if d.get("final") == "block":
                return f"ArmorIQ blocked this action: {d.get('reason')}"
        return None


def pending_actions(conversation: Any) -> list[Any]:
    """ActionEvents the conversation has not executed or rejected yet (openhands-sdk)."""
    from openhands.sdk.conversation.state import ConversationState

    state = conversation.state
    events = state.active_branch() if hasattr(state, "active_branch") else state.events
    return ConversationState.get_unmatched_actions(events)


def reject_blocked(conversation: Any, analyzer: ArmordSecurityAnalyzer) -> str | None:
    """If armord blocked a pending action, reject the pending actions and return the reason."""
    reason = analyzer.rejection_for(pending_actions(conversation))
    if reason:
        conversation.reject_pending_actions(reason)
    return reason


def _key(action: Any) -> str:
    for attr in ("id", "tool_call_id"):
        v = getattr(action, attr, None)
        if isinstance(v, (str, int)) and v != "":
            return f"{attr}:{v}"
    return f"obj:{id(action)}"
