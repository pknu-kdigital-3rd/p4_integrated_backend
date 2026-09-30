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


class RoadMatchDroppedAnchorTests(unittest.TestCase):
    # Main road 1-2-3 heading east; a separate road 5-6 about 220 m north.
    coords = {1: (35, 129), 2: (35, 129.004), 3: (35, 129.008), 5: (35.002, 129.004), 6: (35.002, 129.005)}
    edges = [(1, 2, [(35, 129), (35, 129.004)]), (2, 3, [(35, 129.004), (35, 129.008)]),
             (5, 6, [(35.002, 129.004), (35.002, 129.005)])]

    def test_drops_an_anchor_that_no_road_path_reaches(self):
        points = [(35, 129.001), (35, 129.003), (35.002, 129.0045), (35, 129.006), (35, 129.0075)]
        result = match(FakeGraph(self.coords), self.edges, points)
        self.assertIsNotNone(result)
        self.assertEqual(result["skippedAnchors"], [2])
        self.assertEqual(result["anchorPositions"], sorted(result["anchorPositions"]))

    def test_drops_the_earlier_anchor_when_failures_repeat_from_it(self):
        # Reaching the north road works, but nothing leads back from it: every
        # failure starts at anchor 1, so anchor 1 is dropped and anchor 2 kept.
        graph = FakeGraph(self.coords, {(2, 5): [(35, 129.004), (35.002, 129.004)]})
        points = [(35, 129.003), (35.002, 129.0045), (35, 129.005), (35, 129.006), (35, 129.0075)]
        result = match(graph, self.edges, points)
        self.assertIsNotNone(result)
        self.assertEqual(result["skippedAnchors"], [1])


class RoadMatchRepairTests(unittest.TestCase):
    def test_repairs_a_snap_onto_the_opposite_carriageway(self):
        # Eastbound 1->2 on lat 35.0; westbound 4->3 about 15 m north. The second
        # fix lands nearer the westbound road, which cannot be reached from the
        # eastbound one; the repair switches it to the eastbound road instead.
        graph = FakeGraph({1: (35, 129.0), 2: (35, 129.01), 3: (35.00014, 129.0), 4: (35.00014, 129.01)})
        edges = [(1, 2, [(35, 129.0), (35, 129.01)]), (4, 3, [(35.00014, 129.01), (35.00014, 129.0)])]
        result = match(graph, edges, [(35.00001, 129.000), (35.00012, 129.007)])
        self.assertIsNotNone(result)
        self.assertEqual(result["skippedAnchors"], [])
        self.assertAlmostEqual(result["coordinates"][-1][1], 35.0, places=5)

    def test_does_not_repair_onto_a_much_farther_road(self):
        # The only other road is ~110 m away: dropping is better than misplacing.
        graph = FakeGraph({1: (35, 129), 2: (35, 129.001), 3: (35, 129.002), 4: (35, 129.003)},
                          {(2, 3): [(35, 129.001), (35.01, 129.0015), (35, 129.002)]})
        edges = [(1, 2, [(35, 129), (35, 129.001)]), (3, 4, [(35, 129.002), (35, 129.003)])]
        self.assertIsNone(match(graph, edges, [(35, 129.0008), (35, 129.0022)]))
