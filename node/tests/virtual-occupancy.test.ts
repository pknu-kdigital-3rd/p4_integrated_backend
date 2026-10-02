import { describe, expect, it } from "vitest";

import { occupiedVehicleIds, undirectedSegmentKey } from "../src/modules/virtual/virtual-occupancy.ts";

const G = "0123456789abcdef0123456789abcdef";
// 효열로 (OSM way 164679522): origin -> waypoint 1 -> first corner.
const ORIGIN_TO_JUNCTION = `${G}:1762585346:436820035:0`;
const WAYPOINT_TO_NEXT = `${G}:436826946:436778303:0`;
const NEXT_TO_CORNER = `${G}:436778303:436838981:0`;

describe("virtual road occupancy", () => {
    it("keys a segment by its two nodes in either direction", () => {
        expect(undirectedSegmentKey(`${G}:5:9:0`)).toBe(undirectedSegmentKey(`${G}:9:5:0`));
        expect(undirectedSegmentKey(`${G}:5:9:0`)).toBe(undirectedSegmentKey(`${G}:5:9:1`));
        expect(undirectedSegmentKey("5:9:0")).toBe("|5|9");
        expect(undirectedSegmentKey("bad")).toBeNull();
    });

    it("allows blocking a later stretch of the same street", () => {
        const states = [{ vehicleId: 18n, currentEdgeId: ORIGIN_TO_JUNCTION }];
        expect(occupiedVehicleIds(states, { affectedDirectedEdgeIds: [WAYPOINT_TO_NEXT, NEXT_TO_CORNER] })).toEqual([]);
    });

    it("refuses blocking the segment under the vehicle, in either direction", () => {
        const states = [{ vehicleId: 18n, currentEdgeId: ORIGIN_TO_JUNCTION }, { vehicleId: 19n, currentEdgeId: null }];
        expect(occupiedVehicleIds(states, { affectedDirectedEdgeIds: [ORIGIN_TO_JUNCTION] })).toEqual(["18"]);
        expect(occupiedVehicleIds(states, { affectedDirectedEdgeIds: [`${G}:436820035:1762585346:0`] })).toEqual(["18"]);
    });

    it("does not match the same nodes on another graph build", () => {
        const states = [{ vehicleId: 18n, currentEdgeId: ORIGIN_TO_JUNCTION }];
        expect(occupiedVehicleIds(states, { affectedDirectedEdgeIds: [`ffffffffffffffffffffffffffffffff:1762585346:436820035:0`] })).toEqual([]);
    });
});
