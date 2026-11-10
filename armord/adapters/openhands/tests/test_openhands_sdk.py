"""Against the real openhands-sdk classes (skipped when openhands-sdk is not installed)."""

from __future__ import annotations

import os

import pytest
from conftest import decision

os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")
sdk = pytest.importorskip("openhands.sdk")

from openhands.sdk.event import ActionEvent  # noqa: E402
from openhands.sdk.llm import MessageToolCall, TextContent  # noqa: E402
from openhands.sdk.mcp.definition import MCPToolAction  # noqa: E402
from openhands.sdk.security.analyzer import SecurityAnalyzerBase  # noqa: E402
from openhands.sdk.security.confirmation_policy import ConfirmRisky  # noqa: E402
from openhands.sdk.security.risk import SecurityRisk  # noqa: E402

from armord_openhands import HAVE_OPENHANDS_SDK, ArmordSecurityAnalyzer, confirm_risky_policy, reject_blocked  # noqa: E402


def mcp_event(tool: str, n: int) -> ActionEvent:
    return ActionEvent(
        thought=[TextContent(text="calling a tool")],
        action=MCPToolAction(data={"id": "7"}),
        tool_name=tool,
        tool_call_id=f"call_{n}",
        tool_call=MessageToolCall(id=f"call_{n}", name=tool, arguments='{"id": "7"}', origin="completion"),
        llm_response_id=f"resp_{n}",
    )


def by_tool(req):
    tool = req["params"]["tool"]
    verdict = {"delete_note": "block", "publish_note": "hold"}.get(tool, "allow")
    return {"id": req["id"], "result": decision(verdict)}


def test_is_a_real_security_analyzer() -> None:
    assert HAVE_OPENHANDS_SDK
    a = ArmordSecurityAnalyzer(socket_path="/nowhere", timeout=0.5, cwd="/w")
    assert isinstance(a, SecurityAnalyzerBase)
    dumped = a.model_dump()
    assert dumped["kind"] == "ArmordSecurityAnalyzer"
    again = SecurityAnalyzerBase.model_validate(dumped)  # discriminated-union round trip
    assert isinstance(again, ArmordSecurityAnalyzer) and again.cwd == "/w"
    assert isinstance(confirm_risky_policy(), ConfirmRisky)


def test_real_action_events_and_confirmation(fake_armord) -> None:
    srv = fake_armord(by_tool)
    a = ArmordSecurityAnalyzer(socket_path=srv.path)
    events = [mcp_event("read_note", 1), mcp_event("publish_note", 2), mcp_event("delete_note", 3)]
    results = a.analyze_actions(events)  # the SDK's own batch entry point
    risks = [analysis.risk for _, analysis in results]
    assert risks == [SecurityRisk.LOW, SecurityRisk.HIGH, SecurityRisk.HIGH]
    assert srv.requests[0]["params"] == {"tool": "read_note", "arguments": {"id": "7"}, "host": "openhands"}
    policy = confirm_risky_policy()
    assert [policy.should_confirm(r) for r in risks] == [False, True, True]
    assert results[2][1].details["rejection_reason"].startswith("ArmorIQ blocked this action")


def test_fails_closed_with_real_types() -> None:
    a = ArmordSecurityAnalyzer(socket_path="/nowhere/armord.sock", timeout=0.5)
    assert a.security_risk(mcp_event("read_note", 1)) == SecurityRisk.HIGH


def test_reject_blocked_uses_unmatched_actions(fake_armord) -> None:
    srv = fake_armord(by_tool)
    a = ArmordSecurityAnalyzer(socket_path=srv.path)
    rejected: list[str] = []

    class State:
        events = [mcp_event("read_note", 1), mcp_event("delete_note", 2)]

    class Conversation:
        state = State()

        def reject_pending_actions(self, reason: str = "User rejected the action") -> None:
            rejected.append(reason)

    reason = reject_blocked(Conversation(), a)
    assert reason and reason.startswith("ArmorIQ blocked this action")
    assert rejected == [reason]
    State.events = [mcp_event("read_note", 3)]
    assert reject_blocked(Conversation(), a) is None
    assert len(rejected) == 1
