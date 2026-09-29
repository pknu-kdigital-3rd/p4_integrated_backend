import { describe, expect, it } from "vitest";

import { plannedProgress, recordedProgress } from "../../operator-web/trip-route-ui.js";

const line = { type: "LineString", coordinates: [[129.0, 35.0], [129.0, 35.01], [129.0, 35.02]] };

describe("planned route progress", () => {
    it("projects a real GPS fix onto the optimal route", () => {
        const progress = plannedProgress(line, { latitude: 35.01, longitude: 129.0 })!;
        expect(progress.percent).toBe(50);
        expect(progress.offRouteM).toBe(0);
        expect(progress.remainingM).toBeGreaterThan(1100);
        expect(progress.remainingM).toBeLessThan(1120);
    });

    it("reports how far an off-route fix is from the plan", () => {
        expect(plannedProgress(line, { latitude: 35.01, longitude: 129.01 })!.offRouteM).toBeGreaterThan(900);
    });

    it("returns null without a usable route or fix", () => {
        expect(plannedProgress(null, { latitude: 35, longitude: 129 })).toBeNull();
        expect(plannedProgress(line, { latitude: Number.NaN, longitude: 129 })).toBeNull();
    });
});

describe("recorded replay progress", () => {
    const preview = { totalDistanceM: 200, points: [["1000", 129, 35, 0], ["2000", 129, 35.0009, 100], ["3000", 129, 35.0018, 200]] };

    it("interpolates distance through the prerecorded path by source timestamp", () => {
        expect(recordedProgress(preview, "2500")).toEqual({ percent: 75, remainingM: 50 });
    });

    it("clamps before the first and after the final record", () => {
        expect(recordedProgress(preview, "10")).toEqual({ percent: 0, remainingM: 200 });
        expect(recordedProgress(preview, "9000")).toEqual({ percent: 100, remainingM: 0 });
    });

    it("does not report progress without a replay position", () => {
        expect(recordedProgress(preview, null)).toBeNull();
    });

    it("keeps partial progress when a trip completes early", () => {
        expect(recordedProgress(preview, "1500")?.percent).toBe(25);
    });
});
