import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from graph_backend import NON_DRIVABLE_HIGHWAYS, TRUCK_PROFILES, edge_allowed  # noqa: E402


class MatchGraphAccessTests(unittest.TestCase):
    def test_routing_still_refuses_private_roads(self):
        self.assertFalse(edge_allowed({"access": "private"}, None))
        self.assertFalse(edge_allowed({"access": ["yes", "private"]}, None))

    def test_road_matching_may_use_private_roads(self):
        self.assertTrue(edge_allowed({"access": "private"}, None, respect_access=False))

    def test_physical_truck_limits_still_apply_without_access(self):
        profile = next(iter(TRUCK_PROFILES.values()))
        low = {"access": "private", "max_height_m": profile["height_m"] - 0.1}
        self.assertFalse(edge_allowed(low, profile, respect_access=False))

    def test_match_graph_drops_only_walking_ways(self):
        for walking in ("footway", "steps", "pedestrian", "path", "cycleway"):
            self.assertIn(walking, NON_DRIVABLE_HIGHWAYS)
        for drivable in ("service", "residential", "track", "unclassified", "living_street"):
            self.assertNotIn(drivable, NON_DRIVABLE_HIGHWAYS)


if __name__ == "__main__":
    unittest.main()
