"""A scripted CrewAI model that stands in for Gemini. It speaks CrewAI's text tool format.

Log Analyst: metrics, logs, then tries a restart (its delegated token does not cover that), then reports.
Incident Lead: restarts checkout (its own token does), then writes the incident update.
"""

import json
import re

from crewai.llms.base_llm import BaseLLM

ANALYST_SCRIPT = [
    ("get_metrics", {"service": "checkout"}),
    ("search_logs", {"service": "checkout", "query": "db-pool"}),
    ("restart_service", {"service": "checkout"}),
]
LEAD_SCRIPT = [
    ("restart_service", {"service": "checkout"}),
]


def _text(messages):
    if isinstance(messages, str):
        return messages
    return "\n".join(str(m.get("content", "")) for m in messages)


class ScriptedLLM(BaseLLM):
    def __init__(self, model="scripted", **kwargs):
        kwargs.pop("api_key", None)
        super().__init__(model=model, **kwargs)

    def call(self, messages, tools=None, callbacks=None, available_functions=None,
             from_task=None, from_agent=None, response_model=None):
        text = _text(messages)
        lead = "You are Incident Lead" in text
        script = LEAD_SCRIPT if lead else ANALYST_SCRIPT
        # The prompt template itself mentions "Observation:", so only count what follows "Begin!".
        tail = text.split("Begin!")[-1]
        observations = re.findall(r"^Observation:\s*(.+)", tail, flags=re.M)
        if len(observations) < len(script):
            name, args = script[len(observations)]
            return f"Thought: I should call {name}.\nAction: {name}\nAction Input: {json.dumps(args)}"
        return "Thought: I now know the final answer\nFinal Answer: " + (
            self._update(observations) if lead else self._report(observations)
        )

    @staticmethod
    def _report(observations):
        refused = any("REFUSED" in o for o in observations[2:3])
        restart = ("I tried to restart checkout but ArmorIQ refused it: my delegated token only covers "
                   "get_metrics and search_logs. The incident lead needs to restart it."
                   if refused else "I restarted checkout.")
        return ("Cause: the checkout database connection pool is exhausted (200 of 200 in use) and the logs "
                "point at a connection leak in CartRepository.refresh. p95 latency is 4.2s against a 380ms "
                f"baseline. {restart}")

    @staticmethod
    def _update(observations):
        restarted = observations and "restarted" in observations[0]
        action = "The incident lead restarted checkout to clear the exhausted connection pool" if restarted \
            else "Checkout could not be restarted"
        return (f"{action}; the log analyst diagnosed a connection leak in CartRepository.refresh but was not "
                "authorized to restart production. A fix for the leak is the follow up.")

    def supports_function_calling(self):
        return False

    def get_context_window_size(self):
        return 8192
