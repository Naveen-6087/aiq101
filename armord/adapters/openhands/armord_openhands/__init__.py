"""OpenHands security analyzer backed by the local ArmorIQ decision daemon (armord)."""

from .analyzer import (
    HAVE_OPENHANDS_SDK,
    ArmordSecurityAnalyzer,
    SecurityRisk,
    confirm_risky_policy,
    pending_actions,
    reject_blocked,
    risk_for,
)
from .client import ArmordClient, ArmordUnavailable, default_socket_path
from .mapping import build_request

__all__ = [
    "ArmordClient",
    "ArmordSecurityAnalyzer",
    "ArmordUnavailable",
    "HAVE_OPENHANDS_SDK",
    "SecurityRisk",
    "build_request",
    "confirm_risky_policy",
    "default_socket_path",
    "pending_actions",
    "reject_blocked",
    "risk_for",
]
__version__ = "0.1.0"
