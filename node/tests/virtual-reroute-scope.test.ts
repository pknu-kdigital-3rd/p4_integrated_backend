import { describe, expect, it } from "vitest";
import { diffRoadState, remainingRouteEdgeIds, rerouteReason, routeAffectedByChange } from "../src/modules/virtual/virtual-reroute-scope.ts";

const G = "g1";
const itinerary = [
    { edgeId: `${G}:1:2:0`, cumulativeStartM: 0, lengthM: 100 },
    { edgeId: `${G}:2:3:0`, cumulativeStartM: 100, lengthM: 100 },
    { edgeId: `${G}:3:4:0`, cumulativeStartM: 200, lengthM: 100 },
];
const route = { directedItinerary: itinerary, graphVersion: G };
const empty = { blockedEdgeIds: [], penaltyEdgeFactors: {} };

describe("virtual reroute scope", () => {
    it("classifies blocked and penalty changes by direction", () => {
        const blocked = diffRoadState(empty, { blockedEdgeIds: [`${G}:2:3:0`], penaltyEdgeFactors: {} });
        expect([...blocked.tightenedEdgeIds]).toEqual([`${G}:2:3:0`]);
        expect(blocked.relaxedEdgeIds.size).toBe(0);
        expect(rerouteReason(blocked)).toBe("BLOCKED_EDGE");

        const penalty = diffRoadState(empty, { blockedEdgeIds: [], penaltyEdgeFactors: { [`${G}:2:3:0`]: 3 } });
        expect(rerouteReason(penalty)).toBe("PENALTY_INCREASE");

        const reopened = diffRoadState({ blockedEdgeIds: [`${G}:2:3:0`], penaltyEdgeFactors: {} }, empty);
        expect(rerouteReason(reopened)).toBe("ROAD_REOPENED");

        const cheaper = diffRoadState(
            { blockedEdgeIds: [], penaltyEdgeFactors: { [`${G}:2:3:0`]: 3 } },
            { blockedEdgeIds: [], penaltyEdgeFactors: { [`${G}:2:3:0`]: 2 } },
        );
        expect(rerouteReason(cheaper)).toBe("PENALTY_DECREASE");

        expect(rerouteReason(diffRoadState(empty, empty))).toBeNull();
    });

    it("lists only edges at or after the vehicle offset", () => {
        expect(remainingRouteEdgeIds(itinerary, 150)).toEqual([`${G}:2:3:0`, `${G}:3:4:0`]);
        expect(remainingRouteEdgeIds(itinerary, null)).toHaveLength(3);
    });

    it("reroutes only vehicles whose remaining route uses a tightened edge", () => {
        const change = diffRoadState(empty, { blockedEdgeIds: [`${G}:2:3:0`], penaltyEdgeFactors: {} });
        expect(routeAffectedByChange(route, 50, change)).toBe(true);
        // The vehicle has already passed the newly blocked edge.
        expect(routeAffectedByChange(route, 250, change)).toBe(false);
        const elsewhere = diffRoadState(empty, { blockedEdgeIds: [`${G}:9:8:0`], penaltyEdgeFactors: {} });
        expect(routeAffectedByChange(route, 0, elsewhere)).toBe(false);
    });

    it("reroutes every vehicle when a road becomes cheaper", () => {
        const change = diffRoadState({ blockedEdgeIds: [`${G}:9:8:0`], penaltyEdgeFactors: {} }, empty);
        expect(routeAffectedByChange(route, 0, change)).toBe(true);
    });

    it("treats a route on another graph build as affected", () => {
        const change = diffRoadState(empty, { blockedEdgeIds: ["g2:9:8:0"], penaltyEdgeFactors: {} });
        expect(routeAffectedByChange(route, 0, change)).toBe(true);
    });
});
