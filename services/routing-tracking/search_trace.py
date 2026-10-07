"""Bounded, optional observation of the real A* search (GeoJSON coordinates)."""


class SearchTrace:
    def __init__(self, max_events=100000, max_vertices=400000):
        self.max_events = max_events
        self.max_vertices = max_vertices
        self.events = []
        self.edges = {}
        self.vertices = 0
        self.truncated = False
        self.leg = 0
        self.counts = {"discovered": 0, "expanded": 0}

    @staticmethod
    def state_id(state):
        node, ways = state
        return str(node) + "/" + ",".join(map(str, ways or ()))

    def record(self, kind, state, g, h, edge_id=None, geometry=None):
        self.counts[kind] += 1
        if self.truncated:
            return
        if len(self.events) >= self.max_events:
            self.truncated = True
            return
        if edge_id is not None and edge_id not in self.edges:
            if self.vertices + len(geometry) > self.max_vertices:
                self.truncated = True
                return
            self.edges[edge_id] = [[float(lon), float(lat)] for lat, lon in geometry]
            self.vertices += len(geometry)
        self.events.append({"kind": kind, "stateId": self.state_id(state),
                            "legIndex": self.leg, "edgeId": edge_id,
                            "g": g, "h": h})

    def snapshot(self):
        return {"events": self.events, "edges": self.edges,
                "counts": dict(self.counts), "truncated": self.truncated}
