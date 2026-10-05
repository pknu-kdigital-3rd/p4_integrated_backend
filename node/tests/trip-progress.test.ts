import { describe, expect, it } from "vitest";
import { replayRemaining, routeRemaining } from "../src/modules/assistant/trip.progress.ts";
import { remainingText } from "../src/modules/assistant/assistant.context.ts";

const S = 1_000_000_000n;
// [sourceTimestampNs, lon, lat, cumulativeDistanceM]
const PREVIEW = [[String(100n * S), 129, 35, 0], [String(160n * S), 129.01, 35, 900], [String(400n * S), 129.05, 35, 4500]];

describe("trip remaining", () => {
    it("interpolates replay distance and recording time left", () => {
        expect(replayRemaining(PREVIEW, String(130n * S))).toEqual({ distanceM: 4050, durationSec: 270, basis: "REPLAY" });
        expect(replayRemaining(PREVIEW, String(500n * S))).toEqual({ distanceM: 0, durationSec: 0, basis: "REPLAY" });
        expect(replayRemaining(PREVIEW, null)).toBeNull();
        expect(replayRemaining("bad", String(130n * S))).toBeNull();
    });

    it("projects the fix onto a planned route and scales its duration", () => {
        const route = { type: "LineString", coordinates: [[129, 35], [129.01, 35], [129.02, 35]] };
        const halfway = routeRemaining(route, { lat: 35.0001, lon: 129.01 }, 1800, 600)!;
        expect(halfway.basis).toBe("ROUTE");
        expect(halfway.distanceM).toBeCloseTo(900, 0);
        expect(halfway.durationSec).toBeCloseTo(300, 0);
        expect(routeRemaining({ coordinates: [] }, { lat: 35, lon: 129 }, null, null)).toBeNull();
    });

    it("renders distance and time for the assistant", () => {
        expect(remainingText({ distanceM: 4120, durationSec: 270, basis: "REPLAY" })).toBe("남은 거리 4.1 km, 남은 시간 약 5분");
        expect(remainingText({ distanceM: 12_000, durationSec: 4000, basis: "ROUTE" })).toBe("남은 거리 12.0 km, 남은 시간 약 1시간 7분 (계획 경로 기준)");
        expect(remainingText({ distanceM: 500, durationSec: null, basis: "ROUTE" })).toBe("남은 거리 0.5 km (계획 경로 기준, 남은 시간 확인 불가)");
    });
});
