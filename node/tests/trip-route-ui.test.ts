import { describe, expect, it } from "vitest";

import { plannedProgress, recordedProgress, tripTimes } from "../../operator-web/trip-route-ui.js";

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

describe("trip progress track times", () => {
    const seoul = "Asia/Seoul";
    const route = { durationSec: 52 * 60 };

    it("shows the departure and the expected arrival from the planned route", () => {
        expect(tripTimes({ tripStatus: "IN_PROGRESS", startedAt: "2026-09-29T05:10:00Z", plannedRoute: route }, seoul))
            .toEqual({ origin: "14:10 출발", destination: "15:02 도착 예정" });
    });

    it("uses the planned start before departure and the actual arrival once completed", () => {
        expect(tripTimes({ tripStatus: "READY", plannedStartAt: "2026-09-29T06:30:00Z", plannedRoute: route }, seoul))
            .toEqual({ origin: "15:30 출발 예정", destination: "16:22 도착 예정" });
        expect(tripTimes({ tripStatus: "COMPLETED", startedAt: "2026-09-29T05:10:00Z", endedAt: "2026-09-29T05:40:00Z", plannedRoute: route }, seoul))
            .toEqual({ origin: "14:10 출발", destination: "14:40 도착" });
    });

    it("estimates a replay-only arrival from the recorded path's time span", () => {
        const replayPreview = { points: [["1000000000", 129, 35, 0], [String(1000000000 + 30 * 60 * 1e9), 129, 35.1, 1000]] };
        expect(tripTimes({ tripStatus: "IN_PROGRESS", startedAt: "2026-09-29T05:10:00Z", replayPreview }, seoul).destination).toBe("14:40 도착 예정");
    });

    it("says what is unknown instead of guessing", () => {
        expect(tripTimes({ tripStatus: "READY" }, seoul)).toEqual({ origin: "출발 대기", destination: "도착 시간 미정" });
        expect(tripTimes({ tripStatus: "CANCELLED", startedAt: "2026-09-29T05:10:00Z" }, seoul).destination).toBe("운행 취소");
    });
});
