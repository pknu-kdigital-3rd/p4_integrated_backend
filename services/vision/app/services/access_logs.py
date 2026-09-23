"""Targeted filtering for verbose telemetry request access logs."""
from __future__ import annotations

import logging


class TelemetryAccessLogFilter(logging.Filter):
    def __init__(self, enabled: bool) -> None:
        super().__init__()
        self.enabled = enabled

    def filter(self, record: logging.LogRecord) -> bool:
        if self.enabled or record.name != "uvicorn.access":
            return True
        args = record.args
        if not isinstance(args, tuple) or len(args) < 3:
            return True
        request_target = args[2]
        if not isinstance(request_target, str):
            return True
        return request_target.split("?", 1)[0] != "/internal/telemetry"


def configure_telemetry_access_logging(enabled: bool) -> None:
    logging.getLogger("uvicorn.access").addFilter(TelemetryAccessLogFilter(enabled))
