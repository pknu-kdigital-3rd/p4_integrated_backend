// Decides which following vehicles need a new route after a road-state
// change.  A road that becomes blocked or more expensive cannot make a route
// that avoids it worse, so only vehicles whose remaining itinerary uses a
// tightened edge must be resolved.  A road that becomes cheaper or reopens can
// make any route suboptimal, so that case still refreshes every vehicle.

export type OverlaySnapshot = {
    blockedEdgeIds: string[];
    penaltyEdgeFactors: Record<string, number>;
};

export type RoadStateChange = {
    // Edges whose effective cost went up (newly blocked or higher penalty).
    tightenedEdgeIds: Set<string>;
    // Edges whose effective cost went down (reopened or lower penalty).
    relaxedEdgeIds: Set<string>;
    // True when at least one tightened edge became blocked.
    blockedAdded: boolean;
    // True when at least one relaxed edge was blocked before.
    blockedRemoved: boolean;
};

export type RerouteReason = "BLOCKED_EDGE" | "PENALTY_INCREASE" | "ROAD_REOPENED" | "PENALTY_DECREASE";

function edgeCost(overlay: OverlaySnapshot, blocked: Set<string>, edgeId: string): number {
    if (blocked.has(edgeId)) return Number.POSITIVE_INFINITY;
    return Math.max(1, overlay.penaltyEdgeFactors[edgeId] ?? 1);
}

export function diffRoadState(before: OverlaySnapshot, after: OverlaySnapshot): RoadStateChange {
    const blockedBefore = new Set(before.blockedEdgeIds);
    const blockedAfter = new Set(after.blockedEdgeIds);
    const edges = new Set([
        ...blockedBefore, ...blockedAfter,
        ...Object.keys(before.penaltyEdgeFactors), ...Object.keys(after.penaltyEdgeFactors),
    ]);
    const tightenedEdgeIds = new Set<string>();
    const relaxedEdgeIds = new Set<string>();
    let blockedAdded = false;
    let blockedRemoved = false;
    for (const edgeId of edges) {
        const previous = edgeCost(before, blockedBefore, edgeId);
        const next = edgeCost(after, blockedAfter, edgeId);
        if (next > previous) {
            tightenedEdgeIds.add(edgeId);
            if (next === Number.POSITIVE_INFINITY) blockedAdded = true;
        } else if (next < previous) {
            relaxedEdgeIds.add(edgeId);
            if (previous === Number.POSITIVE_INFINITY) blockedRemoved = true;
        }
    }
    return { tightenedEdgeIds, relaxedEdgeIds, blockedAdded, blockedRemoved };
}

export function rerouteReason(change: RoadStateChange): RerouteReason | null {
    // A mixed change is reported by its relaxing part, since that is what
    // forces a fleet-wide refresh.
    if (change.relaxedEdgeIds.size) return change.blockedRemoved ? "ROAD_REOPENED" : "PENALTY_DECREASE";
    if (change.tightenedEdgeIds.size) return change.blockedAdded ? "BLOCKED_EDGE" : "PENALTY_INCREASE";
    return null;
}

type ItineraryEdge = { edgeId?: unknown; cumulativeStartM?: unknown; lengthM?: unknown };

// Edge IDs from the vehicle's current offset to the end of its route.  The
// stored offset trails the vehicle by at most one simulation tick, so this can
// include an edge just passed; that only causes an unnecessary reroute.
export function remainingRouteEdgeIds(itinerary: unknown, offsetM: unknown): string[] {
    if (!Array.isArray(itinerary)) return [];
    const offset = Number(offsetM);
    const result: string[] = [];
    for (const raw of itinerary as ItineraryEdge[]) {
        if (typeof raw?.edgeId !== "string") continue;
        const start = Number(raw.cumulativeStartM);
        const length = Number(raw.lengthM);
        if (Number.isFinite(offset) && Number.isFinite(start) && Number.isFinite(length) && start + Math.max(0, length) <= offset) continue;
        result.push(raw.edgeId);
    }
    return result;
}

function graphVersionOf(edgeId: string): string {
    const separator = edgeId.indexOf(":");
    return separator < 0 ? "" : edgeId.slice(0, separator);
}

// True when the route must be recalculated because of `change`.  Edge IDs are
// prefixed with the routing graph version; when the route was built on a
// different graph than a changed edge, IDs cannot be compared, so the route is
// treated as affected.
export function routeAffectedByChange(
    route: { directedItinerary: unknown; graphVersion?: string | null } | null | undefined,
    offsetM: unknown,
    change: RoadStateChange,
): boolean {
    if (change.relaxedEdgeIds.size) return true;
    if (!change.tightenedEdgeIds.size) return false;
    if (!route) return true;
    const remaining = remainingRouteEdgeIds(route.directedItinerary, offsetM);
    if (!remaining.length) return true;
    if (route.graphVersion) {
        for (const edgeId of change.tightenedEdgeIds) {
            if (graphVersionOf(edgeId) !== route.graphVersion) return true;
        }
    }
    return remaining.some((edgeId) => change.tightenedEdgeIds.has(edgeId));
}
