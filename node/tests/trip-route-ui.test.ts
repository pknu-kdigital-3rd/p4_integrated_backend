import { describe, expect, it } from "vitest";

import { estimatedReplayTimestamp, matchedRoutePosition, plannedProgress, recordedProgress, remainingRoute, replayProgressOnRoute, tripTimes } from "../../operator-web/trip-route-ui.js";

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

describe("road-matched replay display", () => {
    it("interpolates playback position along the matched road and starts on the road", () => {
        const anchors = [
            { sourceTimestampNs: "100", routePosition: 0 },
            { sourceTimestampNs: "300", routePosition: 2 },
        ];
        const position = matchedRoutePosition(anchors, "200")!;
        expect(position).toBe(1);
        const line = remainingRoute([[129, 35], [129.001, 35], [129.002, 35]],
            { latitude: 35.0001, longitude: 129.001 }, position, true)!;
        expect(line.latLngs[0]?.[0]).toBe(35);
        expect(line.latLngs.at(-1)).toEqual([35, 129.002]);
    });
    it("moves an estimated marker by road distance through a GPS gap and caps prediction", () => {
        const anchors = [
            { sourceTimestampNs: "1000000000", routePosition: 0, routeDistanceM: 0 },
            { sourceTimestampNs: "11000000000", routePosition: 2, routeDistanceM: 200 },
        ];
        const receivedAt = "2026-09-30T00:00:00.000Z";
        const time = estimatedReplayTimestamp("1000000000", receivedAt, Date.parse(receivedAt) + 5000, 40)!;
        expect(time).toBe("6000000000");
        expect(matchedRoutePosition(anchors, time, [0, 50, 200])).toBeCloseTo(1 + 50 / 150);
        const predicted = remainingRoute([[129, 35], [129.0005, 35.0005], [129.001, 35]],
            { latitude: 35, longitude: 129 }, 1.5, true, true)!;
        expect(predicted.latLngs[0]?.[0]).toBeCloseTo(35.00025);
        expect(predicted.latLngs[0]?.[1]).toBeCloseTo(129.00075);
        expect(estimatedReplayTimestamp("1000000000", receivedAt, Date.parse(receivedAt) + 60000, 40))
            .toBe("46000000000");
        expect(estimatedReplayTimestamp("1000000000", receivedAt, Date.parse(receivedAt) + 5000, 0)).toBeNull();
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

describe("replay progress on the operator's planned route", () => {
    it("measures the replay position along the planned route toward the operator's destination", () => {
        const progress = replayProgressOnRoute(line, { latitude: 35.01, longitude: 129.0 })!;
        expect(progress.percent).toBe(50);
        expect(progress.label).toMatch(/^GPS 재생 위치 기준 50% · 남은 계획 경로 1\.1 km$/);
    });

    it("keeps a percentage for a replay path that runs beside the route and says how far off it is", () => {
        const progress = replayProgressOnRoute(line, { latitude: 35.015, longitude: 129.01 })!;
        expect(progress.percent).toBe(75);
        expect(progress.label).toContain("계획 경로에서");
    });

    it("has nothing to show without a planned route", () => {
        expect(replayProgressOnRoute(null, { latitude: 35, longitude: 129 })).toBeNull();
    });
});
