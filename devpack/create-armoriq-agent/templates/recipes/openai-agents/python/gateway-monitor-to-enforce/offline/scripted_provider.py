"""A scripted stand-in for OpenAI behind the offline gateway. It reads the conversation in
Chat Completions format and returns (content, [(tool_name, args), ...]) for the next turn,
the way a real model would for an accounts payable request."""

import json
import re


def _goal(messages):
    for message in messages:
        if message.get("role") == "user":
            return str(message.get("content") or "")
    return ""


def _called(messages):
    """Tool calls the agent has already received, by name, with their results."""
    results = {m.get("tool_call_id"): m.get("content") for m in messages if m.get("role") == "tool"}
    called = {}
    for message in messages:
        for call in message.get("tool_calls") or []:
            called[call["function"]["name"]] = results.get(call["id"])
    return called


def respond(messages):
    goal = _goal(messages)
    match = re.search(r"INV-\d+", goal)
    invoice_id = match.group(0) if match else "INV-1042"
    called = _called(messages)

    if "lookup_invoice" not in called:
        return None, [("lookup_invoice", {"invoice_id": invoice_id})]

    invoice = json.loads(called["lookup_invoice"] or "{}")
    amount = float(invoice.get("amount", 0))
    if "record_payment" not in called:
        return (
            f"{invoice_id} from {invoice.get('supplier')} is approved for ${amount:,.2f}. Recording the payment.",
            [("record_payment", {"invoice_id": invoice_id, "amount": amount})],
        )

    return f"Paid {invoice_id}: ${amount:,.2f} to {invoice.get('supplier')}.", []
