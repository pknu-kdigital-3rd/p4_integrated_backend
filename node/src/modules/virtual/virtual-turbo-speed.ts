// Keep the existing 20x turbo flag/multiplier, but scale the base speed to
// traverse a full route in 5 wall-clock seconds, with no speed cap.
export const TURBO_FACTOR = 20;
export const TURBO_ROUTE_SECONDS = 5;
export function turboSpeedKmh(routeDistanceM: number): number {
    if (!Number.isFinite(routeDistanceM) || routeDistanceM <= 0) return 200;
    return routeDistanceM * 3.6 / (TURBO_ROUTE_SECONDS * TURBO_FACTOR);
}
