"""An accounts payable clerk on the OpenAI Agents SDK, governed by ArmorIQ Intent Gateway.

    python agent.py "Pay invoice INV-1042 from Acme Supplies in full"

The agent, its tools and its prompt know nothing about ArmorIQ. The only ArmorIQ change is
the base URL of the OpenAI client (see gateway_base_url below). Everything else is a plain
OpenAI Agents SDK agent.
"""

import json
import os
import sys

from dotenv import load_dotenv
from openai import AsyncOpenAI

from agents import Agent, OpenAIChatCompletionsModel, Runner, function_tool

DEFAULT_GOAL = "Pay invoice INV-1042 from Acme Supplies in full"
BLOCK_NOTE = "was blocked by policy"

# A tiny in-memory ledger stands in for your AP system.
INVOICES = {
    "INV-1041": {"supplier": "Northwind Paper", "amount": 310.00, "status": "approved"},
    "INV-1042": {"supplier": "Acme Supplies", "amount": 1250.00, "status": "approved"},
    "INV-1043": {"supplier": "Contoso Freight", "amount": 4800.00, "status": "approved"},
}


@function_tool
def lookup_invoice(invoice_id: str) -> str:
    """Look up an invoice by id and return its supplier, amount and status.

    Args:
        invoice_id: The invoice id, for example INV-1042.
    """
    invoice = INVOICES.get(invoice_id)
    if invoice is None:
        return json.dumps({"error": f"no invoice {invoice_id}"})
    return json.dumps({"invoice_id": invoice_id, **invoice})


@function_tool
def record_payment(invoice_id: str, amount: float) -> str:
    """Record a payment to the supplier of an invoice. This moves money.

    Args:
        invoice_id: The invoice id.
        amount: The amount to pay, in USD.
    """
    invoice = INVOICES.get(invoice_id)
    if invoice is None:
        return json.dumps({"error": f"no invoice {invoice_id}"})
    invoice["status"] = "paid"
    print(f"[ledger] payment recorded: {invoice_id} ${amount:,.2f} to {invoice['supplier']}", flush=True)
    return json.dumps({"invoice_id": invoice_id, "paid": amount, "status": "paid"})


def gateway_base_url():
    """The one ArmorIQ change: send model traffic to Intent Gateway instead of OpenAI.

    /v1/t/<gateway-key>             records every request, checks nothing
    /v1/t/<gateway-key>/a/<agent>   records, and checks each tool call against the agent's policy
    """
    host = os.environ.get("ARMORIQ_GATEWAY_HOST", "https://gw.armoriq.ai").rstrip("/")
    url = f"{host}/v1/t/{os.environ['ARMORIQ_GATEWAY_KEY']}"
    agent_id = os.environ.get("ARMORIQ_AGENT_ID", "").strip()
    return f"{url}/a/{agent_id}" if agent_id else url


def build_agent():
    client = AsyncOpenAI(
        base_url=gateway_base_url(),
        api_key=os.environ["OPENAI_API_KEY"],  # forwarded to OpenAI untouched
        default_headers={"X-User-Email": os.environ.get("USER_EMAIL", "dana@example.com")},
    )
    # The gateway speaks Chat Completions, not the Responses API the Agents SDK uses by
    # default, so the agent gets an explicit Chat Completions model on the gateway client.
    model = OpenAIChatCompletionsModel(model=os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"), openai_client=client)
    return Agent(
        name="AP clerk",
        instructions=(
            "You are an accounts payable clerk. Look up an invoice before acting on it. "
            "Pay only approved invoices, for exactly the invoice amount. Be brief."
        ),
        model=model,
        tools=[lookup_invoice, record_payment],
    )


def main():
    load_dotenv()
    goal = " ".join(sys.argv[1:]) or DEFAULT_GOAL
    print(f"> {goal}", flush=True)
    result = Runner.run_sync(build_agent(), goal)
    answer = str(result.final_output)
    print(f"\n{answer}\n", flush=True)
    if BLOCK_NOTE in answer:
        # A blocked call is removed from the model's reply, so the reply often has no tool
        # calls left. The Agents SDK treats that as the final answer, gateway note included.
        print("(Intent Gateway stopped a tool call; the note above names the rule.)", flush=True)
    return answer


if __name__ == "__main__":
    main()
