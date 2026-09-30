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
        const route = vi.spyOn(routingInternalClient, "matchPreview").mockResolvedValueOnce({
            graphVersion: "test-graph",
            routeGeojson: { type: "LineString", coordinates: [[129, 35], [129.0005, 35.0005], [129.001, 35]] },
            anchorPositions: [0, 2], snapDistancesM: [0, 0],
        });
        const result = await matchReplayPreview({
            fingerprint: "road-match-test",
            points: [["100", 129, 35, 0], ["200", 129.001, 35, 100]],
        });
        expect(route).toHaveBeenCalledOnce();
        expect(result?.routeGeojson.coordinates).toHaveLength(3);
        expect(result?.routeGeojson.coordinates[1]).toEqual([129.0005, 35.0005]);
        expect(result?.anchors.map(anchor => [anchor.sourceTimestampNs, anchor.routePosition])).toEqual([["100", 0], ["200", 2]]);
        expect(result?.coordinateDistancesM).toHaveLength(3);
        route.mockRestore();
    });

    it("leaves anchors the matcher skipped out of the replay timing", async () => {
        const points: Array<[string, number, number, number]> = [
            ["100", 129, 35, 0], ["200", 129.001, 35.001, 150], ["300", 129.002, 35, 300],
        ];
        expect(roadAnchorIndices(points)).toEqual([0, 1, 2]);
        const route = vi.spyOn(routingInternalClient, "matchPreview").mockResolvedValueOnce({
            graphVersion: "test-graph",
            routeGeojson: { type: "LineString", coordinates: [[129, 35], [129.001, 35], [129.002, 35]] },
            anchorPositions: [0, 0, 2], snapDistancesM: [0, null, 0], skippedAnchors: [1],
        });
        const result = await matchReplayPreview({ fingerprint: "road-match-skip-test", points });
        expect(result?.anchors.map(anchor => anchor.sourceTimestampNs)).toEqual(["100", "300"]);
        route.mockRestore();
    });
});
