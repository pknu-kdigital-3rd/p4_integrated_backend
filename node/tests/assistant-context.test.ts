import { describe, expect, it, vi } from "vitest";
vi.mock("../src/modules/tracking/tracking.client.ts", () => ({ trackingClient: { vehicle: async () => null } }));

import type { PrismaClient } from "../src/generated/prisma/client.ts";
import {
    asksAboutScenario,
    buildAssistantContext,
    collectRealVehicleDetail,
    haversineM,
    mentionedVehicleId,
    realVehicleContext,
    scenarioContext,
    virtualVehicleContext,
    type RealVehicleDetail,
    type ScenarioDetail,
    type VirtualVehicleDetail,
} from "../src/modules/assistant/assistant.context.ts";
import { assistantChatSchema } from "../src/modules/assistant/assistant.schema.ts";
import { displayVehicleStatus } from "../src/modules/fleet/fleet.labels.ts";

const NOW = new Date("2026-10-02T01:00:00Z"); // 10:00 KST

const REAL: RealVehicleDetail = {
    vehicleCode: "TRUCK-2", vehicleName: "2호 운반차", source: "CUSTOM", status: "DRIVING",
    fix: { recordedAt: "2026-10-02T00:59:57Z", ageSeconds: 3, lat: 35.10674, lon: 128.94709, speedKmh: 32.4, headingDeg: 118, accuracyM: 4.2, telemetrySource: "DEVICE_GPS" },
    recentSpeed: { samples: 60, minKmh: 12, avgKmh: 27.3, maxKmh: 38.9 },
    trip: { tripId: "41", status: "IN_PROGRESS", originName: "1부두", destinationName: "부산신항", destination: { lat: 35.07778, lon: 128.83333 }, remaining: { distanceM: 8300, durationSec: 840, basis: "ROUTE" }, startedAt: "2026-10-02T00:40:00Z" },
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

describe("question vehicle mentions", () => {
    it.each(["9호 속도는?", "화물차 9호 상태", "화물차9호는?", "009 호 위치"])("extracts the vehicle id from %s", (question) => {
        expect(mentionedVehicleId(question)).toBe("9");
    });

    it.each([undefined, "현재 속도는?", "모든 차량 상태", "모든 화물차와 9호 상태", "모든 운행 중인 트럭 상태", "모든 차량과 화물차 9호", "0호", "1.9호", "9호선"])("keeps the selected target for %s", (question) => {
        expect(mentionedVehicleId(question)).toBeUndefined();
    });

    it("preserves large vehicle ids without number rounding", () => {
        expect(mentionedVehicleId("화물차 9007199254740993호")).toBe("9007199254740993");
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
        expect(context.liveText).toContain("가장 가까운 감지 객체: 보행자 3.4 m (위험");
        expect(context.liveText).toContain("피치 2.1°, 롤 -0.4°");
        expect(context.liveText).not.toContain("[가상 시나리오]");
        expect(context.reportFigures).toContain("## TRUCK-2 현황 보고서");
        expect(context.liveText).not.toContain("2호 운반차");
        expect(context.liveText).toContain("목적지 좌표: 위도 35.07778, 경도 128.83333");
        expect(context.reportFigures).toContain("| 목적지 좌표 | 35.07778, 128.83333 |");
        expect(context.liveText).toContain("목적지까지: 남은 거리 8.3 km, 남은 시간 약 14분 (계획 경로 기준)");
        expect(context.reportFigures).toContain("| 목적지까지 남은 거리 / 시간 | 남은 거리 8.3 km, 남은 시간 약 14분 (계획 경로 기준) |");
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
        expect(withScenario.liveText).toContain("[가상 시나리오] '도심 통제'(#7, 진행 중): 차량 2대");
        expect(withScenario.liveText).toContain("- SIM-2 경로 없음");
    });

    it("reports a selected scenario with its vehicles and restrictions", () => {
        const context = scenarioContext(SCENARIO, NOW.toISOString());
        expect(context.subject).toBe("시나리오 도심 통제");
        expect(context.liveText).toContain("차단 2건, 혼잡 가중 1건 (사유: 공사)");
        expect(context.reportFigures).toContain("- SIM-2 경로 없음 (No viable path)");
        expect(context.retrievalQuery).toContain("도로 통제");
    });

    it("names every status in Korean so the model does not translate codes", () => {
        const ready = { ...REAL, status: "READY", trip: { ...REAL.trip!, status: "READY" } };
        const text = realVehicleContext(ready, NOW.toISOString(), null).liveText;
        expect(text).toContain("상태 대기");
        expect(text).toContain("운행 #41 출발 대기");
        expect(text).toContain("단말 GPS, 정확도");
        expect(text).toContain("객체 근접 심각");
        const blocked = { ...VIRTUAL, state: { ...VIRTUAL.state!, simStatus: "BLOCKED_AWAITING_OPERATOR", blockedReason: "Blocked road ahead" } };
        const virtualText = virtualVehicleContext(blocked, SCENARIO, NOW.toISOString(), false).liveText;
        expect(virtualText).toContain("상태 통제 구간 앞 정지, 관제 조치 대기 (앞쪽 도로가 통제됨)");
        expect(virtualText).toContain("경로 재계산 2");
        expect(text).not.toMatch(/READY|DEVICE_GPS|CRITICAL/);
        // STOPPED shows as 대기 on the map; the assistant must say the same.
        expect(realVehicleContext({ ...REAL, status: displayVehicleStatus("STOPPED", null) }, NOW.toISOString(), null).liveText).toContain("상태 대기");
        expect(displayVehicleStatus("READY", "IN_PROGRESS")).toBe("운행중");
        expect(text).toContain("대기=운행 가능하며 배정을 기다리는 차량으로 정지·고장이 아님");
        // Unknown codes pass through unchanged.
        expect(realVehicleContext({ ...REAL, status: "SOMETHING_NEW" }, NOW.toISOString(), null).liveText).toContain("상태 SOMETHING_NEW");
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
                if (where.vehicleId === 2n) return { vehicleCode: "TRUCK-2", vehicleName: null, vehicleSource: "CUSTOM", vehicleStatus: "READY" };
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
        trip: { findMany: async () => [], findFirst: async () => null },
        virtualScenario: {
            findMany: async () => [],
            findUnique: async ({ where }: { where: { scenarioId: bigint } }) => {
                calls.push(`scenario:${where.scenarioId}`);
                return where.scenarioId === 7n
                    ? { scenarioId: 7n, name: "도심 통제", state: "ACTIVE", vehicleStates: [], restrictions: [], events: [] }
                    : null;
            },
        },
        detectionEvent: { groupBy: async () => [], findFirst: async () => null },
        alert: { count: async () => 0, findMany: async () => [] },
    };
    return { db: db as unknown as PrismaClient, calls };
}

describe("buildAssistantContext scope routing", () => {
    it("keeps live 80 km/h separate from stale 0.5 km/h history", async () => {
        const { db } = fakeDb();
        const rows = [
            [{ recorded_at: new Date("2026-08-27T05:56:10.772Z"), received_at: new Date("2026-10-01T00:00:00Z"),
                recording_session_id: "previous", lat: 35, lon: 129, speed_kmh: 0.5, heading_deg: null,
                horizontal_accuracy_m: 2, telemetry_source: "RECORDED_GPS" }],
            [{ recording_session_id: "previous", samples: 10n, min_kmh: 0.5, avg_kmh: 0.5, max_kmh: 0.5 }], [],
        ];
        vi.spyOn(db, "$queryRaw").mockImplementation(async () => rows.shift() as never);
        const detail = await collectRealVehicleDetail(db, 2n, NOW, async () => ({
            external_id: "device:2", latitude: 35.2, longitude: 129.2, speed_kmh: 80, heading_deg: 90,
            telemetry_source: "RECORDED_GPS", observed_at_utc: "2026-08-27T06:00:00Z", route_progress_pct: null,
            source_metadata: { receivedAt: "2026-10-02T00:59:59Z", recordingSessionId: "current" },
        }));
        expect(detail?.fix?.speedKmh).toBe(80);
        expect(detail?.recentSpeed).toBeNull();
        const context = realVehicleContext(detail!, NOW.toISOString(), null);
        expect(context.liveText).toContain("속도 80.0 km/h");
        expect(context.liveText).not.toContain("녹화 GPS 재생");
        expect(context.liveText).not.toContain("녹화");
        expect(context.reportFigures).not.toContain("녹화");
        expect(context.liveText).not.toContain("0.5 km/h");
        expect(context.liveText).not.toContain("위치 수신 지연");
    });

    it("takes the speed window up to now from the live session only", async () => {
        const { db } = fakeDb();
        const queries: string[] = [];
        const rows = [
            [],
            [{ recording_session_id: "previous", samples: 5n, min_kmh: 0.5, avg_kmh: 0.5, max_kmh: 0.5 },
                { recording_session_id: "current", samples: 20n, min_kmh: 76, avg_kmh: 79.5, max_kmh: 82 }], [],
        ];
        vi.spyOn(db, "$queryRaw").mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
            queries.push(strings.join("?"));
            if (queries.length === 2) expect(values).toContainEqual(new Date(NOW.getTime() - 60_000));
            return rows.shift();
        }) as never);
        const detail = await collectRealVehicleDetail(db, 2n, NOW, async () => ({
            external_id: "device:2", latitude: 35.2, longitude: 129.2, speed_kmh: 80, heading_deg: 90,
            telemetry_source: "RECORDED_GPS", observed_at_utc: "2026-08-27T06:00:00Z", route_progress_pct: null,
            source_metadata: { receivedAt: "2026-10-02T00:59:59Z", recordingSessionId: "current" },
        }));
        expect(queries[1]).toContain("received_at >= ?");
        expect(detail?.recentSpeed).toEqual({ samples: 20, minKmh: 76, avgKmh: 79.5, maxKmh: 82 });
    });

    it("does not send stale speed as a current speed when tracking is unavailable", async () => {
        const stale = { ...REAL, fix: { ...REAL.fix!, speedKmh: 0.5, ageSeconds: 3600 } };
        const context = realVehicleContext(stale, NOW.toISOString(), null);
        expect(context.liveText).toContain("현재 속도: 확인 불가");
        expect(context.liveText).not.toContain("0.5 km/h");
        expect(context.liveText).not.toContain("최근 60초 속도");
        expect(context.reportFigures).toContain("확인 불가 (최신 GPS 수신 없음)");
    });

    it("uses the current replay fix even when replaying an old recording without a trip", async () => {
        const { db } = fakeDb();
        const detail = await collectRealVehicleDetail(db, 2n, NOW, async (externalId) => {
            expect(externalId).toBe("device:2");
            return { external_id: externalId, latitude: 35.2, longitude: 129.2, speed_kmh: 42.5, heading_deg: 90,
                telemetry_source: "RECORDED_GPS", observed_at_utc: "2026-08-27T05:56:10.772Z", route_progress_pct: null,
                source_metadata: { receivedAt: "2026-10-02T00:59:59Z", recordingSessionId: "current" } };
        });
        expect(detail?.fix).toMatchObject({ speedKmh: 42.5, ageSeconds: 1, recordedAt: "2026-08-27T05:56:10.772Z" });
        expect(detail?.trip).toBeNull();
        const context = realVehicleContext(detail!, NOW.toISOString(), null);
        expect(context.liveText).toContain("속도 42.5 km/h");
        expect(context.liveText).not.toContain("위치 수신 지연");
    });
    it("defaults to the selected real vehicle when no target is mentioned", async () => {
        const { db, calls } = fakeDb();
        const context = await buildAssistantContext(db, { question: "현재 상태는?", scope: { view: "monitoring", vehicleId: "2" } }, NOW);
        expect(context.subject).toBe("실차량 화물차 2호");
        expect(calls).toEqual(["vehicle:2"]);
    });

    it("switches from a virtual selection to the explicitly mentioned real vehicle", async () => {
        const { db, calls } = fakeDb();
        const context = await buildAssistantContext(db, { question: "2호 상태", scope: { view: "virtual", scenarioId: "7", vehicleId: "9" } }, NOW);
        expect(context.subject).toBe("실차량 화물차 2호");
        expect(calls).not.toContain("vehicle:9");
    });

    it("overrides the selected target with a numbered vehicle and collects its context", async () => {
        const { db, calls } = fakeDb();
        const context = await buildAssistantContext(db, { question: "화물차 9호 상태", scope: { view: "virtual", scenarioId: "7", vehicleId: "404" } }, NOW);
        expect(context.subject).toBe("가상 차량 화물차 9호 · 시나리오 도심 통제");
        expect(context.liveText).toContain("상태 도착 완료");
        expect(calls).not.toContain("vehicle:404");
    });

    it("resolves a numbered virtual vehicle even outside virtual mode", async () => {
        const { db } = fakeDb();
        const context = await buildAssistantContext(db, { question: "9호 상태", scope: { view: "monitoring", vehicleId: "404" } }, NOW);
        expect(context.subject).toBe("가상 차량 화물차 9호 · 시나리오 도심 통제");
    });

    it("keeps the current target for all-vehicle wording", async () => {
        const { db, calls } = fakeDb();
        const context = await buildAssistantContext(db, { question: "모든 화물차와 404호 상태", scope: { view: "virtual", scenarioId: "7", vehicleId: "9" } }, NOW);
        expect(context.subject).toBe("가상 차량 화물차 9호 · 시나리오 도심 통제");
        expect(calls.filter((call) => call.startsWith("vehicle:"))).toEqual(["vehicle:9"]);
    });

    it("reports a missing numbered target instead of answering about another vehicle", async () => {
        const { db } = fakeDb();
        await expect(buildAssistantContext(db, { question: "404호 상태", scope: { view: "virtual", scenarioId: "7", vehicleId: "9" } }, NOW))
            .rejects.toMatchObject({ code: "VEHICLE_NOT_FOUND" });
    });

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
        expect(vehicle.subject).toBe("가상 차량 화물차 9호 · 시나리오 도심 통제");
        expect(vehicle.liveText).toContain("상태 도착 완료");
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
