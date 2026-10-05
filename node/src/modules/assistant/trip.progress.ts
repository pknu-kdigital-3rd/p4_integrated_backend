// Remaining distance and time to a trip's destination, for the assistant.
//
// A replay trip follows its uploaded preview: [sourceTimestampNs, lon, lat,
// cumulativeDistanceM] points, so the current replay time places the vehicle
// exactly and the recording's own timing gives the time left. A planned trip
// projects the current fix onto the route and scales the planned duration by
// the share of distance left.

function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export type TripRemaining = { distanceM: number; durationSec: number | null; basis: "REPLAY" | "ROUTE" | "NAVIGATION" };

type PreviewPoint = [string, number, number, number];

function isPreviewPoints(value: unknown): value is PreviewPoint[] {
    return Array.isArray(value) && value.length >= 2 && value.every((point) => Array.isArray(point) && point.length >= 4
        && typeof point[0] === "string" && /^\d+$/.test(point[0]) && point.slice(1, 4).every((item) => Number.isFinite(item)));
}

export function replayRemaining(points: unknown, sourceTimestampNs: string | null): TripRemaining | null {
    if (!isPreviewPoints(points) || !sourceTimestampNs || !/^\d+$/.test(sourceTimestampNs)) return null;
    const now = BigInt(sourceTimestampNs);
    const last = points.at(-1)!;
    const end = BigInt(last[0]), total = last[3];
    if (now >= end) return { distanceM: 0, durationSec: 0, basis: "REPLAY" };
    let travelled = 0;
    const after = points.findIndex((point) => BigInt(point[0]) > now);
    if (after > 0) {
        const before = points[after - 1]!, next = points[after]!;
        const span = Number(BigInt(next[0]) - BigInt(before[0]));
        const fraction = span > 0 ? Number(now - BigInt(before[0])) / span : 0;
        travelled = before[3] + (next[3] - before[3]) * fraction;
    }
    return { distanceM: Math.max(0, total - travelled), durationSec: Number(end - now) / 1e9, basis: "REPLAY" };
}

export function routeRemaining(geojson: unknown, at: { lat: number; lon: number }, distanceM: number | null, durationSec: number | null): TripRemaining | null {
    const coordinates = (geojson as { coordinates?: unknown } | null)?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
    const line = coordinates.filter((point): point is [number, number] => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (line.length < 2) return null;
    // Nearest point on the line in a local metric plane around the fix.
    const metersPerLon = 111_320 * Math.cos(at.lat * Math.PI / 180), metersPerLat = 110_540;
    const xy = ([lon, lat]: [number, number]) => [(lon - at.lon) * metersPerLon, (lat - at.lat) * metersPerLat] as const;
    let along = 0, best = Infinity, bestAlong = 0;
    for (let index = 1; index < line.length; index++) {
        const a = line[index - 1]!, b = line[index]!;
        const length = haversineM({ lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
        const [ax, ay] = xy(a), [bx, by] = xy(b);
        const dx = bx - ax, dy = by - ay, squared = dx * dx + dy * dy;
        const t = squared > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / squared)) : 0;
        const distance = Math.hypot(ax + dx * t, ay + dy * t);
        if (distance < best) { best = distance; bestAlong = along + length * t; }
        along += length;
    }
    const total = along;
    const remaining = Math.max(0, total - bestAlong);
    const scale = distanceM && distanceM > 0 ? distanceM / total : 1;
    return {
        distanceM: remaining * scale,
        durationSec: durationSec !== null && total > 0 ? durationSec * remaining / total : null,
        basis: "ROUTE",
    };
}
