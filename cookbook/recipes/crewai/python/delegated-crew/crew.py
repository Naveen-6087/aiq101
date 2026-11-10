"""Two agent incident crew on CrewAI where the lead delegates a narrower ArmorIQ token to a log analyst.

The incident lead holds an intent token for the whole incident plan (read metrics, read logs,
restart). It delegates a token to the log analyst that only allows the two reads. Both agents
get the same toolbox; what they may actually do is decided by the token behind each tool.

    python crew.py
"""

import os
import sys

from crewai import Agent, Crew, Process, Task
from crewai.llm import LLM
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from dotenv import load_dotenv

from armoriq_sdk import ArmorIQClient, ArmorIQException

from armoriq_tools import Authority, incident_tools

load_dotenv()

MCP_NAME = os.environ.get("INCIDENT_OPS_MCP_NAME", "incident-ops")
ALERT = "checkout p95 latency is 4.2s against a 380ms baseline, and error rate is above 3%."
CHILD_ACTIONS = ["get_metrics", "search_logs"]  # what the analyst is trusted with


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"[ERROR] {name} environment variable is required. Copy .env.example to .env and fill it in.")
        sys.exit(1)
    return value


def public_key_hex(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )
    return raw.hex()


def build_crew(client: ArmorIQClient, user_email: str) -> Crew:
    model_name = os.environ.get("GEMINI_MODEL", "gemini-flash-lite-latest")

    # 1. The lead's plan: everything the incident might need. One token covers it.
    plan = client.capture_plan(
        llm=model_name,
        prompt=f"Respond to the checkout latency alert: {ALERT}",
        plan={
            "goal": "Respond to the checkout latency alert",
            "steps": [
                {"action": "get_metrics", "mcp": MCP_NAME, "params": {"service": "checkout"}},
                {"action": "search_logs", "mcp": MCP_NAME, "params": {"service": "checkout"}},
                {"action": "restart_service", "mcp": MCP_NAME, "params": {"service": "checkout"}},
            ],
        },
    )
    lead_token = client.get_intent_token(plan, validity_seconds=1800, user_email=user_email)

    # 2. Delegate a narrower token to the analyst: the two reads, nothing else, for 15 minutes.
    analyst_key = Ed25519PrivateKey.generate()  # the analyst's own identity; the token is bound to it
    delegation = client.delegate(
        lead_token,
        delegate_public_key=public_key_hex(analyst_key),
        validity_seconds=900,
        allowed_actions=CHILD_ACTIONS,
        target_agent="log-analyst",
        subtask={"goal": "Diagnose the checkout latency alert", "service": "checkout"},
    )
    print(f"[crew] delegation {delegation.delegation_id}: log-analyst may {', '.join(CHILD_ACTIONS)}", flush=True)

    lead = Authority("incident-lead", client, lead_token, user_email, MCP_NAME)
    analyst = Authority("log-analyst", client, delegation.delegated_token, user_email, MCP_NAME)

    model = LLM(model=f"gemini/{model_name}", api_key=os.environ["GEMINI_API_KEY"])

    log_analyst = Agent(
        role="Log Analyst",
        goal="Find the cause of a production alert from metrics and logs",
        backstory="An SRE who reads dashboards and logs carefully and reports what the evidence shows.",
        tools=incident_tools(analyst),
        llm=model,
        verbose=True,
    )
    incident_lead = Agent(
        role="Incident Lead",
        goal="Decide on and carry out the remediation for a production incident",
        backstory="The on call incident commander. Owns any action that changes production.",
        tools=incident_tools(lead),
        llm=model,
        verbose=True,
    )

    diagnose = Task(
        description=(
            f"Alert: {ALERT} Investigate the checkout service: read its metrics, search its logs "
            "for errors, and if it looks stuck, restart it. Report what you found and what you did."
        ),
        expected_output="The likely cause, the evidence, and whether checkout was restarted.",
        agent=log_analyst,
    )
    remediate = Task(
        description=(
            "Read the analyst's report. If checkout still needs a restart, restart it. "
            "Then write a two sentence incident update."
        ),
        expected_output="A two sentence incident update that says what was done.",
        agent=incident_lead,
        context=[diagnose],
    )

    # cache=False: the analyst's refused restart must not be served from cache to the lead.
    return Crew(
        agents=[log_analyst, incident_lead],
        tasks=[diagnose, remediate],
        process=Process.sequential,
        cache=False,
        verbose=True,
    )


def main() -> None:
    api_key = require_env("ARMORIQ_API_KEY")
    require_env("GEMINI_API_KEY")
    user_email = os.environ.get("USER_EMAIL", "developer@armoriq.ai")
    client = ArmorIQClient(api_key=api_key)
    try:
        crew = build_crew(client, user_email)
        result = crew.kickoff()
    except ArmorIQException as e:
        print(f"[crew] ArmorIQ refused to set up the crew: {type(e).__name__}: {e}")
        return
    finally:
        client.close()
    print("\n--------------------------------------------------")
    print("INCIDENT UPDATE:\n")
    print(result)


if __name__ == "__main__":
    main()
