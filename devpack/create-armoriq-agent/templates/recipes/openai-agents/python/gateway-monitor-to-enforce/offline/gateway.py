"""Offline stand-in for ArmorIQ Intent Gateway, speaking the OpenAI Chat Completions API.

Stdlib HTTP server plus PyYAML. No keys, no network beyond 127.0.0.1. It does what the real
gateway does with each model turn, with a scripted provider in place of OpenAI:

  /v1/t/<key>/chat/completions          record only: the reply passes through, nothing is checked
  /v1/t/<key>/a/<agent>/chat/completions
      monitor mode on   every tool call passes; each gets the verdict policy WOULD have given
      monitor mode off  blocked (and held) tool calls are removed and the reply's text ends with
                        'Tool call "<name>" was blocked by policy: <rule>'

Decisions come from this recipe's policy.yaml (a rule naming the tool, else default_action).
Run it on its own to point agent.py at it by hand:

    python offline/gateway.py            # serves on 127.0.0.1:8787, enforce mode
    OFFLINE_MONITOR_MODE=on python offline/gateway.py
"""

import json
import os
import re
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

import scripted_provider

RECIPE_DIR = Path(__file__).resolve().parent.parent
ROUTE = re.compile(r"^/v1/t/(?P<key>[^/]+)(?:/a/(?P<agent>[^/]+))?/chat/completions$")
VERDICT_LABEL = {"allow": "ALLOWED", "hold": "HELD", "block": "BLOCKED"}


def log(line):
    print(f"[armoriq] {line}", flush=True)


def note(line):
    print(f"[gateway] {line}", flush=True)


def load_policy():
    path = Path(os.environ.get("OFFLINE_POLICY", RECIPE_DIR / "policy.yaml"))
    with open(path, encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def decide(policy, tool):
    """Return (action, reason, rule id) for a tool name, from the policy file only."""
    name = policy.get("name", "policy")
    seen = Counter()
    for rule in policy.get("rules") or []:
        index = seen[rule.get("tool")]
        seen[rule.get("tool")] += 1
        if rule.get("tool") == tool:
            action = rule["action"]
            return action, f"policy {name}: {tool} -> {action}", f"{action}:{tool}#{index}"
    action = policy.get("default_action", "block")
    return action, f"policy {name}: no rule for {tool}, default_action -> {action}", f"default_action:{action}"


def first_user_text(messages):
    for message in messages:
        if message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, list):
                content = " ".join(part.get("text", "") for part in content if isinstance(part, dict))
            return str(content or "")
    return ""


class StandInGateway:
    def __init__(self, monitor_mode=None):
        if monitor_mode is None:
            monitor_mode = os.environ.get("OFFLINE_MONITOR_MODE", "off").strip().lower() in ("on", "1", "true")
        self.monitor_mode = monitor_mode
        self.would = Counter()  # (tool, verdict) -> count, for "What policy would have done"
        self._server = None
        self._seen_users = set()

    # -- one model turn -------------------------------------------------------------------
    def handle(self, agent_id, user_email, body):
        messages = body.get("messages") or []
        content, calls = scripted_provider.respond(messages)
        tool_calls = [
            {"id": f"call_{len(messages)}_{i}", "type": "function",
             "function": {"name": name, "arguments": json.dumps(args)}}
            for i, (name, args) in enumerate(calls)
        ]
        names = [call["function"]["name"] for call in tool_calls]
        if user_email and user_email not in self._seen_users:
            self._seen_users.add(user_email)
            note(f"request from {user_email} (X-User-Email, not forwarded to the provider)")

        if tool_calls and agent_id is None:
            note(f"recorded: {', '.join(names)} (no agent in the URL, nothing checked)")
        elif tool_calls:
            policy = load_policy()
            log(f"plan: {first_user_text(messages)} -> {', '.join(names)}")
            kept, notes = [], []
            for call in tool_calls:
                tool = call["function"]["name"]
                action, reason, rule = decide(policy, tool)
                label = VERDICT_LABEL.get(action, "BLOCKED")
                if self.monitor_mode:
                    self.would[(tool, action)] += 1
                    prefix = "monitor mode" if action == "allow" else f"monitor mode: would {action}, nothing stopped"
                    log(f"check {tool}: {label} ({prefix}; {reason})")
                    log(f"args {tool}: {call['function']['arguments']}")
                    kept.append(call)
                    continue
                if action == "hold":
                    reason += "; hold acts as block at the gateway today"
                log(f"check {tool}: {label} ({reason})")
                log(f"args {tool}: {call['function']['arguments']}")
                if action == "allow":
                    kept.append(call)
                else:
                    notes.append(f'Tool call "{tool}" was blocked by policy: {rule}')
            tool_calls = kept
            if notes:
                content = "\n\n".join(part for part in [content, "\n".join(notes)] if part)

        message = {"role": "assistant", "content": content}
        if tool_calls:
            message["tool_calls"] = tool_calls
        return {
            "id": f"chatcmpl-offline-{len(messages)}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": body.get("model", "offline-model"),
            "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_calls else "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    def print_report(self):
        """The offline version of the dashboard's 'What policy would have done' panel."""
        blocked = sum(n for (_, v), n in self.would.items() if v == "block")
        held = sum(n for (_, v), n in self.would.items() if v == "hold")
        allowed = sum(n for (_, v), n in self.would.items() if v == "allow")
        note(f"What policy would have done: {blocked} would block, {held} would hold, {allowed} allowed")
        for (tool, verdict), count in sorted(self.would.items()):
            note(f"  {tool:<16} {verdict:<6} x{count}")

    # -- HTTP -------------------------------------------------------------------------------
    def start(self, port=0):
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                match = ROUTE.match(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                if not match:
                    return self._send(404, {"error": {"message": (
                        f"stand-in gateway: {self.path} is not served. Intent Gateway supports "
                        "Chat Completions (/chat/completions), not the Responses API."), "type": "not_found"}})
                if not self.headers.get("Authorization", "").startswith("Bearer "):
                    return self._send(401, {"error": {"message": "missing provider key", "type": "auth"}})
                reply = gateway.handle(match.group("agent"), self.headers.get("X-User-Email"), json.loads(raw or b"{}"))
                self._send(200, reply)

            def _send(self, status, payload):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def stop(self):
        if self._server:
            self._server.shutdown()
            self._server.server_close()


if __name__ == "__main__":
    standin = StandInGateway()
    url = standin.start(int(os.environ.get("OFFLINE_GATEWAY_PORT", "8787")))
    note(f"stand-in gateway on {url} (monitor mode {'on' if standin.monitor_mode else 'off'})")
    note(f"set ARMORIQ_GATEWAY_HOST={url} and run agent.py; Ctrl+C to stop")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        standin.stop()
