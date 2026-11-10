"""End to end against the real armord daemon (`node dist/cli.js start`), when it is built.

Uses the adapter test policy (test/fixtures/adapters/policy.yaml), a throwaway ARMORD_HOME and a
private socket / pipe, so it never touches the user's own daemon. Skipped if node or dist/ is missing.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from armord_openhands import ArmordClient, ArmordSecurityAnalyzer, ArmordUnavailable, SecurityRisk

ROOT = Path(__file__).resolve().parents[3]  # armord/
CLI = ROOT / "dist" / "cli.js"
POLICY = ROOT / "test" / "fixtures" / "adapters" / "policy.yaml"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(not NODE or not CLI.exists() or not POLICY.exists(), reason="needs node and a built armord (npm run build)")


@dataclass
class TerminalAction:
    command: str


@dataclass
class FileEditorAction:
    command: str
    path: str


@dataclass
class MCPToolAction:
    data: dict[str, Any]


@dataclass
class ActionEvent:
    action: Any
    tool_name: str
    id: str


@pytest.fixture(scope="module")
def daemon():
    home = Path(tempfile.mkdtemp(prefix="armord-oh-"))
    (home / "policies").mkdir()
    shutil.copy(POLICY, home / "policies" / "policy.yaml")
    sock = rf"\\.\pipe\armord-oh-{os.getpid()}-{uuid.uuid4().hex[:8]}" if sys.platform == "win32" else str(home / "a.sock")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ARMORD_", "ARMORIQ_"))}
    env.update(ARMORD_HOME=str(home), ARMORD_SOCKET=sock, ARMORD_OFFLINE="1", ARMORD_AUDIT="off")
    proc = subprocess.Popen([NODE, str(CLI), "start"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    lines: list[str] = []
    threading.Thread(target=lambda: [lines.append(l) for l in proc.stderr], daemon=True).start()  # type: ignore[union-attr]
    client = ArmordClient(sock, timeout=2)
    for _ in range(150):
        try:
            client.call("ping")
            break
        except ArmordUnavailable:
            if proc.poll() is not None:
                pytest.fail("armord exited: " + "".join(lines))
            time.sleep(0.1)
    else:
        proc.kill()
        pytest.fail("armord did not start: " + "".join(lines))
    yield {"socket": sock, "env": env, "cwd": str(home / "project"), "stderr": lines}
    proc.kill()
    proc.wait(10)


def e(action: Any, tool: str, n: int) -> ActionEvent:
    return ActionEvent(action, tool, f"evt-{n}")


def test_real_daemon_verdicts(daemon) -> None:
    a = ArmordSecurityAnalyzer(socket_path=daemon["socket"], cwd=daemon["cwd"])
    assert a.security_risk(e(TerminalAction("ls -la"), "terminal", 1)) == SecurityRisk.LOW
    held = a.analyze_action(e(TerminalAction("make deploy"), "terminal", 2))
    assert held.risk == SecurityRisk.HIGH and held.details["armord"]["verdict"] == "hold"
    secret = e(FileEditorAction("view", ".env"), "file_editor", 3)
    assert a.security_risk(secret) == SecurityRisk.HIGH
    assert "st-files-block-0" in (a.rejection_for([secret]) or "")
    assert a.security_risk(e(MCPToolAction({"id": "7"}), "delete_note", 4)) == SecurityRisk.HIGH
    assert a.security_risk(e(MCPToolAction({"id": "7"}), "read_note", 5)) == SecurityRisk.LOW


def test_real_daemon_hold_released_by_armord_approve(daemon) -> None:
    a = ArmordSecurityAnalyzer(socket_path=daemon["socket"], cwd=daemon["cwd"], wait_on_hold=True, hold_timeout_ms=15_000)
    result: dict[str, Any] = {}
    t = threading.Thread(target=lambda: result.update(risk=a.security_risk(e(TerminalAction("make deploy"), "terminal", 10))))
    t.start()
    client = ArmordClient(daemon["socket"], timeout=2)
    hold_id = None
    for _ in range(100):
        holds = client.call("holds.list")
        if holds:
            hold_id = holds[0]["id"]
            break
        time.sleep(0.05)
    assert hold_id, "no hold appeared"
    done = subprocess.run([NODE, str(CLI), "approve", hold_id], env=daemon["env"], capture_output=True, text=True, timeout=30)
    assert done.returncode == 0, done.stderr
    t.join(20)
    assert result.get("risk") == SecurityRisk.LOW
