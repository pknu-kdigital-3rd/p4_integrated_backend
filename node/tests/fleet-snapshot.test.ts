import { describe, expect, it } from "vitest";

import type { PrismaClient } from "../src/generated/prisma/client.ts";
import {
    MAX_SNAPSHOT_TEXT_CHARS,
    collectFleetSnapshot,
    renderReportFigures,
    renderSnapshotText,
    reportRetrievalQuery,
} from "../src/modules/fleet/fleet.snapshot.ts";

const NOW = new Date("2026-10-02T01:00:00Z"); // 10:00 KST

function fakeDb(overrides: Record<string, unknown> = {}) {
    const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
    const db = {
        vehicle: {
            findMany: async () => [
                { vehicleId: 1n, vehicleCode: "BIMS-1", vehicleSource: "BIMS", vehicleStatus: "DRIVING" },
                { vehicleId: 2n, vehicleCode: "TRUCK-2", vehicleSource: "CUSTOM", vehicleStatus: "DRIVING" },
                { vehicleId: 3n, vehicleCode: "TRUCK-3", vehicleSource: "CUSTOM", vehicleStatus: "READY" },
                { vehicleId: 4n, vehicleCode: "TRUCK-4", vehicleSource: "CUSTOM", vehicleStatus: "READY" },
            ],
        },
        $queryRaw: async () => [
            { vehicle_id: 1n, received_at: ago(20), speed_kmh: "35.5" },
            { vehicle_id: 2n, received_at: ago(600), speed_kmh: null },
            { vehicle_id: 3n, received_at: null, speed_kmh: null },
            { vehicle_id: 4n, received_at: null, speed_kmh: null },
        ],
        trip: { findMany: async () => [{ vehicleId: 3n, destinationName: "부산신항" }] },
        virtualScenario: {
            findMany: async () => [{
                scenarioId: 7n, name: "도심 통제",
                vehicleStates: [
                    { simStatus: "DRIVING", blockedReason: null, vehicle: { vehicleCode: "V-1" } },
                    { simStatus: "NO_ROUTE", blockedReason: "No viable path after road restriction", vehicle: { vehicleCode: "V-2" } },
                ],
                restrictions: [{ kind: "BLOCKED" }, { kind: "BLOCKED" }, { kind: "HEAVY_PENALTY" }],
                events: [{ eventType: "ROAD_RESTRICTION_PAINTED" }, { eventType: "ROAD_RESTRICTION_PAINTED" }],
            }],
        },
        detectionEvent: {
            groupBy: async (args: { by: string[] }) => args.by[0] === "riskLevel"
                ? [{ riskLevel: "DANGER", _count: { _all: 2 } }, { riskLevel: "NORMAL", _count: { _all: 40 } }]
                : [{ className: "person", _count: { _all: 30 } }, { className: "car", _count: { _all: 12 } }],
        },
        alert: {
            count: async () => 1,
            findMany: async () => [{ alertType: "OBJECT_PROXIMITY", severity: "CRITICAL", alertMessage: "보행자 접근", createdAt: ago(120), vehicle: { vehicleCode: "TRUCK-2" } }],
        },
        ...overrides,
    };
    return db as unknown as PrismaClient;
}

describe("fleet snapshot", () => {
    it("aggregates real vehicles, flags only vehicles expected to report", async () => {
        const snapshot = await collectFleetSnapshot(fakeDb(), NOW);
        const real = snapshot.realVehicles;
        expect(real.total).toBe(4);
        expect(real.bySource).toEqual({ BIMS: 1, CUSTOM: 3 });
        // Bucketed as the map shows them; READY is 대기, never 정지/정차.
        expect(real.byStatus).toEqual({ 운행중: 2, 대기: 2 });
        expect([real.reporting, real.stale, real.noPosition]).toEqual([1, 1, 2]);
        expect(real.activeTrips).toBe(1);
        // TRUCK-4 is READY without a trip, so missing positions are expected.
        expect(real.notable.map((note) => [note.vehicleCode, note.reason])).toEqual([
            ["TRUCK-3", "NO_POSITION"],
            ["TRUCK-2", "STALE_POSITION"],
        ]);
        expect(real.notable[0]!.tripDestination).toBe("부산신항");
        expect(real.reportingVehicles).toEqual([{ vehicleCode: "BIMS-1", speedKmh: 35.5, lastFixAgeSeconds: 20, tripDestination: null }]);
        expect(renderSnapshotText(snapshot)).toContain("- BIMS-1 35.5 km/h, 마지막 위치 20초 전");
    });

    it("summarises virtual scenarios and vision", async () => {
        const snapshot = await collectFleetSnapshot(fakeDb(), NOW);
        const scenario = snapshot.virtual.scenarios[0]!;
        expect(scenario.byStatus).toEqual({ DRIVING: 1, NO_ROUTE: 1 });
        expect(scenario.restrictions).toEqual({ blocked: 2, penalty: 1 });
        expect(scenario.problemVehicles).toEqual([{ vehicleCode: "V-2", simStatus: "NO_ROUTE", blockedReason: "No viable path after road restriction" }]);
        expect(snapshot.vision.detections).toBe(42);
        expect(snapshot.vision.byRisk).toEqual({ DANGER: 2, NORMAL: 40 });
        expect(snapshot.vision.unconfirmedAlerts).toBe(1);
    });

    it("renders compact Korean text with KST time and the flagged items", async () => {
        const text = renderSnapshotText(await collectFleetSnapshot(fakeDb(), NOW));
        expect(text).toContain("[기준 시각] 2026. 10. 02. 10:00 (KST)");
        expect(text).toContain("위치 수신: 정상 1대, 지연(2분 초과) 1대, 기록 없음 2대");
        expect(text).toContain("TRUCK-2 (자체 등록, 운행중) 마지막 위치 10분 전");
        expect(text).toContain("V-2 경로 없음 (도로 통제 후 우회 경로 없음)");
        expect(text).toContain("객체 근접 심각 TRUCK-2: 보행자 접근");
    });

    it("caps the snapshot text", async () => {
        const many = Array.from({ length: 200 }, (_, index) => ({
            scenarioId: BigInt(index), name: `시나리오 ${"가".repeat(40)} ${index}`,
            vehicleStates: [], restrictions: [], events: [],
        }));
        const snapshot = await collectFleetSnapshot(fakeDb({ virtualScenario: { findMany: async () => many } }), NOW);
        expect(snapshot.virtual.scenarios).toHaveLength(8);
        expect(renderSnapshotText(snapshot).length).toBeLessThanOrEqual(MAX_SNAPSHOT_TEXT_CHARS);
    });

    it("renders report figures from data and steers retrieval to current issues", async () => {
        const snapshot = await collectFleetSnapshot(fakeDb(), NOW);
        const figures = renderReportFigures(snapshot);
        expect(figures).toContain("| 활성 차량 | 4대 |");
        expect(figures).toContain("| 도심 통제 (#7) | 2대 | 주행 중 1, 경로 없음 1 | 2 / 1 |");
        expect(figures).toContain("| 미확인 경보 | 1건 |");
        const query = reportRetrievalQuery(snapshot);
        expect(query).toContain("도로 통제");
        expect(query).toContain("충돌 방지");
    });
});
