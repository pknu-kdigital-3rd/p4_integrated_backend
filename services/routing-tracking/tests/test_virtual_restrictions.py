import unittest
from collections import defaultdict

from graph_backend import PurePythonGraph
from main import _edge_intersects_polygon


def empty_restrictions():
    return {}


class VirtualRestrictionGeometryTests(unittest.TestCase):
    def test_polygon_crossing_middle_of_edge_is_detected_without_shapely(self):
        edge = [[0.0, 0.0], [1.0, 1.0]]
        # GeoJSON uses [longitude, latitude].  Neither endpoint is inside,
        # but the diagonal crosses the region.
        polygon = {
            "type": "Polygon",
            "coordinates": [[
                [0.4, 0.4], [0.6, 0.4], [0.6, 0.6],
                [0.4, 0.6], [0.4, 0.4],
            ]],
        }
        self.assertTrue(_edge_intersects_polygon(edge, polygon))

    def test_blocked_edge_is_removed_from_pure_python_route(self):
        graph = object.__new__(PurePythonGraph)
        graph.coords = {
            1: (0.0, 0.0),
            2: (1.0, 1.0),
            3: (0.0, 2.0),
            4: (1.0, 2.0),
        }
        graph.turn_restrictions = set()
        graph.adjacency = defaultdict(list)
        # Direct diagonal is shortest and crosses the closure polygon.
        graph.adjacency[1].append((2, 157_000.0, 40.0, [[0.0, 0.0], [1.0, 1.0]], empty_restrictions(), 10))
        # Longer detour remains available after the direct edge is blocked.
        graph.adjacency[1].append((3, 222_000.0, 40.0, [[0.0, 0.0], [0.0, 2.0]], empty_restrictions(), 20))
        graph.adjacency[3].append((4, 111_000.0, 40.0, [[0.0, 2.0], [1.0, 2.0]], empty_restrictions(), 21))
        graph.adjacency[4].append((2, 111_000.0, 40.0, [[1.0, 2.0], [1.0, 1.0]], empty_restrictions(), 22))

        unrestricted = graph.route(1, 2)
        blocked = graph.route(1, 2, blocked_edge_ids=["1:2:10"])

        self.assertEqual(unrestricted.edge_ids, ["1:2:10"])
        self.assertNotIn("1:2:10", blocked.edge_ids)
        self.assertEqual(blocked.edge_ids, ["1:3:20", "3:4:21", "4:2:22"])


if __name__ == "__main__":
    unittest.main()
