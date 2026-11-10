"""On-call runbook tools over a small simulated fleet, tiered by risk.

    get_service_status, read_recent_logs   read only            allow
    restart_service                          changes production   hold
    delete_volume                            destroys data        block

The fleet is an in-memory dict so the recipe runs anywhere. Swap each function body for your
real calls (Kubernetes, your cloud API, your log store); the names and arguments are what the
ArmorIQ policy matches on, so keep those stable.
"""

from langchain_core.tools import tool

FLEET = {
    "checkout-api": {
        "status": "degraded",
        "replicas": 3,
        "healthy_replicas": 1,
        "error_rate": "38% 502s over 10m",
        "logs": [
            "12:01:07 ERROR upstream connect error: pool exhausted (max=50) to payments-db",
            "12:01:09 WARN  readiness probe failed on checkout-api-7c9f-2",
            "12:01:12 ERROR upstream connect error: pool exhausted (max=50) to payments-db",
            "12:01:15 INFO  config reload pushed pool_size=200, takes effect on restart",
        ],
    },
    "db-primary": {
        "status": "warning",
        "replicas": 1,
        "healthy_replicas": 1,
        "disk": "94% used, volume db-primary-wal-archive is 61% of it",
        "logs": ["12:00:44 WARN  disk usage above 90% on /var/lib/postgres"],
    },
}


def _service(name: str) -> dict:
    if name not in FLEET:
        raise ValueError(f"Unknown service: {name}")
    return FLEET[name]


@tool
def get_service_status(service: str) -> dict:
    """Current health of a service: status, replica counts, error rate, disk."""
    info = _service(service)
    return {k: v for k, v in info.items() if k != "logs"} | {"service": service}


@tool
def read_recent_logs(service: str, lines: int = 20) -> list[str]:
    """The most recent log lines for a service."""
    return _service(service)["logs"][-lines:]


@tool
def restart_service(service: str, reason: str) -> dict:
    """Rolling restart of every replica of a service. Changes production."""
    info = _service(service)
    info.update(status="healthy", healthy_replicas=info["replicas"], error_rate="0% 502s")
    return {"service": service, "action": "rolling_restart", "reason": reason, "status": info["status"]}


@tool
def delete_volume(volume: str) -> dict:
    """Permanently delete a storage volume and everything on it. Irreversible."""
    return {"volume": volume, "status": "deleted"}


TOOLS = [get_service_status, read_recent_logs, restart_service, delete_volume]
TOOLS_BY_NAME = {t.name: t for t in TOOLS}
