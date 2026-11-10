"""Stand-ins for the OpenHands SDK security types, used only when `openhands-sdk` is not installed.

They mirror openhands-sdk 1.61 (openhands/sdk/security/{risk,analyzer}.py) closely enough for this
package and its protocol tests: the string enum `SecurityRisk`, the `SecurityAnalysis` result, and
an abstract `SecurityAnalyzerBase` with `security_risk(action) -> SecurityRisk` and
`analyze_action(action) -> SecurityAnalysis`. With the SDK installed, the real classes are used.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any


class SecurityRisk(str, Enum):
    UNKNOWN = "UNKNOWN"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class SecurityAnalysis:
    def __init__(self, risk: SecurityRisk, details: dict[str, Any] | None = None) -> None:
        self.risk = risk
        self.details = details

    def __repr__(self) -> str:
        return f"SecurityAnalysis(risk={self.risk!r}, details={self.details!r})"


class SecurityAnalyzerBase(ABC):
    def __init__(self, **fields: Any) -> None:
        for name, value in fields.items():
            if name.startswith("_") or not hasattr(type(self), name):
                raise TypeError(f"unknown field {name!r}")
            setattr(self, name, value)

    @abstractmethod
    def security_risk(self, action: Any) -> SecurityRisk: ...

    def analyze_action(self, action: Any) -> SecurityAnalysis:
        return SecurityAnalysis(risk=self.security_risk(action))
