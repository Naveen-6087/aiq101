"""On-call LangGraph agent whose tool calls go through ArmorIQ, with holds mapped onto interrupt().

    python agent.py "checkout-api is throwing 502s. Find out why and fix it."

Graph:  agent -> policy_gate -> (human_review) -> run_tools -> agent ... -> END

policy_gate asks ArmorIQ about every tool call the model chose. An ARMORIQ hold routes to
human_review, which calls LangGraph's interrupt(): the run stops, the checkpointer saves the
thread, and the caller gets the held calls (with their ArmorIQ delegation ids). The caller
resumes with Command(resume=...) once the approver has decided in ArmorIQ, and human_review
reads the decision back from ArmorIQ before anything runs.
"""

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

from dotenv import load_dotenv
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.types import Command, interrupt

from armoriq_sdk import ArmorIQClient, ReportOptions, SessionOptions
from armoriq_sdk.exceptions import ArmorIQException

from runbook_tools import TOOLS, TOOLS_BY_NAME

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

DEFAULT_GOAL = "checkout-api is throwing 502s. Find out why and fix it."

SYSTEM_PROMPT = (
    "You are an on-call SRE assistant. Investigate before you act: check status and logs first. "
    "Only take an action that changes production when the evidence supports it, and say why in the "
    "tool arguments. If a tool result says ArmorIQ blocked or did not approve a call, do not retry it; "
    "explain what a human should do instead."
)

# How long human_review waits for ArmorIQ to report the decision after the graph is resumed.
CONFIRM_SECONDS = float(os.environ.get("ARMORIQ_APPROVAL_CONFIRM_SECONDS", "30"))

Review = Callable[[dict], Awaitable[Any]]


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"[ERROR] {name} environment variable is required. Copy .env.example to .env and fill it in.")
        sys.exit(1)
    return value


class OpsState(MessagesState):
    # One entry per tool call in the latest model turn: what ArmorIQ decided and why.
    decisions: list[dict]


class ArmorIQGovernor:
    """One ArmorIQ session per graph thread, from the SDK's raw client (no framework adapter)."""

    def __init__(self, client: ArmorIQClient, user_email: str, mcp_name: str) -> None:
        self.scope = client.for_user(user_email)
        self.user_email = self.scope.user_email
        self.mcp_name = mcp_name
        self._sessions: dict[str, Any] = {}

    def session(self, config) -> Any:
        thread_id = config["configurable"]["thread_id"]
        if thread_id not in self._sessions:
            self._sessions[thread_id] = self.scope.start_session(
                SessionOptions(mode="sdk", default_mcp_name=self.mcp_name, validity_seconds=2400)
            )
        return self._sessions[thread_id]

    def close(self, thread_id: str, status: str = "ok") -> None:
        session = self._sessions.pop(thread_id, None)
        if session is not None:
            session.close(final_status=status)


def _goal(state: OpsState) -> str:
    return next((str(m.content) for m in state["messages"] if isinstance(m, HumanMessage)), "")


def build_graph(model, governor: ArmorIQGovernor, checkpointer):
    model_with_tools = model.bind_tools(TOOLS)

    async def agent(state: OpsState):
        response = await model_with_tools.ainvoke([SystemMessage(SYSTEM_PROMPT), *state["messages"]])
        return {"messages": [response]}

    async def policy_gate(state: OpsState, config):
        calls = state["messages"][-1].tool_calls
        session = governor.session(config)
        try:
            # The plan is exactly the tool calls the model chose this turn.
            await asyncio.to_thread(
                session.start_plan, [{"name": c["name"], "args": c["args"]} for c in calls], goal=_goal(state)
            )
        except ArmorIQException as exc:  # no intent token, nothing runs (fail closed)
            return {"decisions": [
                {"id": c["id"], "name": c["name"], "args": c["args"], "action": "block",
                 "reason": f"plan refused: {exc}", "delegation_id": None}
                for c in calls
            ]}
        decisions = []
        for c in calls:
            d = await asyncio.to_thread(session.check, c["name"], c["args"], user_email=governor.user_email)
            decisions.append({
                "id": c["id"], "name": c["name"], "args": c["args"],
                "action": "allow" if d.allowed else d.action,
                "reason": d.reason, "delegation_id": d.delegation_id,
            })
        return {"decisions": decisions}

    async def human_review(state: OpsState, config):
        held = [d for d in state["decisions"] if d["action"] == "hold"]
        # Everything above this line is pure, so re-running the node on resume is safe.
        # First pass: interrupt() raises, the checkpointer stores the thread, the caller gets this payload.
        # On Command(resume=...): the node re-runs and interrupt() returns the resume value.
        review = interrupt({
            "kind": "armoriq_hold",
            "held": [
                {"tool": d["name"], "args": d["args"], "reason": d["reason"], "delegation_id": d["delegation_id"]}
                for d in held
            ],
        })
        session = governor.session(config)
        decisions = []
        for d in state["decisions"]:
            if d["action"] != "hold":
                decisions.append(d)
                continue
            if not d["delegation_id"]:
                outcome = "error"  # ArmorIQ could not create the approval request; nothing to approve
            else:
                # ArmorIQ, not the resume payload, is the source of truth for the decision.
                outcome = await session.await_approval(
                    d["delegation_id"], timeout=CONFIRM_SECONDS, interval=2.0, user_email=governor.user_email
                )
            reviewer = review.get("reviewed_by") if isinstance(review, dict) else None
            decisions.append({**d, "action": "allow" if outcome == "approved" else outcome, "reviewed_by": reviewer})
        return {"decisions": decisions}

    async def run_tools(state: OpsState, config):
        session = governor.session(config)
        messages = []
        for d in state["decisions"]:
            name, args = d["name"], d["args"]
            if d["action"] == "allow" and name in TOOLS_BY_NAME:
                try:
                    result, status = await TOOLS_BY_NAME[name].ainvoke(args), "success"
                except Exception as exc:  # a tool failure is a result the model should see
                    result, status = f"error: {exc}", "error"
                await asyncio.to_thread(session.report, name, args, result, ReportOptions(status=status))
                content = result if isinstance(result, str) else json.dumps(result)
                messages.append(ToolMessage(content, tool_call_id=d["id"], name=name, status=status))
                continue
            if d["action"] == "allow":
                content = f"Unknown tool {name}. It did not run."
            elif d["action"] == "block":
                content = f"ArmorIQ blocked {name}: {d['reason']}. It did not run."
            else:  # rejected, timeout, error
                content = f"ArmorIQ hold {d['action']} for {name}: {d['reason']}. It did not run."
            messages.append(ToolMessage(content, tool_call_id=d["id"], name=name, status="error"))
        return {"messages": messages, "decisions": []}

    def after_agent(state: OpsState):
        return "policy_gate" if state["messages"][-1].tool_calls else END

    def after_gate(state: OpsState):
        return "human_review" if any(d["action"] == "hold" for d in state["decisions"]) else "run_tools"

    builder = StateGraph(OpsState)
    builder.add_node("agent", agent)
    builder.add_node("policy_gate", policy_gate)
    builder.add_node("human_review", human_review)
    builder.add_node("run_tools", run_tools)
    builder.add_edge(START, "agent")
    builder.add_conditional_edges("agent", after_agent, ["policy_gate", END])
    builder.add_conditional_edges("policy_gate", after_gate, ["human_review", "run_tools"])
    builder.add_edge("human_review", "run_tools")
    builder.add_edge("run_tools", "agent")
    return builder.compile(checkpointer=checkpointer)


async def console_review(payload: dict) -> dict:
    """Live default: show the held calls, wait for the approver to decide in ArmorIQ, then resume."""
    for item in payload["held"]:
        print(f"  HELD {item['tool']} {json.dumps(item['args'])}  delegation={item['delegation_id']}")
    print("  Approve or reject in the ArmorIQ dashboard, then press Enter to resume the graph.")
    try:
        await asyncio.to_thread(input)
    except EOFError:
        pass
    return {"reviewed_by": os.environ.get("USER_EMAIL", "developer@armoriq.ai")}


async def run(goal: str, review: Review = console_review, thread_id: str | None = None) -> str:
    armoriq_api_key = require_env("ARMORIQ_API_KEY")
    openai_api_key = require_env("OPENAI_API_KEY")
    governor = ArmorIQGovernor(
        ArmorIQClient(api_key=armoriq_api_key),
        user_email=os.environ.get("USER_EMAIL", "developer@armoriq.ai"),
        mcp_name=os.environ.get("RUNBOOK_MCP_NAME", "oncall-runbook"),
    )
    model = ChatOpenAI(model=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"), api_key=openai_api_key)
    graph = build_graph(model, governor, InMemorySaver())

    thread_id = thread_id or f"oncall-{uuid.uuid4().hex[:8]}"
    config = {"configurable": {"thread_id": thread_id}}
    try:
        result = await graph.ainvoke({"messages": [HumanMessage(goal)]}, config)
        while result.get("__interrupt__"):
            snapshot = await graph.aget_state(config)
            checkpoint = snapshot.config["configurable"]["checkpoint_id"]
            print(f"[graph] interrupted at {list(snapshot.next)}; thread {thread_id} saved at checkpoint {checkpoint}", flush=True)
            resume = await review(result["__interrupt__"][0].value)
            print(f"[graph] resuming thread {thread_id} with Command(resume={resume})", flush=True)
            result = await graph.ainvoke(Command(resume=resume), config)
    finally:
        governor.close(thread_id)
    answer = result["messages"][-1].content
    return answer if isinstance(answer, str) else str(answer)


def main() -> None:
    goal = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GOAL
    print(f"Goal: {goal}\n", flush=True)
    answer = asyncio.run(run(goal))
    print("--------------------------------------------------")
    print("Final answer:", answer)
    print("--------------------------------------------------", flush=True)


if __name__ == "__main__":
    main()
