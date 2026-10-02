import { describe, expect, it } from "vitest";

import type { PrismaClient } from "../src/generated/prisma/client.ts";
import {
    asksAboutScenario,
    buildAssistantContext,
    haversineM,
    realVehicleContext,
    scenarioContext,
    virtualVehicleContext,
    type RealVehicleDetail,
    type ScenarioDetail,
    type VirtualVehicleDetail,
} from "../src/modules/assistant/assistant.context.ts";
import { assistantChatSchema } from "../src/modules/assistant/assistant.schema.ts";

const NOW = new Date("2026-10-02T01:00:00Z"); // 10:00 KST

const REAL: RealVehicleDetail = {
    vehicleCode: "TRUCK-2", vehicleName: "2호 운반차", source: "CUSTOM", status: "DRIVING",
    fix: { recordedAt: "2026-10-02T00:59:57Z", ageSeconds: 3, lat: 35.10674, lon: 128.94709, speedKmh: 32.4, headingDeg: 118, accuracyM: 4.2, telemetrySource: "DEVICE_GPS" },
    recentSpeed: { samples: 60, minKmh: 12, avgKmh: 27.3, maxKmh: 38.9 },
    trip: { tripId: "41", status: "IN_PROGRESS", originName: "1부두", destinationName: "부산신항", startedAt: "2026-10-02T00:40:00Z" },
    nearby: [{ vehicleCode: "TRUCK-5", distanceM: 42.6, speedKmh: 20, ageSeconds: 2 }],
    detections: {
        total: 12, byRisk: { DANGER: 1, NORMAL: 11 }, topClasses: [{ className: "person", count: 8 }],
        nearest: { className: "person", distanceM: 3.4, riskLevel: "DANGER", detectedAt: "2026-10-02T00:58:00Z" },
        attitude: { pitchDeg: 2.15, rollDeg: -0.42, detectedAt: "2026-10-02T00:59:00Z" },
    },
    alerts: { unconfirmed: 1, recent: [{ alertType: "OBJECT_PROXIMITY", severity: "CRITICAL", vehicleCode: "TRUCK-2", message: "보행자 접근", createdAt: "2026-10-02T00:58:00Z" }] },
};

const SCENARIO: ScenarioDetail = {
    scenarioId: "7", name: "도심 통제", state: "ACTIVE",
    vehicles: [
        { vehicleCode: "SIM-1", simStatus: "DRIVING", speedKmh: 30, blockedReason: null },
        { vehicleCode: "SIM-2", simStatus: "NO_ROUTE", speedKmh: 0, blockedReason: "No viable path" },
    ],
    byStatus: { DRIVING: 1, NO_ROUTE: 1 },
    restrictions: { blocked: 2, penalty: 1, reasons: ["공사"] },
    recentEvents: { ROAD_RESTRICTION_ACTIVATED: 2 },
    lastEvents: [{ eventType: "ROAD_RESTRICTION_ACTIVATED", createdAt: "2026-10-02T00:55:00Z" }],
};

const VIRTUAL: VirtualVehicleDetail = {
    vehicleCode: "SIM-1", vehicleName: null,
    state: { simStatus: "DRIVING", speedKmh: 30, speedFactor: 2, blockedReason: null, lastCheckpointAt: "2026-10-02T00:59:59Z", position: { lat: 35.2673, lon: 129.01862 }, routeVersion: 3 },
    trip: { tripId: "22", state: "DRIVING", startedAt: "2026-10-02T00:50:00Z", endedAt: null, waypointsReached: 1, waypointsTotal: 2, route: { distanceM: 1830, durationSec: 240, reason: "RESTRICTION" } },
    nearby: [{ vehicleCode: "SIM-2", distanceM: 1250, speedKmh: 0, ageSeconds: 1 }],
    recentEvents: { ROUTE_RECALCULATED: 2 },
    lastEvents: [{ eventType: "ROUTE_RECALCULATED", createdAt: "2026-10-02T00:56:00Z" }],
};

describe("assistant scope schema", () => {
    it("accepts monitoring and virtual scopes and rejects malformed ids", () => {
        expect(assistantChatSchema.safeParse({ question: "q", scope: { view: "monitoring", vehicleId: "12" } }).success).toBe(true);
        expect(assistantChatSchema.safeParse({ question: "q", scope: { view: "virtual", scenarioId: "7", vehicleId: "9" } }).success).toBe(true);
        expect(assistantChatSchema.safeParse({ question: "q", scope: { view: "monitoring", vehicleId: "1; drop" } }).success).toBe(false);
        expect(assistantChatSchema.safeParse({ question: "q", scope: { view: "elsewhere" } }).success).toBe(false);
    });
});

describe("assistant context rendering", () => {
    it("describes the selected real vehicle's position, speed, neighbours and IMU attitude", () => {
        const context = realVehicleContext(REAL, NOW.toISOString(), null);
        expect(context.subject).toBe("실차량 TRUCK-2");
        expect(context.liveText).toContain("위도 35.10674, 경도 128.94709");
        expect(context.liveText).toContain("속도 32.4 km/h, 진행 방향 118°");
        expect(context.liveText).toContain("최근 60초 속도: 최소 12.0, 평균 27.3, 최대 38.9 km/h");
        expect(context.liveText).toContain("TRUCK-5 43 m");
        expect(context.liveText).toContain("가장 가까운 감지 객체: person 3.4 m (DANGER");
        expect(context.liveText).toContain("피치 2.1°, 롤 -0.4°");
        expect(context.liveText).not.toContain("[가상 시나리오]");
        expect(context.reportFigures).toContain("## 차량 TRUCK-2 현황 보고서");
        expect(context.retrievalQuery).toContain("충돌 방지");
    });

    it("adds scenarios to a real vehicle only when passed", () => {
        const context = realVehicleContext(REAL, NOW.toISOString(), { virtual: { scenarios: [] } });
        expect(context.liveText).toContain("[가상 시나리오] 활성 시나리오 없음");
    });

    it("describes the selected virtual vehicle and adds the scenario on request", () => {
        const vehicleOnly = virtualVehicleContext(VIRTUAL, SCENARIO, NOW.toISOString(), false);
        expect(vehicleOnly.subject).toBe("가상 차량 SIM-1 · 시나리오 도심 통제");
        expect(vehicleOnly.liveText).toContain("속도 배율 2×");
        expect(vehicleOnly.liveText).toContain("경유지 1/2 도달, 현재 경로 1.83 km / 예상 4분, 경로 재계산 2회");
        expect(vehicleOnly.liveText).toContain("SIM-2 1.25 km");
        expect(vehicleOnly.liveText).not.toContain("[가상 시나리오]");
        // The report always includes the vehicle's scenario.
        expect(vehicleOnly.reportFigures).toContain("### 시나리오 '도심 통제' (#7)");

        const withScenario = virtualVehicleContext(VIRTUAL, SCENARIO, NOW.toISOString(), true);
        expect(withScenario.liveText).toContain("[가상 시나리오] '도심 통제'(#7, ACTIVE): 차량 2대");
        expect(withScenario.liveText).toContain("- SIM-2 NO_ROUTE");
    });

    it("reports a selected scenario with its vehicles and restrictions", () => {
        const context = scenarioContext(SCENARIO, NOW.toISOString());
        expect(context.subject).toBe("시나리오 도심 통제");
        expect(context.liveText).toContain("차단 2건, 혼잡 가중 1건 (사유: 공사)");
        expect(context.reportFigures).toContain("- SIM-2 NO_ROUTE (No viable path)");
        expect(context.retrievalQuery).toContain("도로 통제");
    });

    it("detects scenario questions", () => {
        expect(asksAboutScenario("시나리오 상태 알려줘")).toBe(true);
        expect(asksAboutScenario("Scenario status?")).toBe(true);
        expect(asksAboutScenario("이 차량 속도는?")).toBe(false);
        expect(asksAboutScenario(undefined)).toBe(false);
    });

    it("measures distance between points", () => {
        expect(Math.round(haversineM({ lat: 35, lon: 129 }, { lat: 35.001, lon: 129 }))).toBe(111);
    });
});

// Minimal Prisma stand-in that records which collectors ran.
function fakeDb() {
    const calls: string[] = [];
    const db = {
        vehicle: {
            findMany: async () => { calls.push("fleet"); return []; },
            findUnique: async ({ where }: { where: { vehicleId: bigint } }) => {
                calls.push(`vehicle:${where.vehicleId}`);
                if (where.vehicleId === 9n) {
                    return {
                        vehicleCode: "SIM-1", vehicleName: null, vehicleSource: "VIRTUAL",
                        virtualState: {
                            scenarioId: 7n, simStatus: "COMPLETED", speedKmh: 0, speedFactor: 1, blockedReason: null,
                            lastCheckpointAt: NOW, lastPosition: { lat: 35.1, lon: 129 }, routeVersion: 1,
                            trip: { virtualTripId: 22n, state: "COMPLETED", startedAt: NOW, endedAt: NOW, waypoints: [], routes: [], events: [] },
                        },
                    };
                }
                return null;
            },
        },
        $queryRaw: async () => [],
        trip: { findMany: async () => [] },
        virtualScenario: {
            findMany: async () => [],
            findUnique: async ({ where }: { where: { scenarioId: bigint } }) => {
                calls.push(`scenario:${where.scenarioId}`);
                return where.scenarioId === 7n
                    ? { scenarioId: 7n, name: "도심 통제", state: "ACTIVE", vehicleStates: [], restrictions: [], events: [] }
                    : null;
            },
        },
        detectionEvent: { groupBy: async () => [] },
        alert: { count: async () => 0, findMany: async () => [] },
    };
    return { db: db as unknown as PrismaClient, calls };
}

describe("buildAssistantContext scope routing", () => {
    it("uses the fleet snapshot without a scope", async () => {
        const { db } = fakeDb();
        expect((await buildAssistantContext(db, { question: "q" }, NOW)).subject).toBe("전체 현황");
    });

    it("leaves virtual scenarios out of monitoring unless asked", async () => {
        const { db } = fakeDb();
        const plain = await buildAssistantContext(db, { question: "현황", scope: { view: "monitoring" } }, NOW);
        expect(plain.subject).toBe("실차량 전체");
        expect(plain.liveText).not.toContain("[가상 시나리오]");
        const asked = await buildAssistantContext(db, { question: "시나리오 상태는?", scope: { view: "monitoring" } }, NOW);
        expect(asked.liveText).toContain("[가상 시나리오]");
    });

    it("falls back to the real fleet when the selected vehicle is gone", async () => {
        const { db } = fakeDb();
        const context = await buildAssistantContext(db, { question: "q", scope: { view: "monitoring", vehicleId: "404" } }, NOW);
        expect(context.subject).toBe("실차량 전체");
        expect(context.liveText).toContain("선택한 차량을 찾을 수 없어");
    });

    it("scopes virtual mode to the scenario and selected vehicle", async () => {
        const { db, calls } = fakeDb();
        const scenario = await buildAssistantContext(db, { question: "q", scope: { view: "virtual", scenarioId: "7" } }, NOW);
        expect(scenario.subject).toBe("시나리오 도심 통제");
        const vehicle = await buildAssistantContext(db, { question: "q", scope: { view: "virtual", scenarioId: "7", vehicleId: "9" } }, NOW);
        expect(vehicle.subject).toBe("가상 차량 SIM-1 · 시나리오 도심 통제");
        expect(vehicle.liveText).toContain("상태 COMPLETED");
        expect(calls).toContain("vehicle:9");
    });

    it("lists all active scenarios in virtual mode without a selection", async () => {
        const { db } = fakeDb();
        const context = await buildAssistantContext(db, { question: "q", scope: { view: "virtual" } }, NOW);
        expect(context.subject).toBe("가상 시나리오 전체");
        expect(context.liveText).toContain("[가상 시나리오] 활성 시나리오 없음");
        expect(context.liveText).not.toContain("[실차량]");
    });
});
