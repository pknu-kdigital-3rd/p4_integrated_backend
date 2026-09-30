import { describe, expect, it, vi } from "vitest";
import { roadAnchorIndices, matchReplayPreview, spliceSkippedStretches } from "../src/modules/trip/trip-road-match.ts";
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

    it("follows the recorded GPS through a skipped stretch instead of the guessed road bridge", async () => {
        const points: Array<[string, number, number, number]> = [
            ["100", 129, 35, 0], ["200", 129.001, 35.001, 150], ["300", 129.002, 35, 300],
        ];
        expect(roadAnchorIndices(points)).toEqual([0, 1, 2]);
        // The matcher skipped anchor 1 and bridged along a road far to the south.
        const route = vi.spyOn(routingInternalClient, "matchPreview").mockResolvedValueOnce({
            graphVersion: "test-graph",
            routeGeojson: { type: "LineString", coordinates: [[129, 35], [129.001, 34.99], [129.002, 35]] },
            anchorPositions: [0, 0, 2], snapDistancesM: [0, null, 0], skippedAnchors: [1],
        });
        const result = await matchReplayPreview({ fingerprint: "road-match-skip-test", points });
        expect(result?.routeGeojson.coordinates).toEqual([[129, 35], [129.001, 35.001], [129.002, 35]]);
        expect(result?.anchors.map(anchor => [anchor.sourceTimestampNs, anchor.routePosition])).toEqual([["100", 0], ["200", 1], ["300", 2]]);
        route.mockRestore();
    });
});

describe("splicing recorded GPS into skipped road-match stretches", () => {
    const points: Array<[string, number, number, number]> = [
        ["1", 129.000, 35, 0], ["2", 129.001, 35, 90], ["3", 129.002, 35.001, 200], ["4", 129.003, 35, 310], ["5", 129.004, 35, 400],
    ];
    const indices = [0, 2, 4];
    const road = [[129.000, 35], [129.002, 34.99], [129.004, 35]];

    it("keeps the matched route and its anchors when nothing was skipped", () => {
        const result = spliceSkippedStretches(points, indices, road, [0, 1, 2], []);
        expect(result.coordinates).toBe(road);
        expect(result.timing).toEqual([{ sourceTimestampNs: "1", position: 0 }, { sourceTimestampNs: "3", position: 1 }, { sourceTimestampNs: "5", position: 2 }]);
    });

    it("uses every recorded point between the matched anchors around a skip, timed by their own timestamps", () => {
        const result = spliceSkippedStretches(points, indices, road, [0, 0, 2], [1]);
        expect(result.coordinates).toEqual([[129.000, 35], [129.001, 35], [129.002, 35.001], [129.003, 35], [129.004, 35]]);
        expect(result.timing.map(entry => entry.sourceTimestampNs)).toEqual(["1", "2", "3", "4", "5"]);
        expect(result.timing.map(entry => entry.position)).toEqual([0, 1, 2, 3, 4]);
    });

    it("uses the recorded points for a skipped start or end", () => {
        const result = spliceSkippedStretches(points, indices, [[129.002, 35.001], [129.004, 35]], [0, 0, 1], [0]);
        expect(result.coordinates[0]).toEqual([129.000, 35]);
        expect(result.timing[0]).toEqual({ sourceTimestampNs: "1", position: 0 });
        expect(result.timing.at(-1)).toEqual({ sourceTimestampNs: "5", position: result.coordinates.length - 1 });
    });
});

