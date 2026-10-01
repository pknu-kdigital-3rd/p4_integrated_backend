// Waypoint progress along a virtual trip's active route.  Each waypoint
// stores snappedOffsetM, the distance along the active route at which it is
// reached; it is rewritten whenever a route is activated.  A waypoint whose
// offset the vehicle has passed is REACHED and must not be routed again.

type SnappedStop = Record<string, unknown>;

// Route offsets of the stops returned by the router, in stop order
// (origin, waypoints..., destination).  null when the router did not report it.
export function stopRouteOffsets(snappedStops: unknown): Array<number | null> {
    if (!Array.isArray(snappedStops)) return [];
    return snappedStops.map((stop) => {
        const value = Number((stop as SnappedStop | null)?.routeOffsetM);
        return Number.isFinite(value) ? value : null;
    });
}

// Offsets of the waypoint stops only (the stops between origin and destination).
export function waypointRouteOffsets(snappedStops: unknown, waypointCount: number): Array<number | null> {
    const offsets = stopRouteOffsets(snappedStops);
    return Array.from({ length: waypointCount }, (_, index) => offsets[index + 1] ?? null);
}

export function shiftSnappedStops<T>(snappedStops: T, deltaM: number): T {
    if (!Array.isArray(snappedStops) || !Number.isFinite(deltaM) || deltaM === 0) return snappedStops;
    return snappedStops.map((stop: SnappedStop) => {
        const value = Number(stop?.routeOffsetM);
        return Number.isFinite(value) ? { ...stop, routeOffsetM: value + deltaM } : stop;
    }) as T;
}

export function waypointPassed(snappedOffsetM: unknown, vehicleOffsetM: unknown): boolean {
    if (snappedOffsetM === null || snappedOffsetM === undefined || vehicleOffsetM === null || vehicleOffsetM === undefined) return false;
    const waypoint = Number(snappedOffsetM);
    const vehicle = Number(vehicleOffsetM);
    return Number.isFinite(waypoint) && Number.isFinite(vehicle) && vehicle >= waypoint;
}
