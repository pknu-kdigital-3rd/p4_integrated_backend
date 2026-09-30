import { describe, expect, it, vi } from "vitest";
import { roadAnchorIndices, matchReplayPreview } from "../src/modules/trip/trip-road-match.ts";
import { routingInternalClient } from "../src/modules/virtual/routing-internal.client.ts";

describe("recorded GPS road matching", () => {
    it("retains a turn when selecting road routing anchors", () => {
        const points: Array<[string, number, number, number]> = [
            ["100", 129, 35, 0], ["200", 129.001, 35, 100],
            ["300", 129.001, 35.001, 200], ["400", 129.001, 35.002, 300],
        ];
        expect(roadAnchorIndices(points).length).toBeGreaterThan(2);
    });

    it("uses road geometry between GPS anchors and preserves their timestamps", async () => {
        const route = vi.spyOn(routingInternalClient, "route").mockResolvedValueOnce({
            graphVersion: "test-graph",
            routeGeojson: { type: "LineString", coordinates: [[129, 35], [129.0005, 35.0005], [129.001, 35]] },
            directedItinerary: [], snappedStops: [{ lat: 35, lon: 129 }, { lat: 35, lon: 129.001 }],
            distanceM: 100, durationSec: 10, warnings: [],
        });
        const result = await matchReplayPreview({
            fingerprint: "road-match-test",
            points: [["100", 129, 35, 0], ["200", 129.001, 35, 100]],
        });
        expect(route).toHaveBeenCalledOnce();
        expect(result?.routeGeojson.coordinates).toHaveLength(3);
        expect(result?.routeGeojson.coordinates[1]).toEqual([129.0005, 35.0005]);
        expect(result?.anchors).toEqual([
            { sourceTimestampNs: "100", routePosition: 0 },
            { sourceTimestampNs: "200", routePosition: 2 },
        ]);
        route.mockRestore();
    });
});
