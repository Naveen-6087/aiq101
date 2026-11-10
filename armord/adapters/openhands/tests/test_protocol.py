"""Protocol and mapping tests against a fake armord. No OpenHands install needed.

Action classes below are stand-ins with the SDK's / legacy app's class names and fields; the
adapter keys on class name and attributes, so these exercise the same paths as the real ones.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Any

import pytest
from conftest import decision

from armord_openhands import ArmordClient, ArmordSecurityAnalyzer, ArmordUnavailable, SecurityRisk, build_request, default_socket_path


# --- SDK-shaped (openhands-sdk / openhands-tools) -------------------------------------------
@dataclass
class TerminalAction:
    command: str
    is_input: bool = False
    timeout: float | None = None
    reset: bool = False


@dataclass
class FileEditorAction:
    command: str
    path: str
    file_text: str | None = None
    old_str: str | None = None
    new_str: str | None = None


@dataclass
class BrowserNavigateAction:
    url: str
    new_tab: bool = False


@dataclass
class BrowserClickAction:
    index: int


@dataclass
class MCPToolAction:
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class ActionEvent:
    action: Any
    tool_name: str
    id: str
    tool_call_id: str = "call-1"


# --- legacy V0 app (openhands-ai, removed April 2026) ---------------------------------------
@dataclass
class CmdRunAction:
    command: str
    is_input: bool = False
    cwd: str | None = None


@dataclass
class FileReadAction:
    path: str
    start: int = 0
    end: int = -1


@dataclass
class FileWriteAction:
    path: str
    content: str


@dataclass
class FileEditAction:
    path: str
    command: str = ""
    old_str: str | None = None
    new_str: str | None = None


@dataclass
class BrowseURLAction:
    url: str


@dataclass
class MCPAction:
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


def ev(action: Any, tool: str, n: int = 1) -> ActionEvent:
    return ActionEvent(action=action, tool_name=tool, id=f"evt-{n}")


# ------------------------------------------------------------------------------------------ mapping


def test_mapping_sdk_actions() -> None:
    assert build_request(ev(TerminalAction("ls -la"), "terminal"), cwd="/w") == {
        "tool": "terminal", "arguments": {"command": "ls -la"}, "host": "openhands", "cwd": "/w",
    }
    view = build_request(ev(FileEditorAction("view", "/w/README.md"), "file_editor"))
    assert view["tool"] == "view" and view["arguments"]["path"] == "/w/README.md"
    edit = build_request(ev(FileEditorAction("str_replace", "/w/a.py", old_str="a", new_str="b"), "file_editor"))
    assert edit["tool"] == "str_replace_editor"
    assert edit["arguments"] == {"command": "str_replace", "path": "/w/a.py", "old_str": "a", "new_str": "b"}
    assert build_request(ev(BrowserNavigateAction("https://example.com/x"), "browser_navigate"))["arguments"] == {"url": "https://example.com/x", "new_tab": False}
    assert build_request(ev(BrowserNavigateAction("https://example.com/x"), "browser_navigate"))["tool"] == "browse"
    assert build_request(ev(BrowserClickAction(3), "browser_click"))["tool"] == "browser_click"
    mcp = build_request(ev(MCPToolAction({"id": "7"}), "delete_note"), session_id="s1")
    assert mcp == {"tool": "delete_note", "arguments": {"id": "7"}, "host": "openhands", "sessionId": "s1"}


def test_mapping_legacy_actions() -> None:
    assert build_request(CmdRunAction("make deploy", cwd="/repo")) == {
        "tool": "execute_bash", "arguments": {"command": "make deploy"}, "host": "openhands", "cwd": "/repo",
    }
    assert build_request(FileReadAction("~/.ssh/id_rsa"))["tool"] == "read_file"
    assert build_request(FileReadAction("~/.ssh/id_rsa"))["arguments"]["path"] == "~/.ssh/id_rsa"
    assert build_request(FileWriteAction("a.txt", "x")) == {"tool": "write_file", "arguments": {"path": "a.txt", "content": "x"}, "host": "openhands"}
    assert build_request(FileEditAction("a.txt", command="view"))["tool"] == "read_file"
    assert build_request(FileEditAction("a.txt", command="str_replace", old_str="a", new_str="b"))["tool"] == "edit_file"
    assert build_request(BrowseURLAction("https://evil.example/"))["arguments"] == {"url": "https://evil.example/"}
    assert build_request(MCPAction("create_issue", {"title": "t"})) == {"tool": "create_issue", "arguments": {"title": "t"}, "host": "openhands"}


# ------------------------------------------------------------------------------------------ client


def test_default_socket_path(monkeypatch: pytest.MonkeyPatch) -> None:
    assert default_socket_path({"ARMORD_SOCKET": "/tmp/x.sock"}) == "/tmp/x.sock"
    p = default_socket_path({})
    if sys.platform == "win32":
        assert p.startswith("\\\\.\\pipe\\armord-")
    else:
        assert p.endswith("/.armoriq/armord.sock")


def test_client_speaks_ndjson(fake_armord) -> None:
    srv = fake_armord(lambda req: {"id": req["id"], "result": decision("allow")})
    c = ArmordClient(srv.path, timeout=3)
    assert c.decide({"tool": "terminal", "arguments": {"command": "ls"}})["verdict"] == "allow"
    assert srv.requests[0]["method"] == "decide"
    assert srv.requests[0]["params"] == {"tool": "terminal", "arguments": {"command": "ls"}}
    assert isinstance(srv.requests[0]["id"], int)


@pytest.mark.parametrize(
    "reply, message",
    [
        (lambda req: {"id": req["id"], "error": "unknown method decide"}, "armord error"),
        (lambda req: b"this is not json\n", "not JSON"),
        (lambda req: {"id": req["id"] + 1, "result": decision("allow")}, "does not match"),
        (lambda req: {"id": req["id"], "result": {"verdict": "maybe"}}, "unexpected result"),
        (lambda req: None, "closed"),
    ],
)
def test_client_rejects_bad_replies(fake_armord, reply, message) -> None:
    srv = fake_armord(reply)
    with pytest.raises(ArmordUnavailable, match=message):
        ArmordClient(srv.path, timeout=3).decide({"tool": "x"})


def test_client_unreachable() -> None:
    path = r"\\.\pipe\armord-nobody-home-0" if sys.platform == "win32" else "/nonexistent/armord.sock"
    with pytest.raises(ArmordUnavailable, match="not reachable"):
        ArmordClient(path, timeout=1).decide({"tool": "x"})


# ------------------------------------------------------------------------------------------ analyzer


def by_command(req: dict[str, Any]) -> dict[str, Any]:
    p = req["params"]
    cmd = p.get("arguments", {}).get("command", "")
    tool = p["tool"]
    if tool == "delete_note" or "rm -rf" in cmd:
        return {"id": req["id"], "result": decision("block")}
    if "deploy" in cmd:
        if p.get("waitOnHold"):
            outcome = "approved" if "approve-me" in cmd else "timeout"
            return {"id": req["id"], "result": decision("hold", "allow" if outcome == "approved" else "block", holdId="abcd1234", holdOutcome=outcome)}
        return {"id": req["id"], "result": decision("hold")}
    return {"id": req["id"], "result": decision("allow")}


def test_verdicts_map_to_risk(fake_armord) -> None:
    srv = fake_armord(by_command)
    a = ArmordSecurityAnalyzer(socket_path=srv.path, cwd="/w")
    assert a.security_risk(ev(TerminalAction("ls"), "terminal", 1)) == SecurityRisk.LOW
    assert a.security_risk(ev(TerminalAction("make deploy"), "terminal", 2)) == SecurityRisk.HIGH
    assert a.security_risk(ev(TerminalAction("rm -rf /"), "terminal", 3)) == SecurityRisk.HIGH
    assert srv.requests[0]["params"]["host"] == "openhands"
    assert srv.requests[0]["params"]["cwd"] == "/w"
    assert "waitOnHold" not in srv.requests[1]["params"]


def test_analyze_action_details_and_rejection(fake_armord) -> None:
    srv = fake_armord(by_command)
    a = ArmordSecurityAnalyzer(socket_path=srv.path)
    ok, held, blocked = ev(TerminalAction("ls"), "terminal", 1), ev(TerminalAction("make deploy"), "terminal", 2), ev(MCPToolAction({"id": "7"}), "delete_note", 3)
    r_ok, r_held, r_blocked = a.analyze_action(ok), a.analyze_action(held), a.analyze_action(blocked)
    assert r_ok.risk == SecurityRisk.LOW and r_ok.details["armord"]["final"] == "allow"
    assert r_held.risk == SecurityRisk.HIGH and r_held.details["armord"]["verdict"] == "hold" and "rejection_reason" not in r_held.details
    assert r_blocked.risk == SecurityRisk.HIGH
    assert r_blocked.details["rejection_reason"] == "ArmorIQ blocked this action: block by local:test#st-1 (local layer)"
    n = len(srv.requests)
    # A hold is for the human to confirm; a block is rejected outright. Cached: no second ask.
    assert a.rejection_for([ok, held]) is None
    assert a.rejection_for([ok, held, blocked]) == "ArmorIQ blocked this action: block by local:test#st-1 (local layer)"
    assert len(srv.requests) == n


def test_wait_on_hold_uses_armord_queue(fake_armord) -> None:
    srv = fake_armord(by_command)
    a = ArmordSecurityAnalyzer(socket_path=srv.path, wait_on_hold=True, hold_timeout_ms=1500)
    assert a.security_risk(ev(TerminalAction("make deploy approve-me"), "terminal", 1)) == SecurityRisk.LOW
    assert srv.requests[0]["params"]["waitOnHold"] is True
    assert srv.requests[0]["params"]["holdTimeoutMs"] == 1500
    timed_out = ev(TerminalAction("make deploy"), "terminal", 2)
    assert a.security_risk(timed_out) == SecurityRisk.HIGH
    assert a.rejection_for([timed_out]) is not None


def test_fails_closed_when_armord_is_unreachable() -> None:
    path = r"\\.\pipe\armord-nobody-home-1" if sys.platform == "win32" else "/nonexistent/armord.sock"
    a = ArmordSecurityAnalyzer(socket_path=path, timeout=1)
    e = ev(TerminalAction("ls"), "terminal")
    r = a.analyze_action(e)
    assert r.risk == SecurityRisk.HIGH
    assert r.details["armord"]["final"] == "block"
    assert "failing closed" in r.details["rejection_reason"]
    assert a.rejection_for([e]) is not None


def test_fails_closed_on_daemon_error(fake_armord) -> None:
    srv = fake_armord(lambda req: {"id": req["id"], "error": "boom"})
    a = ArmordSecurityAnalyzer(socket_path=srv.path)
    assert a.security_risk(ev(TerminalAction("ls"), "terminal")) == SecurityRisk.HIGH


def test_request_is_plain_json(fake_armord) -> None:
    srv = fake_armord(by_command)
    ArmordSecurityAnalyzer(socket_path=srv.path).security_risk(ev(FileEditorAction("create", "/w/a.py", file_text="x"), "file_editor"))
    json.dumps(srv.requests[0])  # round-trips
    assert srv.requests[0]["params"]["tool"] == "str_replace_editor"
