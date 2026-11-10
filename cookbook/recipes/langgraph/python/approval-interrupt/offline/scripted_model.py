"""A scripted LangChain chat model that stands in for OpenAI. It picks tool calls from the request.

It returns real AIMessage tool calls, so the graph's policy_gate, human_review, and run_tools
nodes see exactly what they would see from a live model.
"""

from typing import Any, List, Optional

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult


def _script(request: str):
    """Tool calls the model 'decides' on, in order, for a request."""
    if "disk" in request.lower():
        return [
            ("get_service_status", {"service": "db-primary"}),
            # The shortcut a tired human might take, and the one the policy exists to stop.
            ("delete_volume", {"volume": "db-primary-wal-archive"}),
        ]
    return [
        ("get_service_status", {"service": "checkout-api"}),
        ("read_recent_logs", {"service": "checkout-api", "lines": 20}),
        (
            "restart_service",
            {
                "service": "checkout-api",
                "reason": "Connection pool to payments-db exhausted; pool_size=200 takes effect on restart.",
            },
        ),
    ]


def _final_answer(results: List[str]) -> str:
    refused = [r for r in results if r.startswith("ArmorIQ")]
    if refused:
        return "I could not finish. " + " | ".join(refused) + " A human on-call engineer should take it from here."
    return "Done. checkout-api was restarted with the larger connection pool and is healthy again."


class ScriptedChatModel(BaseChatModel):
    def __init__(self, **_ignored: Any) -> None:
        # Accepts and ignores the live model's settings (model name, api key).
        super().__init__()

    @property
    def _llm_type(self) -> str:
        return "scripted-offline"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> ChatResult:
        request = next((str(m.content) for m in messages if isinstance(m, HumanMessage)), "")
        results = [str(m.content) for m in messages if isinstance(m, ToolMessage)]
        done = sum(1 for m in messages if isinstance(m, AIMessage) and m.tool_calls)
        steps = _script(request)
        if done < len(steps):
            name, args = steps[done]
            message = AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"offline-{done + 1}"}])
        else:
            message = AIMessage(content=_final_answer(results))
        return ChatResult(generations=[ChatGeneration(message=message)])
