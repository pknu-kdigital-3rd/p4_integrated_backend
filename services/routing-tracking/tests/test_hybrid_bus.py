import csv
import unittest
from pathlib import Path

from hybrid_bus import HybridBusService, load_history


class HybridBusTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parent
        self.history = self.root / ".hybrid_test_history.csv"
        self.output = self.root / ".hybrid_test_output.csv"
        self.raw = self.root / ".hybrid_test_raw.csv"
        for path in (self.history, self.output, self.raw):
            path.unlink(missing_ok=True)

    def tearDown(self):
        for path in (self.history, self.output, self.raw):
            path.unlink(missing_ok=True)

    def write_history(self):
        with self.history.open("w", encoding="utf-8", newline="") as target:
            writer = csv.DictWriter(
                target,
                fieldnames=("trace_time_s", "line_number", "direction", "latitude", "longitude", "speed_kmh"),
            )
            writer.writeheader()
            for second in range(11):
                writer.writerow({
                    "trace_time_s": second,
                    "line_number": "111-1",
                    "direction": "outbound",
                    "latitude": "35.1000000",
                    "longitude": f"{129.1000000 + second * 0.0001:.7f}",
                    "speed_kmh": "20",
                })

    def test_loads_prepared_history_with_collector_line_number(self):
        self.write_history()
        history = load_history(self.history)
        self.assertIn(("111-1", "outbound"), history)
        self.assertEqual(history[("111-1", "outbound")][0].trace_time_s, 0)

    def test_stale_live_fix_advances_along_collected_route(self):
        self.write_history()
        service = HybridBusService(
            service_key="test-key",
            history_path=self.history,
            output_path=self.output,
            raw_path=self.raw,
            lines=("111-1",),
            line_ids={"111-1": "L111-1"},
            stale_after_s=1.0,
        )
        state = service.states["111-1"]
        state.line_id = "L111-1"
        state.selected_vehicle = "BUS-1"
        state.direction = "outbound"
        state.live_lat = state.current_lat = 35.1
        state.live_lon = state.current_lon = 129.1
        state.live_received_mono = 100.0
        state.live_observed_at_utc = "2026-01-01T00:00:00Z"
        state.source = "live"

        service._position_state(state, 100.5)
        self.assertEqual(state.source, "live")
        service._position_state(state, 101.1)
        self.assertEqual(state.source, "interpolated")
        service._position_state(state, 105.1)
        self.assertGreater(state.current_lon, 129.1002)
        self.assertLess(state.current_lon, 129.1007)

    def test_snapshot_and_persisted_row_keep_same_line_number(self):
        self.write_history()
        service = HybridBusService(
            service_key="test-key",
            history_path=self.history,
            output_path=self.output,
            raw_path=self.raw,
            lines=("111-1",),
            line_ids={"111-1": "L111-1"},
        )
        state = service.states["111-1"]
        state.selected_vehicle = "BUS-1"
        state.line_id = "L111-1"
        state.live_lat = state.current_lat = 35.1
        state.live_lon = state.current_lon = 129.1
        state.live_received_mono = 100.0
        state.live_observed_at_utc = "2026-01-01T00:00:00Z"
        state.source = "live"
        service._emit(100.5)

        self.assertEqual(service.snapshot()["vehicles"][0]["line_number"], "111-1")
        with self.output.open("r", encoding="utf-8-sig", newline="") as source:
            row = next(csv.DictReader(source))
        self.assertEqual(row["line_number"], "111-1")

    def test_bims_payload_uses_public_line_number_and_route_direction(self):
        self.write_history()
        service = HybridBusService(
            service_key="test-key",
            history_path=self.history,
            output_path=self.output,
            raw_path=self.raw,
            lines=("111-1",),
            line_ids={"111-1": "L111-1"},
        )
        service.states["111-1"].line_id = "L111-1"
        service._accept_payload("111-1", {
            "response": {"body": {"items": {"item": [
                {"bstopidx": "1", "rpoint": "0", "lin": "129.1", "lat": "35.1"},
                {"bstopidx": "10", "rpoint": "1", "lin": "129.101", "lat": "35.1"},
                {"bstopidx": "2", "rpoint": "0", "carno": "BUS-1", "lin": "129.1", "lat": "35.1", "gpsym": "120000"},
            ]}}}}, 100.0)
        service._emit(100.1)
        vehicle = service.snapshot()["vehicles"][0]
        self.assertEqual(vehicle["line_number"], "111-1")
        self.assertEqual(vehicle["direction"], "outbound")
        with self.raw.open("r", encoding="utf-8-sig", newline="") as source:
            row = next(csv.DictReader(source))
        self.assertEqual(row["line_number"], "111-1")
        self.assertEqual(row["line_id"], "L111-1")


if __name__ == "__main__":
    unittest.main()
