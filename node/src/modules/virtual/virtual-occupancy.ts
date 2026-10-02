// Which virtual vehicles stand on a road that a blockage would close.
//
// A vehicle occupies the segment between the two intersections of its
// current directed edge, in either direction. Edge IDs are
// "<graphVersion>:<fromNode>:<toNode>:<key>" (the graph version prefix is
// optional for legacy IDs), so the segment key is the version plus the two
// nodes in sorted order.
//
// This used to also compare physicalSegmentId, which is the edge's OSM way
// ID. One way can span many intersections (효열로 way 164679522 has 16
// directed edges), so a vehicle anywhere on a street blocked painting on
// any part of it.

export function undirectedSegmentKey(edgeId: string): string | null {
    const parts = edgeId.split(":");
    if (parts.length < 3) return null;
    const [from, to] = parts.slice(-3, -1) as [string, string];
    const version = parts.slice(0, -3).join(":");
    const [first, second] = from <= to ? [from, to] : [to, from];
    return `${version}|${first}|${second}`;
}

export function occupiedVehicleIds(
    states: Array<{ vehicleId: bigint; currentEdgeId: string | null }>,
    resolved: { affectedDirectedEdgeIds: string[] },
): string[] {
    const blockedSegments = new Set(
        resolved.affectedDirectedEdgeIds.map(undirectedSegmentKey).filter((key): key is string => key !== null),
    );
    return states
        .filter((state) => {
            if (state.currentEdgeId === null) return false;
            const key = undirectedSegmentKey(state.currentEdgeId);
            return key !== null && blockedSegments.has(key);
        })
        .map((state) => state.vehicleId.toString());
}
