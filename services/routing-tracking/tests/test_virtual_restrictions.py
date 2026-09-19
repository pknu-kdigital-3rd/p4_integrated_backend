import unittest
from collections import defaultdict

from graph_backend import PurePythonGraph
import main
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

    def test_graph_version_prefixed_blocked_edge_uses_constant_time_lookup(self):
        graph = object.__new__(PurePythonGraph)
        graph.coords = {
            1: (0.0, 0.0),
            2: (1.0, 1.0),
            3: (0.0, 2.0),
            4: (1.0, 2.0),
        }
        graph.turn_restrictions = set()
        graph.adjacency = defaultdict(list)
        graph.adjacency[1].append((2, 157_000.0, 40.0, [[0.0, 0.0], [1.0, 1.0]], empty_restrictions(), 10))
        graph.adjacency[1].append((3, 222_000.0, 40.0, [[0.0, 0.0], [0.0, 2.0]], empty_restrictions(), 20))
        graph.adjacency[3].append((4, 111_000.0, 40.0, [[0.0, 2.0], [1.0, 2.0]], empty_restrictions(), 21))
        graph.adjacency[4].append((2, 111_000.0, 40.0, [[1.0, 2.0], [1.0, 1.0]], empty_restrictions(), 22))

        blocked = graph.route(1, 2, blocked_edge_ids=["0123456789abcdef0123456789abcdef:1:2:10"])

        self.assertEqual(blocked.edge_ids, ["1:3:20", "3:4:21", "4:2:22"])

    def test_initial_reverse_is_avoided_when_forward_route_exists(self):
        graph = object.__new__(PurePythonGraph)
        graph.coords = {
            1: (0.0, 0.0),
            2: (0.0, 1.0),
            3: (1.0, 1.0),
            4: (1.0, 0.0),
        }
        graph.turn_restrictions = set()
        graph.adjacency = defaultdict(list)
        # The shortest route starts by reversing the previous 1 -> 2 edge.
        graph.adjacency[2].append((1, 1.0, 40.0, [[0.0, 1.0], [0.0, 0.0]], empty_restrictions(), 10))
        graph.adjacency[1].append((4, 1.0, 40.0, [[0.0, 0.0], [1.0, 0.0]], empty_restrictions(), 11))
        # A longer forward continuation remains available.
        graph.adjacency[2].append((3, 10.0, 40.0, [[0.0, 1.0], [1.0, 1.0]], empty_restrictions(), 20))
        graph.adjacency[3].append((4, 10.0, 40.0, [[1.0, 1.0], [1.0, 0.0]], empty_restrictions(), 21))

        unrestricted = graph.route(2, 4)
        smoothed = graph.route(2, 4, avoid_initial_reverse_of_edge_id="0123456789abcdef0123456789abcdef:1:2:10")

        self.assertEqual(unrestricted.edge_ids, ["2:1:10", "1:4:11"])
        self.assertEqual(smoothed.edge_ids, ["2:3:20", "3:4:21"])

    def test_internal_route_re_resolves_active_blocked_geometry(self):
        graph = object.__new__(PurePythonGraph)
        graph.coords = {
            1: (0.0, 0.0),
            2: (1.0, 1.0),
            3: (0.0, 2.0),
            4: (1.0, 2.0),
        }
        graph.turn_restrictions = set()
        graph.adjacency = defaultdict(list)
        graph.grid_size = 10.0
        graph.grid = defaultdict(list)
        graph.grid[(0, 0)].extend(graph.coords)
        graph.adjacency[1].append((2, 157_000.0, 40.0, [[0.0, 0.0], [1.0, 1.0]], empty_restrictions(), 10))
        graph.adjacency[1].append((3, 222_000.0, 40.0, [[0.0, 0.0], [0.0, 2.0]], empty_restrictions(), 20))
        graph.adjacency[3].append((4, 111_000.0, 40.0, [[0.0, 2.0], [1.0, 2.0]], empty_restrictions(), 21))
        graph.adjacency[4].append((2, 111_000.0, 40.0, [[1.0, 2.0], [1.0, 1.0]], empty_restrictions(), 22))
        main.graph = graph
        polygon = {
            "type": "Polygon",
            "coordinates": [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]],
        }

        result = main._internal_route(main.InternalRouteRequest(
            origin=main.InternalCoordinate(lat=0.0, lon=0.0),
            destination=main.InternalCoordinate(lat=1.0, lon=1.0),
            blockedGeometries=[polygon],
        ))

        self.assertTrue(result["directedItinerary"])
        self.assertTrue(all(not item["edgeId"].endswith(":1:2:10") for item in result["directedItinerary"]))


if __name__ == "__main__":
    unittest.main()
