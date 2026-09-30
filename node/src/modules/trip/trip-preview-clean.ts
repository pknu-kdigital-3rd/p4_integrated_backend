import type { PreviewPoint } from "./trip.preview.ts";

const MAX_PLAUSIBLE_SPEED_MPS = 45;
const MAX_BAD_STRETCH_NS = 180_000_000_000n;

function metres(a: PreviewPoint, b: PreviewPoint): number {
    const latScale = 111_195;
    return Math.hypot((b[1] - a[1]) * latScale * Math.cos((a[2] + b[2]) * Math.PI / 360),
        (b[2] - a[2]) * latScale);
}

function plausible(a: PreviewPoint, b: PreviewPoint): boolean {
    const elapsedS = Number(BigInt(b[0]) - BigInt(a[0])) / 1e9;
    return elapsedS > 0 && metres(a, b) / elapsedS <= MAX_PLAUSIBLE_SPEED_MPS;
}

/** Remove a GPS island bounded by two impossible jumps, then recompute its distance clock. */
export function cleanReplayPreviewPoints(points: PreviewPoint[]): PreviewPoint[] {
    if (points.length < 3) return points;
    const keep = new Array<boolean>(points.length).fill(true);
    for (let start = 1; start < points.length - 1; start++) {
        if (plausible(points[start - 1]!, points[start]!)) continue;
        for (let end = start + 1; end < points.length; end++) {
            if (BigInt(points[end]![0]) - BigInt(points[start - 1]![0]) > MAX_BAD_STRETCH_NS) break;
            if (plausible(points[end - 1]!, points[end]!)) continue;
            if (!plausible(points[start - 1]!, points[end]!)) continue;
            for (let index = start; index < end; index++) keep[index] = false;
            start = end;
            break;
        }
    }
    if (keep.every(Boolean)) return points;
    const cleaned: PreviewPoint[] = [];
    let distance = 0;
    for (let index = 0; index < points.length; index++) {
        if (!keep[index]) continue;
        const point = points[index]!;
        if (cleaned.length) distance += metres(cleaned.at(-1)!, point);
        cleaned.push([point[0], point[1], point[2], distance]);
    }
    return cleaned;
}
