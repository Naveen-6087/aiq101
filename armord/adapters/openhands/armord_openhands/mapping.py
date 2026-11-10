"""Turn an OpenHands action into an armord `decide` request.

Works by class name and attributes, so it needs no OpenHands import and covers both:

* the OpenHands agent SDK (openhands-sdk / openhands-tools, current): ``ActionEvent`` wrapping
  ``TerminalAction(command)``, ``FileEditorAction(command, path, ...)``, ``BrowserNavigateAction(url)``
  and the other ``Browser*Action``s, ``MCPToolAction(data)``;
* the legacy V0 app (openhands-ai before April 2026): ``CmdRunAction(command)``,
  ``FileReadAction(path)``, ``FileEditAction(path, command)``, ``FileWriteAction(path, content)``,
  ``BrowseURLAction(url)``, ``BrowseInteractiveAction``, ``MCPAction(name, arguments)``.

Tool names are chosen from the ones armord's derivation already understands (src/derive.ts), so
the shell, file and network capabilities and derived path/host/program fields are filled in.
"""

from __future__ import annotations

import dataclasses
from typing import Any

__all__ = ["action_of", "build_request"]

# FileEditorAction / FileEditAction commands that only read.
_READ_COMMANDS = {"view"}


def action_of(event_or_action: Any) -> Any:
    """An SDK ActionEvent carries the action in `.action`; a legacy action is the action."""
    inner = getattr(event_or_action, "action", None)
    return inner if inner is not None and type(event_or_action).__name__ == "ActionEvent" else event_or_action


def _fields(action: Any) -> dict[str, Any]:
    dump = getattr(action, "model_dump", None)
    if callable(dump):
        try:
            data = dump(mode="json", exclude_none=True)
        except TypeError:
            data = dump()
        if isinstance(data, dict):
            return {k: v for k, v in data.items() if k not in ("kind",)}
    if dataclasses.is_dataclass(action) and not isinstance(action, type):
        return {f.name: getattr(action, f.name) for f in dataclasses.fields(action)}
    if isinstance(action, dict):
        return dict(action)
    return {k: v for k, v in vars(action).items() if not k.startswith("_")} if hasattr(action, "__dict__") else {}


def _jsonable(args: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in args.items():
        if v is None:
            continue
        if isinstance(v, (str, int, float, bool, list, dict)):
            out[k] = v
        else:
            out[k] = getattr(v, "value", str(v))  # enums -> value, anything else -> str
    return out


def _camel_to_snake(name: str) -> str:
    out = []
    for i, ch in enumerate(name):
        if ch.isupper() and i > 0:
            out.append("_")
        out.append(ch.lower())
    return "".join(out)


def build_request(event_or_action: Any, *, cwd: str | None = None, session_id: str | None = None) -> dict[str, Any]:
    action = action_of(event_or_action)
    cls = type(action).__name__
    tool_name = getattr(event_or_action, "tool_name", None)
    f = _fields(action)
    req: dict[str, Any]

    if cls in ("TerminalAction", "ExecuteBashAction", "CmdRunAction"):
        req = {"tool": "terminal" if cls != "CmdRunAction" else "execute_bash", "arguments": {"command": str(f.get("command", ""))}}
        if f.get("is_input"):
            req["arguments"]["is_input"] = True
        if cls == "CmdRunAction" and isinstance(f.get("cwd"), str) and f["cwd"]:
            cwd = cwd or f["cwd"]
    elif cls in ("FileEditorAction", "StrReplaceEditorAction", "FileEditAction"):
        command = str(getattr(f.get("command"), "value", f.get("command") or ""))
        reading = command in _READ_COMMANDS
        tool = ("view" if reading else "str_replace_editor") if cls != "FileEditAction" else ("read_file" if reading else "edit_file")
        req = {"tool": tool, "arguments": _jsonable(f)}
    elif cls == "FileReadAction":
        req = {"tool": "read_file", "arguments": _jsonable({"path": f.get("path"), "start": f.get("start"), "end": f.get("end")})}
    elif cls == "FileWriteAction":
        req = {"tool": "write_file", "arguments": _jsonable({"path": f.get("path"), "content": f.get("content")})}
    elif cls in ("BrowserNavigateAction", "BrowseURLAction"):
        req = {"tool": "browse", "arguments": _jsonable({"url": f.get("url"), "new_tab": f.get("new_tab")})}
    elif (cls.startswith("Browser") and cls.endswith("Action")) or cls == "BrowseInteractiveAction":
        # Clicks, typing, tab switches: no new URL of their own. Named so policy can key on them.
        req = {"tool": _camel_to_snake(cls[: -len("Action")]), "arguments": _jsonable(f)}
    elif cls == "MCPToolAction":
        data = f.get("data") if isinstance(f.get("data"), dict) else {}
        req = {"tool": str(tool_name or "mcp_tool"), "arguments": _jsonable(data)}
    elif cls == "MCPAction":
        args = f.get("arguments") if isinstance(f.get("arguments"), dict) else {}
        req = {"tool": str(f.get("name") or tool_name or "mcp_tool"), "arguments": _jsonable(args)}
    else:
        req = {"tool": str(tool_name or _camel_to_snake(cls.removesuffix("Action")) or "unknown"), "arguments": _jsonable(f)}

    req["host"] = "openhands"
    if cwd:
        req["cwd"] = cwd
    if session_id:
        req["sessionId"] = session_id
    return req
