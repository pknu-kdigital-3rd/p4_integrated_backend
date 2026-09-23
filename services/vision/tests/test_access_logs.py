import logging
import unittest

from app.services.access_logs import TelemetryAccessLogFilter


class TelemetryAccessLogFilterTests(unittest.TestCase):
    def make_record(self, request_target: str) -> logging.LogRecord:
        return logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg='%s - "%s %s HTTP/%s" %d',
            args=("127.0.0.1", "POST", request_target, "1.1", 200),
            exc_info=None,
        )

    def test_disabled_setting_filters_only_telemetry_endpoint(self):
        access_filter = TelemetryAccessLogFilter(enabled=False)
        self.assertFalse(access_filter.filter(self.make_record("/internal/telemetry")))
        self.assertFalse(
            access_filter.filter(self.make_record("/internal/telemetry?source=live"))
        )
        self.assertTrue(access_filter.filter(self.make_record("/health/live")))

    def test_enabled_setting_keeps_telemetry_access_log(self):
        access_filter = TelemetryAccessLogFilter(enabled=True)
        self.assertTrue(access_filter.filter(self.make_record("/internal/telemetry")))


if __name__ == "__main__":
    unittest.main()
