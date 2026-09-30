import { routingInternalClient } from "../virtual/routing-internal.client.ts";
import { previewPoints, type PreviewPoint } from "./trip.preview.ts";

type RoadMatch = {
    routeGeojson: { type: "LineString"; coordinates: number[][] };
    anchors: Array<{ sourceTimestampNs: string; routePosition: number; routeDistanceM: number }>;
    coordinateDistancesM: number[];
    graphVersion: string;
};

const cache = new Map<string, Promise<RoadMatch | null>>();
const maxAnchors = 48;

function deviationM(point: PreviewPoint, first: PreviewPoint, last: PreviewPoint): number {
    const latScale = 111_195;
    const lonScale = latScale * Math.cos(point[2] * Math.PI / 180);
    const dx = (last[1] - first[1]) * lonScale, dy = (last[2] - first[2]) * latScale;
    const x = (point[1] - first[1]) * lonScale, y = (point[2] - first[2]) * latScale;
    const fraction = dx * dx + dy * dy ? Math.max(0, Math.min(1, (x * dx + y * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(x - fraction * dx, y - fraction * dy);
}

/** Preserve the largest bends, so road routing can fill sparse GPS intervals. */
export function roadAnchorIndices(points: PreviewPoint[]): number[] {
    const indices = [0, points.length - 1];
    const totalM = points.at(-1)![3];
    const spacingM = Math.max(400, totalM / (maxAnchors - 1));
    for (let distance = spacingM; distance < totalM && indices.length < maxAnchors; distance += spacingM) {
        let low = 0, high = points.length - 1;
        while (low < high) { const middle = (low + high) >> 1; if (points[middle]![3] < distance) low = middle + 1; else high = middle; }
        if (!indices.includes(low)) indices.splice(indices.length - 1, 0, low);
    }
    while (indices.length < maxAnchors) {
        let bestDistance = 30, bestIndex = -1, bestSlot = -1;
        for (let slot = 1; slot < indices.length; slot++) {
            const first = indices[slot - 1]!, last = indices[slot]!;
            for (let index = first + 1; index < last; index++) {
                const distance = deviationM(points[index]!, points[first]!, points[last]!);
                if (distance > bestDistance) { bestDistance = distance; bestIndex = index; bestSlot = slot; }
            }
        }
        if (bestIndex < 0) break;
        indices.splice(bestSlot, 0, bestIndex);
    }
    return indices;
}

function cumulativeDistances(coordinates: number[][]): number[] {
    const distances = [0];
    for (let index = 1; index < coordinates.length; index++) {
        const a = coordinates[index - 1]!, b = coordinates[index]!;
        const meanLat = (a[1]! + b[1]!) * Math.PI / 360;
        const metres = Math.hypot((b[0]! - a[0]!) * 111_195 * Math.cos(meanLat), (b[1]! - a[1]!) * 111_195);
        distances.push(distances.at(-1)! + metres);
    }
    return distances;
}

export async function matchReplayPreview(preview: { fingerprint: string; points: unknown }): Promise<RoadMatch | null> {
    const key = preview.fingerprint;
    const cached = cache.get(key);
    if (cached) return cached;
    const match = (async () => {
        const points = previewPoints(preview.points);
        const indices = roadAnchorIndices(points);
        const stops = indices.map(index => ({ lat: points[index]![2], lon: points[index]![1] }));
        const route = await routingInternalClient.matchPreview(stops);
        const coordinates = route.routeGeojson.coordinates;
        if (coordinates.length < 2 || route.anchorPositions.length !== stops.length) return null;
        const coordinateDistancesM = cumulativeDistances(coordinates);
        const anchors = indices.map((index, slot) => {
            const position = route.anchorPositions[slot]!;
            if (!Number.isInteger(position) || position < 0 || position >= coordinates.length) throw new Error("Invalid road match anchor position");
            const segment = Math.min(coordinates.length - 2, Math.floor(position));
            const routeDistanceM = coordinateDistancesM[segment]! + (position - segment)
                * (coordinateDistancesM[segment + 1]! - coordinateDistancesM[segment]!);
            return { sourceTimestampNs: points[index]![0], routePosition: position, routeDistanceM };
        });
        return { routeGeojson: route.routeGeojson, anchors, coordinateDistancesM, graphVersion: route.graphVersion };
    })().catch(error => {
        setTimeout(() => { if (cache.get(key) === match) cache.delete(key); }, 30_000);
        console.warn("Replay road matching unavailable", error);
        return null;
    });
    cache.set(key, match);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return match;
}
