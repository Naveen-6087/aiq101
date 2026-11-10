"""Small incident-ops MCP server: two reads and one remediation action, with canned data.

    python incident_ops_mcp.py           # stdio
    python incident_ops_mcp.py --http    # streamable HTTP on http://127.0.0.1:8000/mcp

Nothing is really restarted. The answers look like what a real observability stack would return,
so the crew has something to reason about.
"""

import sys

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("incident-ops")

METRICS = {
    "checkout": {"p95_latency_ms": 4210, "baseline_p95_ms": 380, "error_rate": 0.031, "cpu": 0.22,
                 "open_db_connections": 200, "db_pool_max": 200},
}

LOGS = {
    "checkout": [
        "12:04:11 WARN  db-pool: waiting for connection (200/200 in use)",
        "12:04:12 ERROR request timed out after 4000ms: GET /cart",
        "12:04:15 WARN  db-pool: connection leak suspected in CartRepository.refresh",
    ],
}


@mcp.tool()
def get_metrics(service: str) -> dict:
    """Read current latency, error rate, CPU, and connection pool metrics for a service."""
    if service not in METRICS:
        raise ValueError(f"Unknown service: {service}")
    return {"service": service, **METRICS[service]}


@mcp.tool()
def search_logs(service: str, query: str) -> dict:
    """Search the last 15 minutes of a service's logs for lines containing the query."""
    lines = [line for line in LOGS.get(service, []) if query.lower() in line.lower()] or LOGS.get(service, [])
    return {"service": service, "query": query, "lines": lines}


@mcp.tool()
def restart_service(service: str) -> dict:
    """Rolling restart of every instance of a service. Drops in flight requests."""
    if service not in METRICS:
        raise ValueError(f"Unknown service: {service}")
    return {"service": service, "status": "restarted", "instances": 6}


if __name__ == "__main__":
    if "--http" in sys.argv:
        mcp.run(transport="streamable-http")
    else:
        mcp.run()
