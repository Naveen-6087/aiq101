"""A scripted Strands model that stands in for Gemini. It picks tool calls from the user's request."""

import json

from strands.models.model import Model

TCK_1001 = "TCK-1001"
TCK_1002 = "TCK-1002"
TCK_1003 = "TCK-1003"


def _script(request):
    """Tool calls the model 'decides' on, in order, for a request."""
    if TCK_1002 in request:
        # The model reads the injected ticket, believes it, and tries to comply.
        return [
            ("get_ticket", {"ticket_id": TCK_1002}),
            ("issue_refund", {"ticket_id": TCK_1002, "amount": 5000}),
            ("close_account", {"account_id": "ACC-2002"}),
        ]
    if TCK_1003 in request:
        return [
            ("get_ticket", {"ticket_id": TCK_1003}),
            ("issue_refund", {"ticket_id": TCK_1003, "amount": 45}),
        ]
    return [
        ("get_ticket", {"ticket_id": TCK_1001}),
        (
            "reply_to_ticket",
            {
                "ticket_id": TCK_1001,
                "message": "Sorry your order arrived late. A $10 credit is on the way.",
            },
        ),
    ]


def _first_user_text(messages):
    for message in messages:
        if message["role"] == "user":
            for block in message["content"]:
                if "text" in block:
                    return block["text"]
    return ""


def _tool_results(messages):
    results = []
    for message in messages:
        for block in message["content"]:
            if "toolResult" in block:
                results.append(
                    " ".join(item.get("text", json.dumps(item.get("json", ""))) for item in block["toolResult"]["content"])
                )
    return results


def _final_answer(results):
    refused = [r for r in results if "ArmorIQ" in r]
    if refused:
        return "ArmorIQ stopped part of that request, so I did not complete it. " + " | ".join(refused)
    return "Done. Every step I took was allowed by policy."


class ScriptedModel(Model):
    def __init__(self, **config):
        self.config = dict(config)

    def update_config(self, **model_config):
        self.config.update(model_config)

    def get_config(self):
        return self.config

    async def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise NotImplementedError("the scripted model does not do structured output")
        yield  # pragma: no cover

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        steps = _script(_first_user_text(messages))
        done = sum(1 for m in messages if m["role"] == "assistant" for b in m["content"] if "toolUse" in b)
        yield {"messageStart": {"role": "assistant"}}
        if done < len(steps):
            name, args = steps[done]
            yield {"contentBlockStart": {"start": {"toolUse": {"name": name, "toolUseId": f"offline-{done + 1}"}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(args)}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockDelta": {"delta": {"text": _final_answer(_tool_results(messages)) + "\n"}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}, "metrics": {"latencyMs": 0}}}
