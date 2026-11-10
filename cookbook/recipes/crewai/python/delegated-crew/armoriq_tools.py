"""CrewAI tools that run every call through ArmorIQ's invoke(), with whatever token their agent holds.

This is the raw client pattern from the ArmorIQ docs ("Custom frameworks"), not ArmorIQCrew.
Each tool instance is bound to one Authority: the token an agent was given. The parent agent's
tools carry the parent's intent token; the sub-agent's tools carry the narrower token that
client.delegate() returned. Same tool code, different authority.
"""

import json
from dataclasses import dataclass
from typing import Any, Type

from crewai.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field

from armoriq_sdk import ArmorIQException, PolicyBlockedException


@dataclass
class Authority:
    """Who is acting, and with which token."""

    agent: str           # a label for logs and refusals, e.g. "incident-lead"
    client: Any          # the ArmorIQClient
    token: Any           # an IntentToken: the parent's, or a delegated one
    user_email: str      # the end user the whole crew acts for
    mcp: str             # the registered MCP server name


class ServiceInput(BaseModel):
    service: str = Field(..., description="Service name, e.g. 'checkout'")


class LogSearchInput(BaseModel):
    service: str = Field(..., description="Service name, e.g. 'checkout'")
    query: str = Field(..., description="Text to look for in the log lines, e.g. 'error'")


class ArmorIQTool(BaseTool):
    """One MCP action, invoked through ArmorIQ with the bound agent's token."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    action: str
    authority: Any = Field(exclude=True)

    def _run(self, **params) -> str:
        auth: Authority = self.authority
        try:
            result = auth.client.invoke(
                mcp=auth.mcp,
                action=self.action,
                intent_token=auth.token,
                params=params,
                user_email=auth.user_email,
            )
            return json.dumps(result.result, default=str)
        except PolicyBlockedException as e:
            # Hand the refusal back to the model as an observation, so the agent can adapt.
            return (f"REFUSED by ArmorIQ: {auth.agent} may not call {self.action} "
                    f"({e.reason or e}). Escalate to whoever holds that authority.")
        except ArmorIQException as e:
            return f"REFUSED by ArmorIQ: {type(e).__name__}: {e}"


def incident_tools(authority: Authority) -> list[ArmorIQTool]:
    """The full incident toolbox, bound to one agent's authority."""
    return [
        ArmorIQTool(
            name="get_metrics", action="get_metrics", authority=authority, args_schema=ServiceInput,
            description="Read current latency, error rate, CPU, and connection pool metrics for a service.",
        ),
        ArmorIQTool(
            name="search_logs", action="search_logs", authority=authority, args_schema=LogSearchInput,
            description="Search the last 15 minutes of a service's logs for lines containing a query.",
        ),
        ArmorIQTool(
            name="restart_service", action="restart_service", authority=authority, args_schema=ServiceInput,
            description="Rolling restart of every instance of a service. Drops in flight requests.",
        ),
    ]
