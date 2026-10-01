import { describe, expect, it } from "vitest";
import { shiftSnappedStops, waypointPassed, waypointRouteOffsets } from "../src/modules/virtual/virtual-waypoint-progress.ts";

describe("virtual waypoint progress", () => {
    const stops = [{ routeOffsetM: 0 }, { routeOffsetM: 120 }, { routeOffsetM: 300 }, { routeOffsetM: 500 }];

    it("returns offsets of the waypoint stops only", () => {
        expect(waypointRouteOffsets(stops, 2)).toEqual([120, 300]);
        expect(waypointRouteOffsets([{ lat: 1 }, {}, {}], 1)).toEqual([null]);
        expect(waypointRouteOffsets(undefined, 1)).toEqual([null]);
    });

    it("shifts stop offsets by an anchoring prefix", () => {
        expect(waypointRouteOffsets(shiftSnappedStops(stops, 40), 2)).toEqual([160, 340]);
    });

    it("treats a waypoint as passed once the vehicle offset reaches it", () => {
        expect(waypointPassed(120, 119.9)).toBe(false);
        expect(waypointPassed(120, 120)).toBe(true);
        // Unknown offsets never mark a waypoint reached.
        expect(waypointPassed(null, 500)).toBe(false);
        expect(waypointPassed(120, null)).toBe(false);
    });
});
