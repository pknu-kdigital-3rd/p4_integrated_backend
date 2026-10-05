import threading
import unittest
from collections import defaultdict
from unittest.mock import patch

from graph_backend import PurePythonGraph, OsmnxGraph
from search_trace import SearchTrace
import main


def make_graph(backend):
    coords = {1: (35, 129), 2: (35, 129.001), 3: (35.001, 129.001), 4: (35, 129.002)}
    # Direct continuation 10 -> 30 is forbidden, preserving edge-state context.
    roads = [(1, 2, 100, 10), (1, 2, 120, 11), (2, 4, 100, 30), (2, 3, 150, 20), (3, 4, 150, 21)]
    graph = object.__new__(backend)
    graph.turn_restrictions = {(10, 2, 30)}
    if backend is PurePythonGraph:
        graph.coords = coords
        graph.grid_size = 1.0
        graph.grid = defaultdict(list)
        graph.grid[(35, 129)].extend(coords)
        graph.adjacency = defaultdict(list)
        for start, end, length, way in roads:
            graph.adjacency[start].append((end, length, 40, [], {}, way))
    else:
        class FakeGraph:
            nodes = {n: {"y": lat, "x": lon} for n, (lat, lon) in coords.items()}
            adj = {}
        graph.G = FakeGraph()
        for start, end, length, way in roads:
            graph.G.adj.setdefault(start, {}).setdefault(end, {})[way] = {
                "length": length, "highway": "residential", "osmid": way,
            }
    return graph


class SearchTraceTests(unittest.TestCase):
    def test_trace_does_not_change_route_with_turns_parallel_edges_overlays_or_profiles(self):
        for backend in (PurePythonGraph, OsmnxGraph):
            graph = make_graph(backend)
            for options in ({}, {"truck_class": "semi"}, {"blocked_edge_ids": ["1:2:11"]},
                            {"penalty_edge_factors": {"1:2:11": 4}}):
                with self.subTest(backend=backend, options=options):
                    normal = graph.route(1, 4, **options)
                    trace = SearchTrace()
                    observed = graph.route(1, 4, trace=trace, **options)
                    self.assertEqual(normal.edge_ids, observed.edge_ids)
                    self.assertEqual(normal.coords, observed.coords)
                    self.assertEqual(normal.time_s, observed.time_s)
                    self.assertTrue(trace.events)
                    self.assertEqual(trace.edges["1:2:10"][0], [129.0, 35.0])
                    self.assertEqual(trace.events[-1]["kind"], "expanded")

    def test_limits_stop_collection_but_not_search(self):
        for backend in (PurePythonGraph, OsmnxGraph):
            for limits in ({"max_events": 2}, {"max_vertices": 1}):
                trace = SearchTrace(**limits)
                graph = make_graph(backend)
                self.assertEqual(graph.route(1, 4).edge_ids, graph.route(1, 4, trace=trace).edge_ids)
                self.assertTrue(trace.truncated)
                self.assertLessEqual(len(trace.events), trace.max_events)
                self.assertLessEqual(trace.vertices, trace.max_vertices)

    def test_cancel_and_unreachable(self):
        for backend in (PurePythonGraph, OsmnxGraph):
            graph = make_graph(backend)
            trace = SearchTrace()
            self.assertIsNone(graph.route(4, 1, trace=trace))
            self.assertEqual(len(trace.events), 1)
            cancelled = threading.Event(); cancelled.set()
            trace = SearchTrace()
            self.assertIsNone(graph.route(1, 4, trace=trace, cancel_event=cancelled))
            self.assertEqual(trace.events, [])

    def test_internal_waypoint_trace_and_failure_details(self):
        graph = make_graph(PurePythonGraph)
        with patch.object(main, "graph", graph), patch.object(main, "_graph_version", return_value="test"):
            req = main.InternalRouteRequest(origin={"lat": 35, "lon": 129},
                destination={"lat": 35, "lon": 129.002}, waypoints=[{"lat": 35, "lon": 129.001}], includeSearchTrace=True)
            result = main._calculate_internal_route(req)
            self.assertEqual({e["legIndex"] for e in result["searchTrace"]["events"]}, {0, 1})
            self.assertTrue(result["routeGeojson"]["coordinates"])
            req.includeSearchTrace = False
            with patch.object(main, "SearchTrace", side_effect=AssertionError("normal routes must not allocate traces")):
                normal = main._calculate_internal_route(req)
            self.assertNotIn("searchTrace", normal)
            self.assertEqual(result["routeGeojson"], normal["routeGeojson"])
            req.includeSearchTrace = True
            req.origin, req.destination = req.destination, req.origin
            req.waypoints = []
            with self.assertRaises(main.HTTPException) as failure:
                main._calculate_internal_route(req)
            self.assertEqual(failure.exception.detail["code"], "ROUTE_NOT_FOUND")
            self.assertTrue(failure.exception.detail["searchTrace"]["events"])


if __name__ == "__main__":
    unittest.main()
