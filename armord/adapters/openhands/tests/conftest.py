"""A fake armord: speaks the NDJSON protocol on a Unix socket (POSIX) or a named pipe (Windows)."""

from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import threading
import uuid
from collections.abc import Callable, Iterator
from typing import Any

import pytest

# Make the package importable without installing it.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

Handler = Callable[[dict[str, Any]], Any]
"""Gets the request; returns a dict (sent as JSON), bytes (sent raw), or None (close, no answer)."""


class FakeArmord:
    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.requests: list[dict[str, Any]] = []
        self._stop = threading.Event()
        if sys.platform == "win32":
            self.path = rf"\\.\pipe\armord-fake-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        else:
            self.path = os.path.join(tempfile.mkdtemp(prefix="armord-fake-"), "a.sock")

    def reply(self, line: bytes) -> bytes | None:
        req = json.loads(line)
        self.requests.append(req)
        out = self.handler(req)
        if out is None:
            return None
        if isinstance(out, bytes):
            return out
        return (json.dumps(out) + "\n").encode()

    # -- POSIX -----------------------------------------------------------------------------
    def _serve_unix(self) -> None:
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(self.path)
        srv.listen(8)
        srv.settimeout(0.1)
        self._ready.set()
        while not self._stop.is_set():
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            threading.Thread(target=self._handle_unix, args=(conn,), daemon=True).start()
        srv.close()

    def _handle_unix(self, conn: socket.socket) -> None:
        with conn:
            buf = b""
            while b"\n" not in buf:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                buf += chunk
            out = self.reply(buf.split(b"\n", 1)[0])
            if out:
                conn.sendall(out)

    # -- Windows ---------------------------------------------------------------------------
    def _new_pipe(self) -> int:
        import _winapi

        return _winapi.CreateNamedPipe(
            self.path,
            _winapi.PIPE_ACCESS_DUPLEX,
            0,  # PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT (all 0)
            _winapi.PIPE_UNLIMITED_INSTANCES,
            65536,
            65536,
            0,
            _winapi.NULL,
        )

    def _serve_pipe(self) -> None:
        import _winapi

        handle = self._new_pipe()
        self._ready.set()
        while not self._stop.is_set():
            try:
                _winapi.ConnectNamedPipe(handle, False)
            except OSError as exc:
                if getattr(exc, "winerror", None) != 535:  # ERROR_PIPE_CONNECTED is fine
                    break
            current, handle = handle, self._new_pipe()  # next instance exists before we answer
            if self._stop.is_set():
                _winapi.CloseHandle(current)
                break
            threading.Thread(target=self._handle_pipe, args=(current,), daemon=True).start()
        _winapi.CloseHandle(handle)

    def _handle_pipe(self, handle: int) -> None:
        import _winapi

        try:
            buf = b""
            while b"\n" not in buf:
                data, _err = _winapi.ReadFile(handle, 65536, False)
                if not data:
                    return
                buf += data
            out = self.reply(buf.split(b"\n", 1)[0])
            if out:
                _winapi.WriteFile(handle, out, False)
        except OSError:
            pass
        finally:
            _winapi.CloseHandle(handle)  # closing the server end disconnects the client

    # -- lifecycle -------------------------------------------------------------------------
    def start(self) -> FakeArmord:
        self._ready = threading.Event()
        target = self._serve_pipe if sys.platform == "win32" else self._serve_unix
        self._thread = threading.Thread(target=target, daemon=True)
        self._thread.start()
        assert self._ready.wait(5)
        return self

    def stop(self) -> None:
        self._stop.set()
        if sys.platform == "win32":
            try:  # unblock ConnectNamedPipe
                with open(self.path, "r+b", buffering=0):
                    pass
            except OSError:
                pass
        self._thread.join(5)


@pytest.fixture
def fake_armord() -> Iterator[Callable[[Handler], FakeArmord]]:
    servers: list[FakeArmord] = []

    def make(handler: Handler) -> FakeArmord:
        s = FakeArmord(handler).start()
        servers.append(s)
        return s

    yield make
    for s in servers:
        s.stop()


def decision(verdict: str, final: str | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "id": "d-1",
        "verdict": verdict,
        "final": final or verdict,
        "reason": f"{verdict} by local:test#st-1 (local layer)",
        "statementId": "st-1",
        "tool": "x",
        **extra,
    }
