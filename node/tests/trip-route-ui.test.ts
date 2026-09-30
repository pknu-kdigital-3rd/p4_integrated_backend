import { describe, expect, it } from "vitest";

import { estimatedReplayTimestamp, forwardOnlyPosition, gapAwareReplayLine, matchedRoutePosition, replayClock, replayRouteLine, routeDisplayFromPosition, routeFromPosition, plannedProgress, recordedProgress, remainingRoute, replayLineTiming, replayProgressOnRoute, tripTimes } from "../../operator-web/trip-route-ui.js";

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

describe("vehicle snapping stability", () => {
    // A route that runs east, turns back west on a parallel road 20 m north, then east again.
    const doubledBack = [[129.000, 35.0000], [129.004, 35.0000], [129.004, 35.0002], [129.000, 35.0002], [129.000, 35.0004], [129.004, 35.0004]];

    it("does not jump to a much later segment of a route that doubles back", () => {
        // Near the start, but on the far side: nearest overall is the returning leg (segment 3).
        const fix = { latitude: 35.00015, longitude: 129.0005 };
        expect(remainingRoute(doubledBack, fix, 0)!.position).toBeGreaterThan(2);
        expect(remainingRoute(doubledBack, fix, 0, false, false, { maxAheadM: 300 })!.position).toBeLessThan(1);
    });

    it("ignores segments facing against the vehicle's heading", () => {
        const fix = { latitude: 35.00012, longitude: 129.002 };
        // Heading east: the westbound leg in between is skipped although it is nearer.
        const east = remainingRoute(doubledBack, fix, 0, false, false, { headingDeg: 90 })!;
        expect(Math.floor(east.position)).not.toBe(2);
        expect([0, 4]).toContain(Math.floor(east.position));
    });

    it("predicts continuously from the moment a fix arrives", () => {
        const receivedAt = "2026-09-30T00:00:00.000Z";
        expect(estimatedReplayTimestamp("1000000000", receivedAt, Date.parse(receivedAt) + 200, 40)).toBe("1200000000");
        expect(estimatedReplayTimestamp("1000000000", receivedAt, Date.parse(receivedAt) - 10, 40)).toBeNull();
    });

    it("holds position through a small backward correction but follows a real seek", () => {
        const distances = [0, 100, 200, 300];
        expect(forwardOnlyPosition(2, 1.7, distances)).toBe(2);
        expect(forwardOnlyPosition(2, 0.5, distances)).toBe(0.5);
        expect(forwardOnlyPosition(1, 2.5, distances)).toBe(2.5);
        expect(forwardOnlyPosition(Number.NaN, 1, distances)).toBe(1);
    });

    it("times the recorded line from its own points when there is no road match", () => {
        const preview = { points: [["100", 129, 35, 0], ["200", 129.001, 35, 90], ["300", 129.002, 35, 180]] };
        const timing = replayLineTiming(preview)!;
        expect(timing.distances).toEqual([0, 90, 180]);
        expect(matchedRoutePosition(timing.anchors, "250", timing.distances)).toBeCloseTo(1.5);
        const matched = { ...preview, roadMatch: { anchors: [{ sourceTimestampNs: "100", routePosition: 0 }, { sourceTimestampNs: "300", routePosition: 4 }], coordinateDistancesM: [0, 1, 2, 3, 4] } };
        expect(replayLineTiming(matched)!.anchors).toBe(matched.roadMatch.anchors);
    });
});

describe("replay clock through GPS gaps", () => {
    it("uses the replay clock when it has moved past the last GPS fix", () => {
        const metadata = { sourceTimestampNs: "1000000000", receivedAt: "2026-09-30T03:00:00.000Z",
            sourceClockNs: "21000000000", sourceClockAt: "2026-09-30T03:00:20.000Z" };
        expect(replayClock(metadata)).toEqual({ time: "21000000000", at: "2026-09-30T03:00:20.000Z" });
        // Along a recorded line with a 275 s tunnel gap, the clock places the vehicle inside it.
        const timing = replayLineTiming({ points: [["1000000000", 129.08, 35.24, 0], ["276000000000", 129.03, 35.24, 4932]] })!;
        expect(matchedRoutePosition(timing.anchors, replayClock(metadata)!.time, timing.distances)).toBeCloseTo(20 / 275);
    });

    it("falls back to the GPS fix when the clock is missing, malformed or not newer", () => {
        expect(replayClock({ sourceTimestampNs: "5" })).toBeNull();
        expect(replayClock({ sourceTimestampNs: "5", sourceClockNs: "x", sourceClockAt: "t" })).toBeNull();
        expect(replayClock({ sourceTimestampNs: "5", sourceClockNs: "5", sourceClockAt: "t" })).toBeNull();
    });
});

describe("replay path drawn from the vehicle's position", () => {
    const line = [[129.000, 35.0], [129.001, 35.0], [129.002, 35.0]];

    it("starts the drawn path exactly where the vehicle is", () => {
        const path = routeFromPosition(line, 0.5)!;
        expect(path[0]).toEqual([35.0, 129.0005]);
        expect(path.slice(1)).toEqual([[35.0, 129.001], [35.0, 129.002]]);
    });

    it("clamps to the line and rejects unusable input", () => {
        expect(routeFromPosition(line, 5)!).toEqual([[35.0, 129.002], [35.0, 129.002]]);
        expect(routeFromPosition(line, -1)![0]).toEqual([35.0, 129.0]);
        expect(routeFromPosition(line, Number.NaN)).toBeNull();
        expect(routeFromPosition([[129, 35]], 0)).toBeNull();
    });
});

describe("recorded GPS line with road only across GPS gaps", () => {
    // Recording: normal fixes, then a 60 s tunnel gap between x=129.002 and x=129.008.
    const points = [
        ["1000000000", 129.000, 35.0000, 0], ["2000000000", 129.001, 35.0001, 90],
        ["3000000000", 129.002, 35.0000, 180], ["63000000000", 129.008, 35.0000, 730],
        ["64000000000", 129.009, 35.0001, 820],
    ];
    // Road through the tunnel curves 0.0005 deg (about 55 m) north.
    const road = [[129.000, 35.0000], [129.002, 35.0000], [129.005, 35.0005], [129.008, 35.0000], [129.010, 35.0000]];

    it("draws the route from the GPS vehicle, even when the road match runs elsewhere", () => {
        const preview = { points: points.slice(0, 3), roadMatch: {
            routeGeojson: { coordinates: [[129.000, 35.01], [129.002, 35.01]] },
            anchors: [{ sourceTimestampNs: points[0]![0], routePosition: 0, routeDistanceM: 0 },
                { sourceTimestampNs: points[2]![0], routePosition: 1, routeDistanceM: 180 }],
            coordinateDistancesM: [0, 180],
        } };
        const gpsLine = replayRouteLine(preview, "gaps");
        const position = matchedRoutePosition(gpsLine.timing!.anchors, points[1]![0], gpsLine.timing!.distances)!;
        expect(routeFromPosition(gpsLine.coordinates!, position)![0]).toEqual([points[1]![2], points[1]![1]]);
        expect(replayRouteLine(preview, "always").coordinates).toEqual(preview.roadMatch.routeGeojson.coordinates);
    });

    it("keeps the recorded fixes where GPS exists and follows the road through the gap", () => {
        const line = gapAwareReplayLine(points, road)!;
        const coords = line.coordinates;
        expect(coords[0]).toEqual([129.000, 35.0000]);
        expect(coords[1]).toEqual([129.001, 35.0001]);
        expect(coords.some(([lon, lat]) => lon === 129.005 && lat === 35.0005)).toBe(true);
        expect(coords.at(-1)).toEqual([129.009, 35.0001]);
    });

    it("times the road section so the vehicle is inside the tunnel halfway through the gap", () => {
        const line = gapAwareReplayLine(points, road)!;
        const tunnelMiddle = line.anchors.find(anchor => line.coordinates[anchor.routePosition]![0] === 129.005)!;
        expect(Number(tunnelMiddle.sourceTimestampNs)).toBeGreaterThan(3e9);
        expect(Number(tunnelMiddle.sourceTimestampNs)).toBeLessThan(63e9);
        const times = line.anchors.map(anchor => BigInt(anchor.sourceTimestampNs));
        expect(times.every((time, index) => index === 0 || time >= times[index - 1]!)).toBe(true);
    });

    it("disconnects an unmatched gap instead of drawing a straight shortcut", () => {
        const noRoad = gapAwareReplayLine(points, null)!;
        expect(noRoad.coordinates).toHaveLength(points.length);
        expect(noRoad.breaks).toEqual([3]);
        const duringGap = routeDisplayFromPosition(noRoad.coordinates, 2.5, noRoad.breaks)!;
        expect(duringGap.head).toEqual([35, 129.002]);
        expect(duringGap.latLngs[0]![0]).toEqual([35, 129.008]);
        const farRoad = road.map(([lon, lat]) => [lon, lat + 0.01]);
        expect(gapAwareReplayLine(points, farRoad)!.breaks).toEqual([3]);
        const wrongCarriageway = road.map(([lon, lat]) => [lon, lat + 0.001]);
        expect(gapAwareReplayLine(points, wrongCarriageway)!.breaks).toEqual([3]);
    });

    it("uses the timed road section through a gap instead of a nearer earlier loop", () => {
        const loop = [
            [129.000, 35.0000], [129.004, 35.0000],
            [129.004, 35.0004], [129.000, 35.0004],
            [129.000, 35.0002], [129.004, 35.0002],
        ];
        const fixes = [
            ["1000000000", 129.0005, 35.00008, 0],
            ["61000000000", 129.0035, 35.00008, 275],
        ];
        const routeDistances = [0, 364, 408, 772, 794, 1158];
        const preview = { points: fixes, roadMatch: {
            routeGeojson: { coordinates: loop },
            anchors: [
                { sourceTimestampNs: fixes[0]![0], routePosition: 4.125, routeDistanceM: 839.5 },
                { sourceTimestampNs: fixes[1]![0], routePosition: 4.875, routeDistanceM: 1112.5 },
            ],
            coordinateDistancesM: routeDistances,
        } };
        const line = replayRouteLine(preview, "gaps");
        expect(line.coordinates!.some(([, lat]) => lat === 35.0002)).toBe(true);
        expect(line.coordinates!.some(([, lat]) => lat === 35.0000)).toBe(false);
    });

    it("snaps an inaccurate ordinary fix back to its timed road section", () => {
        const fixes = [
            ["1000000000", 129.0000, 35.0000, 0],
            ["3000000000", 129.0010, 34.9995, 100],
            ["5000000000", 129.0020, 35.0000, 200],
        ];
        const preview = { points: fixes, roadMatch: {
            routeGeojson: { coordinates: [[129.0000, 35], [129.0010, 35], [129.0020, 35]] },
            anchors: fixes.map((point, index) => ({sourceTimestampNs:point[0],routePosition:index,routeDistanceM:index*91})),
            coordinateDistancesM: [0, 91, 182],
        } };
        const line = replayRouteLine(preview, "gaps");
        expect(line.coordinates![1]).toEqual([129.001, 35]);
        expect(line.coordinates!.every(([,lat])=>lat===35)).toBe(true);
    });

    it("keeps a stopped vehicle in place when a fix jitters just behind it", () => {
        // A long second segment: skipping the first one would jump ~90 m to its start.
        const fixes = [
            ["1000000000", 129.00100, 35, 0], ["2000000000", 129.00099, 35, 1],
            ["3000000000", 129.00099, 35, 1], ["4000000000", 129.00300, 35, 183],
        ];
        const preview = { points: fixes, roadMatch: {
            routeGeojson: { coordinates: [[129.000, 35], [129.002, 35], [129.004, 35]] },
            anchors: [0.5, 0.5, 0.5, 1.5].map((routePosition, index) => ({ sourceTimestampNs: fixes[index]![0], routePosition, routeDistanceM: routePosition * 182 })),
            coordinateDistancesM: [0, 182, 364],
        } };
        const line = replayRouteLine(preview, "gaps");
        for (const [lon] of line.coordinates!.slice(0, 3)) expect(lon).toBeCloseTo(129.001, 5);
    });

    it("keeps an outbound fix off a nearer return carriageway after a U-turn", () => {
        // Outbound east on lat 35.0, U-turn, return west 10 m north; the fixes
        // run between the two, slightly nearer the return carriageway.
        const road = [[129.000, 35], [129.003, 35], [129.003, 35.00009], [129.000, 35.00009]];
        const fixes = [0.0005, 0.0010, 0.0015, 0.0020].map((offset, index) => [`${index + 1}000000000`, 129 + offset, 35.00005, offset * 91080]);
        const preview = { points: fixes, roadMatch: {
            routeGeojson: { coordinates: road },
            anchors: fixes.map(point => ({ sourceTimestampNs: point[0], routePosition: (point[1] - 129) / 0.003, routeDistanceM: point[3] })),
            coordinateDistancesM: [0, 273.2, 283.2, 556.4],
        } };
        const line = replayRouteLine(preview, "gaps");
        expect(line.coordinates!.every(([, lat]) => lat === 35)).toBe(true);
    });

    it("moves onto an offset tunnel road over the gap instead of jumping at its start", () => {
        const tunnelFixes = [
            ["1000000000", 129.09566, 35.14950, 0],
            ["61000000000", 129.10320, 35.15880, 1150],
        ];
        // Bundled OSM PBF: south entrance and north exit of 번영로 광안터널.
        const tunnelRoad = [[129.096724, 35.149529], [129.103674, 35.158260]];
        const preview = { points: tunnelFixes, roadMatch: {
            routeGeojson: { coordinates: tunnelRoad },
            anchors: [
                { sourceTimestampNs: tunnelFixes[0]![0], routePosition: 0, routeDistanceM: 0 },
                { sourceTimestampNs: tunnelFixes[1]![0], routePosition: 1, routeDistanceM: 1150 },
            ],
            coordinateDistancesM: [0, 1150],
        } };
        const line = replayRouteLine(preview, "gaps");
        expect(line.coordinates).toHaveLength(4);
        expect(BigInt(line.timing!.anchors[1]!.sourceTimestampNs)).toBeGreaterThan(BigInt(tunnelFixes[0]![0]));
        expect(BigInt(line.timing!.anchors[2]!.sourceTimestampNs)).toBeLessThan(BigInt(tunnelFixes[1]![0]));
    });
});
