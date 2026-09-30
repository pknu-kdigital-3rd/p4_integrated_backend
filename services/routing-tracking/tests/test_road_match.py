import math
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from road_match import match_preview  # noqa: E402


class FakeGraph:
    def __init__(self, coords, bridges=None):
        self.coords = coords
        self.bridges = bridges or {}

    def route(self, start, end):
        if start == end:
            return SimpleNamespace(coords=[self.coords[start]])
        path = self.bridges.get((start, end))
        return SimpleNamespace(coords=path) if path else None


def match(graph, edges, points, failure=None):
    records = []
    for source, target, geometry in edges:
        bounds = (min(point[1] for point in geometry), min(point[0] for point in geometry),
                  max(point[1] for point in geometry), max(point[0] for point in geometry))
        records.append((f"{source}:{target}:1", "1", geometry, bounds))
    cell = (math.floor(points[0][1]), math.floor(points[0][0]))
    return match_preview(graph, records, {cell: list(range(len(records)))}, (), 1, points, failure=failure)


class RoadMatchTests(unittest.TestCase):
    def test_snaps_to_edge_interior_instead_of_distant_nodes(self):
        graph = FakeGraph({1: (35, 129), 2: (35, 129.01)})
        result = match(graph, [(1, 2, [(35, 129), (35, 129.01)])],
                       [(35.00005, 129.0025), (35.00005, 129.0075)])
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result["coordinates"][0][0], 129.0025, places=5)
        self.assertAlmostEqual(result["coordinates"][-1][0], 129.0075, places=5)
        self.assertEqual(result["anchorPositions"], [0, 1])

    def test_keeps_a_parallel_road_and_uses_graph_for_gap(self):
        graph = FakeGraph({1: (35, 129), 2: (35, 129.001), 3: (35.001, 129.002), 4: (35.001, 129.003)},
                          {(2, 3): [(35, 129.001), (35.0005, 129.0015), (35.001, 129.002)]})
        edges = [(1, 2, [(35, 129), (35, 129.001)]),
                 (3, 4, [(35.001, 129.002), (35.001, 129.003)])]
        result = match(graph, edges, [(35.00002, 129.0002), (35.00102, 129.0028)])
        self.assertIsNotNone(result)
        self.assertIn([129.0015, 35.0005], result["coordinates"])

    def test_sequence_continuity_resists_one_noisy_fix_on_parallel_road(self):
        graph = FakeGraph({1: (35, 129), 2: (35, 129.002),
                           3: (35.0001, 129), 4: (35.0001, 129.002)})
        edges = [(1, 2, [(35, 129), (35, 129.002)]),
                 (3, 4, [(35.0001, 129), (35.0001, 129.002)])]
        result = match(graph, edges, [(35.00002, 129.0002), (35.00008, 129.0018)])
        self.assertIsNotNone(result)
        self.assertTrue(all(abs(lat - 35) < 1e-7 for _lon, lat in result["coordinates"]))

    def test_rejects_a_large_detour_between_nearby_gps_anchors(self):
        graph = FakeGraph({1: (35, 129), 2: (35, 129.001),
                           3: (35, 129.002), 4: (35, 129.003)},
                          {(2, 3): [(35, 129.001), (35.01, 129.0015), (35, 129.002)]})
        edges = [(1, 2, [(35, 129), (35, 129.001)]),
                 (3, 4, [(35, 129.002), (35, 129.003)])]
        self.assertIsNone(match(graph, edges, [(35, 129.0008), (35, 129.0022)]))


class RoadMatchFailureReasonTests(unittest.TestCase):
    def test_reports_the_anchor_with_no_road_nearby(self):
        graph = FakeGraph({1: (35, 129), 2: (35, 129.01)})
        failure = {}
        result = match(graph, [(1, 2, [(35, 129), (35, 129.01)])],
                       [(35.00005, 129.0025), (35.01, 129.0075)], failure)
        self.assertIsNone(result)
        self.assertEqual(failure["reason"], "no_road_nearby")
        self.assertEqual(failure["anchor"], 1)
        self.assertEqual((failure["lat"], failure["lon"]), (35.01, 129.0075))

    def test_reports_a_missing_connection(self):
        graph = FakeGraph({1: (35, 129), 2: (35, 129.01), 3: (35.02, 129), 4: (35.02, 129.01)})
        failure = {}
        result = match(graph, [(1, 2, [(35, 129), (35, 129.01)]), (3, 4, [(35.02, 129), (35.02, 129.01)])],
                       [(35.00005, 129.005), (35.02005, 129.005)], failure)
        self.assertIsNone(result)
        self.assertEqual(failure["reason"], "no_connection")
        self.assertEqual(failure["anchor"], 1)


if __name__ == "__main__":
    unittest.main()


class RoadMatchSkippedAnchorTests(unittest.TestCase):
    def test_bridges_over_an_anchor_with_no_road_nearby(self):
        graph = FakeGraph({1: (35, 129), 2: (35, 129.01)})
        points = [(35.00005, 129.001), (35.00005, 129.003), (35.01, 129.005),
                  (35.00005, 129.007), (35.00005, 129.009)]
        result = match(graph, [(1, 2, [(35, 129), (35, 129.01)])], points)
        self.assertIsNotNone(result)
        self.assertEqual(result["skippedAnchors"], [2])
        positions = result["anchorPositions"]
        self.assertEqual(len(positions), len(points))
        self.assertEqual(positions[2], positions[1], "a skipped anchor keeps the preceding position")
        self.assertEqual(positions, sorted(positions))
        self.assertIsNone(result["snapDistancesM"][2])

    def test_fails_when_too_many_anchors_have_no_road(self):
        graph = FakeGraph({1: (35, 129), 2: (35, 129.01)})
        failure = {}
        points = [(35.00005, 129.001), (35.01, 129.003), (35.01, 129.005), (35.00005, 129.009)]
        result = match(graph, [(1, 2, [(35, 129), (35, 129.01)])], points, failure)
        self.assertIsNone(result)
        self.assertEqual((failure["reason"], failure["anchor"], failure["unmatched"], failure["anchors"]),
                         ("no_road_nearby", 1, 2, 4))
