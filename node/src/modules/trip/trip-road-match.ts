import { routingInternalClient } from "../virtual/routing-internal.client.ts";
import { previewPoints, type PreviewPoint } from "./trip.preview.ts";
import { cleanReplayPreviewPoints } from "./trip-preview-clean.ts";

type RoadMatch = {
    routeGeojson: { type: "LineString"; coordinates: number[][] };
    anchors: Array<{ sourceTimestampNs: string; routePosition: number; routeDistanceM: number }>;
    coordinateDistancesM: number[];
    graphVersion: string;
};

const cache = new Map<string, Promise<RoadMatch | null>>();
// Anchors about every 150 m (more for long recordings, up to maxAnchors): with
// sparse anchors the matcher bridges long stretches with the fastest route,
// which can leave by a different exit or road than the vehicle took.
const maxAnchors = 600;
const anchorSpacingM = 150;

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
    const spacingM = Math.max(anchorSpacingM, totalM / (maxAnchors - 1));
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

type TimedPosition = { sourceTimestampNs: string; position: number };

/**
 * Where the matcher skipped anchors (no road nearby - e.g. campus roads the
 * routing graph leaves out - or a detour), its bridge is a guessed road the
 * vehicle may never have used. Replace each such stretch between the matched
 * anchors on either side with the recorded GPS points themselves, and time the
 * route by every point it contains, so the line and the vehicle stay where the
 * recording actually was. Without skips the matched route is kept as is.
 */
export function spliceSkippedStretches(points: PreviewPoint[], indices: number[], coordinates: number[][],
    anchorPositions: number[], skippedSlots: number[], recordedSlots: number[] = []): { coordinates: number[][]; timing: TimedPosition[] } {
    const skipped = new Set(skippedSlots);
    // Matched anchors reached by a road detour (see roadDetourSlots): the
    // stretch up to them follows the recording like a skipped one.
    const recorded = new Set(recordedSlots);
    const matched = indices.map((_, slot) => slot).filter(slot => !skipped.has(slot));
    const timeOf = (slot: number) => points[indices[slot]!]![0];
    if (!skipped.size && !recorded.size) {
        return { coordinates, timing: matched.map(slot => ({ sourceTimestampNs: timeOf(slot), position: anchorPositions[slot]! })) };
    }
    const out: number[][] = [];
    const timing: TimedPosition[] = [];
    const add = (coordinate: number[]) => {
        const last = out.at(-1);
        if (!last || last[0] !== coordinate[0] || last[1] !== coordinate[1]) out.push(coordinate);
        return out.length - 1;
    };
    const addRecorded = (from: number, to: number) => {
        for (let index = from; index <= to; index++) {
            const point = points[index]!;
            timing.push({ sourceTimestampNs: point[0], position: add([point[1], point[2]]) });
        }
    };
    const addAnchor = (slot: number) => timing.push({ sourceTimestampNs: timeOf(slot), position: add(coordinates[anchorPositions[slot]!]!) });
    const first = matched[0]!, last = matched.at(-1)!;
    if (first > 0) addRecorded(indices[0]!, indices[first]! - 1);
    addAnchor(first);
    for (let step = 1; step < matched.length; step++) {
        const from = matched[step - 1]!, to = matched[step]!;
        if (to - from > 1 || recorded.has(to)) addRecorded(indices[from]! + 1, indices[to]! - 1);
        else for (let position = anchorPositions[from]! + 1; position < anchorPositions[to]!; position++) add(coordinates[position]!);
        addAnchor(to);
    }
    if (last < indices.length - 1) addRecorded(indices[last]! + 1, indices.at(-1)!);
    return { coordinates: out, timing };
}

// A road section this much longer than the recording between the same two
// anchors is a detour the vehicle did not drive.
const detourFactor = 1.5;
const detourSlackM = 40;

/**
 * Matched anchors whose road section from the previous matched anchor is far
 * longer than the recorded GPS between them. Typically a U-turn where the map
 * has no connection between the carriageways: the car turned where the median
 * ends, the road graph only at the next opening, and the matched path runs on
 * to that opening and back.
 */
export function roadDetourSlots(points: PreviewPoint[], indices: number[], coordinates: number[][],
    anchorPositions: number[], skippedSlots: number[]): number[] {
    const skipped = new Set(skippedSlots);
    const matched = indices.map((_, slot) => slot).filter(slot => !skipped.has(slot));
    const roadM = cumulativeDistances(coordinates);
    const detours: number[] = [];
    for (let step = 1; step < matched.length; step++) {
        const from = matched[step - 1]!, to = matched[step]!;
        if (to - from > 1) continue;
        const gpsM = points[indices[to]!]![3] - points[indices[from]!]![3];
        const sectionM = roadM[anchorPositions[to]!]! - roadM[anchorPositions[from]!]!;
        if (sectionM > detourFactor * gpsM + detourSlackM) detours.push(to);
    }
    return detours;
}

export async function matchReplayPreview(preview: { fingerprint: string; points: unknown }): Promise<RoadMatch | null> {
    const key = preview.fingerprint;
    const cached = cache.get(key);
    if (cached) return cached;
    const match = (async () => {
        const points = cleanReplayPreviewPoints(previewPoints(preview.points));
        const indices = roadAnchorIndices(points);
        const stops = indices.map(index => ({ lat: points[index]![2], lon: points[index]![1] }));
        const route = await routingInternalClient.matchPreview(stops);
        const coordinates = route.routeGeojson.coordinates;
        if (coordinates.length < 2 || route.anchorPositions.length !== stops.length) return null;
        for (const position of route.anchorPositions) {
            if (!Number.isInteger(position) || position < 0 || position >= coordinates.length) throw new Error("Invalid road match anchor position");
        }
        const skipped = route.skippedAnchors ?? [];
        const detours = roadDetourSlots(points, indices, coordinates, route.anchorPositions, skipped);
        const spliced = spliceSkippedStretches(points, indices, coordinates, route.anchorPositions, skipped, detours);
        const coordinateDistancesM = cumulativeDistances(spliced.coordinates);
        const anchors = spliced.timing.map(({ sourceTimestampNs, position }) => ({
            sourceTimestampNs, routePosition: position, routeDistanceM: coordinateDistancesM[position]!,
        }));
        return { routeGeojson: { type: "LineString" as const, coordinates: spliced.coordinates }, anchors, coordinateDistancesM, graphVersion: route.graphVersion };
    })().catch(error => {
        setTimeout(() => { if (cache.get(key) === match) cache.delete(key); }, 30_000);
        console.warn("Replay road matching unavailable", error);
        return null;
    });
    cache.set(key, match);
    if (cache.size > 32) cache.delete(cache.keys().next().value!);
    return match;
}
