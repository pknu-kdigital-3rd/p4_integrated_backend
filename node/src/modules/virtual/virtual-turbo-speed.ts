// Keep the existing 20x turbo flag/multiplier, but scale the base speed to
// traverse a full route in 30 wall-clock seconds. Long routes retain the
// previous maximum of 200 km/h at 20x rather than accelerating without limit.
export const TURBO_FACTOR = 20;
export const TURBO_ROUTE_SECONDS = 30;
export function turboSpeedKmh(routeDistanceM: number): number {
    if (!Number.isFinite(routeDistanceM) || routeDistanceM <= 0) return 200;
    return Math.min(200, routeDistanceM * 3.6 / (TURBO_ROUTE_SECONDS * TURBO_FACTOR));
}
