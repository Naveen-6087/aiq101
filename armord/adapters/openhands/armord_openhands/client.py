"""Minimal synchronous client for the local armord daemon.

Protocol (armord src/ipc.ts): newline-delimited JSON over a Unix socket, or a named pipe on Windows.

    request   {"id": 1, "method": "decide", "params": {...}}\n
    response  {"id": 1, "result": {...}}\n   or   {"id": 1, "error": "message"}\n

Socket path: $ARMORD_SOCKET, else ~/.armoriq/armord.sock (POSIX) or \\\\.\\pipe\\armord-<username>
(Windows). A Windows named pipe is opened as a file.

Every failure (daemon not running, timeout, garbage reply) raises ArmordUnavailable, so callers can
fail closed.
"""

from __future__ import annotations

import getpass
import itertools
import json
import os
import socket
import sys
import threading
from pathlib import Path
from typing import Any

__all__ = ["ArmordClient", "ArmordUnavailable", "default_socket_path"]


class ArmordUnavailable(RuntimeError):
    """armord could not be asked, or did not answer usefully."""


def default_socket_path(env: dict[str, str] | None = None) -> str:
    env = dict(os.environ) if env is None else env
    if env.get("ARMORD_SOCKET"):
        return env["ARMORD_SOCKET"]
    if sys.platform == "win32":
        return rf"\\.\pipe\armord-{getpass.getuser()}"
    return str(Path.home() / ".armoriq" / "armord.sock")


def _is_windows_pipe(path: str) -> bool:
    return path.startswith("\\\\.\\pipe\\") or path.startswith("//./pipe/")


class ArmordClient:
    """One request per connection: simple, and safe to share across threads."""

    def __init__(self, socket_path: str | None = None, timeout: float = 5.0) -> None:
        self.socket_path = socket_path or default_socket_path()
        self.timeout = timeout
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    def call(self, method: str, params: dict[str, Any] | None = None, timeout: float | None = None) -> Any:
        with self._lock:
            req_id = next(self._ids)
        line = (json.dumps({"id": req_id, "method": method, "params": params or {}}) + "\n").encode("utf-8")
        wait = self.timeout if timeout is None else timeout
        try:
            raw = self._pipe_roundtrip(line, wait) if _is_windows_pipe(self.socket_path) else self._unix_roundtrip(line, wait)
        except ArmordUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 - every transport failure means "unreachable"
            raise ArmordUnavailable(f"armord not reachable at {self.socket_path}: {exc}") from exc
        try:
            msg = json.loads(raw)
        except ValueError as exc:
            raise ArmordUnavailable(f"armord sent a reply that is not JSON: {raw[:200]!r}") from exc
        if not isinstance(msg, dict) or msg.get("id") != req_id:
            raise ArmordUnavailable("armord reply does not match the request")
        if msg.get("error") is not None:
            raise ArmordUnavailable(f"armord error: {msg['error']}")
        if "result" not in msg:
            raise ArmordUnavailable("armord reply has no result")
        return msg["result"]

    def decide(self, params: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        result = self.call("decide", params, timeout)
        if not isinstance(result, dict) or result.get("verdict") not in ("allow", "hold", "block"):
            raise ArmordUnavailable(f"armord decide returned an unexpected result: {result!r}")
        return result

    # -- transports -------------------------------------------------------------------------

    def _unix_roundtrip(self, line: bytes, timeout: float) -> str:
        if not hasattr(socket, "AF_UNIX"):
            raise ArmordUnavailable(f"this Python has no AF_UNIX sockets; cannot reach {self.socket_path}")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(self.socket_path)
            sock.sendall(line)
            buf = b""
            while b"\n" not in buf:
                chunk = sock.recv(65536)
                if not chunk:
                    raise ArmordUnavailable("armord closed the connection before answering")
                buf += chunk
        return buf.split(b"\n", 1)[0].decode("utf-8")

    def _pipe_roundtrip(self, line: bytes, timeout: float) -> str:
        # Blocking file I/O on a pipe has no timeout of its own; run it on a worker thread.
        result: dict[str, Any] = {}

        def work() -> None:
            try:
                with open(self.socket_path, "r+b", buffering=0) as pipe:
                    pipe.write(line)
                    buf = b""
                    while b"\n" not in buf:
                        chunk = pipe.read(65536)
                        if not chunk:
                            raise ArmordUnavailable("armord closed the pipe before answering")
                        buf += chunk
                    result["line"] = buf.split(b"\n", 1)[0].decode("utf-8")
            except BaseException as exc:  # noqa: BLE001
                result["error"] = exc

        t = threading.Thread(target=work, name="armord-pipe", daemon=True)
        t.start()
        t.join(timeout)
        if t.is_alive():
            raise ArmordUnavailable(f"armord did not answer within {timeout}s at {self.socket_path}")
        if "error" in result:
            err = result["error"]
            raise err if isinstance(err, ArmordUnavailable) else ArmordUnavailable(f"armord not reachable at {self.socket_path}: {err}")
        return result["line"]
