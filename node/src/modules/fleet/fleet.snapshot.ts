// Read-only fleet snapshot for the operator assistant and GET /fleet/summary.
//
// Only reads: GET /tracking/vehicles is deliberately not reused because it
// upserts BIMS vehicles and persists history on every call. The renderers
// below are pure functions over the snapshot so they can be tested without a
// database, and every list is capped so the text fits the assistant LLM's
// context (EXAONE4.5, 8k tokens shared with guide evidence and the answer).
import type { PrismaClient } from "../../generated/prisma/client.ts";

export const STALE_FIX_SECONDS = 120;
export const VISION_WINDOW_MINUTES = 30;
export const EVENT_WINDOW_MINUTES = 30;
const MAX_LISTED = 8;
export const MAX_SNAPSHOT_TEXT_CHARS = 2500;
const ACTIVE_TRIP_STATES = ["READY", "IN_PROGRESS", "PAUSED"];
const VIRTUAL_PROBLEM_STATES = ["NO_ROUTE", "BLOCKED_AWAITING_OPERATOR"];

export type CountMap = Record<string, number>;

// Which parts of the snapshot a rendering covers; the assistant narrows it
// to what the operator is looking at (monitoring vs. virtual mode).
export type SnapshotSections = { real: boolean; virtual: boolean; vision: boolean };
export const ALL_SECTIONS: SnapshotSections = { real: true, virtual: true, vision: true };

export type RealVehicleNote = {
    vehicleCode: string;
    source: string;
    status: string;
    lastFixAgeSeconds: number | null;
    speedKmh: number | null;
    tripDestination: string | null;
    reason: "STALE_POSITION" | "NO_POSITION";
};

export type VirtualScenarioSummary = {
    scenarioId: string;
    name: string;
    vehicles: number;
    byStatus: CountMap;
    restrictions: { blocked: number; penalty: number };
    recentEvents: CountMap;
    problemVehicles: Array<{ vehicleCode: string; simStatus: string; blockedReason: string | null }>;
};

export type ReportingVehicle = { vehicleCode: string; speedKmh: number | null; lastFixAgeSeconds: number; tripDestination: string | null };

export type AlertNote = { alertType: string; severity: string; vehicleCode: string; message: string | null; createdAt: string };

export type FleetSnapshot = {
    generatedAt: string;
    realVehicles: {
        total: number;
        bySource: CountMap;
        byStatus: CountMap;
        reporting: number;
        stale: number;
        noPosition: number;
        activeTrips: number;
        notable: RealVehicleNote[];
        // Vehicles with a fresh fix, fastest first, so per-vehicle speed
        // questions can be answered without a selection.
        reportingVehicles: ReportingVehicle[];
    };
    virtual: { scenarios: VirtualScenarioSummary[] };
    vision: {
        windowMinutes: number;
        detections: number;
        byRisk: CountMap;
        topClasses: Array<{ className: string; count: number }>;
        unconfirmedAlerts: number;
        recentAlerts: AlertNote[];
    };
};

function count<T>(items: T[], key: (item: T) => string): CountMap {
    const result: CountMap = {};
    for (const item of items) {
        const name = key(item);
        result[name] = (result[name] ?? 0) + 1;
    }
    return result;
}

export async function collectFleetSnapshot(db: PrismaClient, now = new Date()): Promise<FleetSnapshot> {
    const visionSince = new Date(now.getTime() - VISION_WINDOW_MINUTES * 60_000);
    const eventsSince = new Date(now.getTime() - EVENT_WINDOW_MINUTES * 60_000);

    const [vehicles, latestFixes, trips, scenarios, detectionsByRisk, detectionsByClass, unconfirmedAlerts, recentAlerts] = await Promise.all([
        db.vehicle.findMany({
            where: { isActive: true, vehicleSource: { not: "VIRTUAL" } },
            select: { vehicleId: true, vehicleCode: true, vehicleSource: true, vehicleStatus: true },
        }),
        // Latest fix per real vehicle; LATERAL uses idx_vehicle_position_vehicle_time.
        db.$queryRaw<Array<{ vehicle_id: bigint; recorded_at: Date | null; speed_kmh: unknown }>>`
            SELECT v.vehicle_id, p.recorded_at, p.speed_kmh
            FROM vehicle v
            LEFT JOIN LATERAL (
                SELECT recorded_at, speed_kmh FROM vehicle_position vp
                WHERE vp.vehicle_id = v.vehicle_id
                ORDER BY recorded_at DESC LIMIT 1
            ) p ON true
            WHERE v.is_active AND v.vehicle_source <> 'VIRTUAL'`,
        db.trip.findMany({
            where: { tripStatus: { in: ACTIVE_TRIP_STATES }, vehicle: { vehicleSource: { not: "VIRTUAL" } } },
            select: { vehicleId: true, destinationName: true },
        }),
        db.virtualScenario.findMany({
            where: { state: "ACTIVE" },
            orderBy: { scenarioId: "asc" },
            select: {
                scenarioId: true,
                name: true,
                vehicleStates: { select: { simStatus: true, blockedReason: true, vehicle: { select: { vehicleCode: true } } } },
                restrictions: { where: { isActive: true }, select: { kind: true } },
                events: { where: { createdAt: { gte: eventsSince } }, select: { eventType: true } },
            },
        }),
        db.detectionEvent.groupBy({ by: ["riskLevel"], where: { detectedAt: { gte: visionSince } }, _count: { _all: true } }),
        db.detectionEvent.groupBy({
            by: ["className"], where: { detectedAt: { gte: visionSince } }, _count: { _all: true },
            orderBy: { _count: { className: "desc" } }, take: 5,
        }),
        db.alert.count({ where: { alertStatus: "UNCONFIRMED" } }),
        db.alert.findMany({
            where: { createdAt: { gte: visionSince } }, orderBy: { createdAt: "desc" }, take: 5,
            select: { alertType: true, severity: true, alertMessage: true, createdAt: true, vehicle: { select: { vehicleCode: true } } },
        }),
    ]);

    const fixByVehicle = new Map(latestFixes.map((fix) => [fix.vehicle_id.toString(), fix]));
    const tripByVehicle = new Map(trips.map((trip) => [trip.vehicleId.toString(), trip]));
    let reporting = 0, stale = 0, noPosition = 0;
    const notable: RealVehicleNote[] = [];
    const reportingVehicles: ReportingVehicle[] = [];
    for (const vehicle of vehicles) {
        const fix = fixByVehicle.get(vehicle.vehicleId.toString());
        const ageSeconds = fix?.recorded_at ? Math.max(0, Math.round((now.getTime() - fix.recorded_at.getTime()) / 1000)) : null;
        const speed = fix?.speed_kmh == null ? null : Number(fix.speed_kmh);
        const reason = ageSeconds === null ? "NO_POSITION" : ageSeconds > STALE_FIX_SECONDS ? "STALE_POSITION" : null;
        if (reason === null) {
            reporting += 1;
            reportingVehicles.push({
                vehicleCode: vehicle.vehicleCode, speedKmh: Number.isFinite(speed) ? speed : null, lastFixAgeSeconds: ageSeconds!,
                tripDestination: tripByVehicle.get(vehicle.vehicleId.toString())?.destinationName ?? null,
            });
        }
        else if (reason === "NO_POSITION") noPosition += 1;
        else stale += 1;
        // Only vehicles that are supposed to be moving are worth flagging.
        const expectedToReport = vehicle.vehicleStatus === "DRIVING" || tripByVehicle.has(vehicle.vehicleId.toString());
        if (reason && expectedToReport) {
            notable.push({
                vehicleCode: vehicle.vehicleCode, source: vehicle.vehicleSource, status: vehicle.vehicleStatus,
                lastFixAgeSeconds: ageSeconds, speedKmh: Number.isFinite(speed) ? speed : null,
                tripDestination: tripByVehicle.get(vehicle.vehicleId.toString())?.destinationName ?? null, reason,
            });
        }
    }
    notable.sort((a, b) => (b.lastFixAgeSeconds ?? Infinity) - (a.lastFixAgeSeconds ?? Infinity));
    reportingVehicles.sort((a, b) => (b.speedKmh ?? -1) - (a.speedKmh ?? -1));

    return {
        generatedAt: now.toISOString(),
        realVehicles: {
            total: vehicles.length,
            bySource: count(vehicles, (vehicle) => vehicle.vehicleSource),
            byStatus: count(vehicles, (vehicle) => vehicle.vehicleStatus),
            reporting, stale, noPosition,
            activeTrips: trips.length,
            notable: notable.slice(0, MAX_LISTED),
            reportingVehicles: reportingVehicles.slice(0, MAX_LISTED),
        },
        virtual: {
            scenarios: scenarios.map((scenario) => ({
                scenarioId: scenario.scenarioId.toString(),
                name: scenario.name,
                vehicles: scenario.vehicleStates.length,
                byStatus: count(scenario.vehicleStates, (state) => state.simStatus),
                restrictions: {
                    blocked: scenario.restrictions.filter((restriction) => restriction.kind === "BLOCKED").length,
                    penalty: scenario.restrictions.filter((restriction) => restriction.kind !== "BLOCKED").length,
                },
                recentEvents: count(scenario.events, (event) => event.eventType),
                problemVehicles: scenario.vehicleStates
                    .filter((state) => VIRTUAL_PROBLEM_STATES.includes(state.simStatus))
                    .slice(0, MAX_LISTED)
                    .map((state) => ({ vehicleCode: state.vehicle.vehicleCode, simStatus: state.simStatus, blockedReason: state.blockedReason })),
            })).slice(0, MAX_LISTED),
        },
        vision: {
            windowMinutes: VISION_WINDOW_MINUTES,
            detections: detectionsByRisk.reduce((sum, row) => sum + row._count._all, 0),
            byRisk: Object.fromEntries(detectionsByRisk.map((row) => [row.riskLevel, row._count._all])),
            topClasses: detectionsByClass.map((row) => ({ className: row.className, count: row._count._all })),
            unconfirmedAlerts,
            recentAlerts: recentAlerts.map((alert) => ({
                alertType: alert.alertType, severity: alert.severity, vehicleCode: alert.vehicle.vehicleCode,
                message: alert.alertMessage, createdAt: alert.createdAt.toISOString(),
            })),
        },
    };
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

const kstFormat = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
});

export function formatKst(iso: string): string {
    return `${kstFormat.format(new Date(iso))} (KST)`;
}

export function formatCounts(counts: CountMap): string {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return entries.length ? entries.map(([name, value]) => `${name} ${value}`).join(", ") : "없음";
}

export function formatAge(seconds: number | null): string {
    if (seconds === null) return "위치 기록 없음";
    if (seconds < 120) return `마지막 위치 ${seconds}초 전`;
    if (seconds < 7200) return `마지막 위치 ${Math.round(seconds / 60)}분 전`;
    return `마지막 위치 ${Math.round(seconds / 3600)}시간 전`;
}

// Compact Korean text handed to the assistant LLM as the only source of
// fleet facts. Capped at MAX_SNAPSHOT_TEXT_CHARS.
export function renderSnapshotText(snapshot: FleetSnapshot, sections: SnapshotSections = ALL_SECTIONS): string {
    const lines = [`[기준 시각] ${formatKst(snapshot.generatedAt)}`];
    if (sections.real) lines.push(...renderRealLines(snapshot));
    if (sections.virtual) lines.push(...renderVirtualLines(snapshot));
    if (sections.vision) lines.push(...renderVisionLines(snapshot));
    return capText(lines.join("\n"));
}

export function capText(text: string): string {
    return text.length <= MAX_SNAPSHOT_TEXT_CHARS ? text : `${text.slice(0, MAX_SNAPSHOT_TEXT_CHARS - 20)}\n… (이하 생략)`;
}

function renderRealLines(snapshot: FleetSnapshot): string[] {
    const real = snapshot.realVehicles;
    const lines = [
        `[실차량] 활성 ${real.total}대 (출처: ${formatCounts(real.bySource)}) / 상태: ${formatCounts(real.byStatus)}`,
        `  위치 수신: 정상 ${real.reporting}대, 지연(${STALE_FIX_SECONDS / 60}분 초과) ${real.stale}대, 기록 없음 ${real.noPosition}대 / 진행 중 운행 ${real.activeTrips}건`,
    ];
    if (real.reportingVehicles.length) {
        lines.push(`  위치 수신 중 차량(속도 순, 최대 ${MAX_LISTED}대):`);
        for (const vehicle of real.reportingVehicles) {
            const speed = vehicle.speedKmh === null ? "속도 미상" : `${vehicle.speedKmh.toFixed(1)} km/h`;
            lines.push(`  - ${vehicle.vehicleCode} ${speed}, ${formatAge(vehicle.lastFixAgeSeconds)}${vehicle.tripDestination ? `, 목적지 ${vehicle.tripDestination}` : ""}`);
        }
    }
    if (real.notable.length) {
        lines.push("  주의 차량(운행 중인데 위치 지연·없음):");
        for (const note of real.notable) {
            const trip = note.tripDestination ? `, 목적지 ${note.tripDestination}` : "";
            lines.push(`  - ${note.vehicleCode} (${note.source}, ${note.status}${trip}) ${formatAge(note.lastFixAgeSeconds)}`);
        }
    }
    return lines;
}

export function renderVirtualLines(snapshot: Pick<FleetSnapshot, "virtual">): string[] {
    const lines: string[] = [];
    if (!snapshot.virtual.scenarios.length) lines.push("[가상 시나리오] 활성 시나리오 없음");
    for (const scenario of snapshot.virtual.scenarios) {
        lines.push(`[가상 시나리오] '${scenario.name}'(#${scenario.scenarioId}): 차량 ${scenario.vehicles}대 (${formatCounts(scenario.byStatus)}), 도로 통제: 차단 ${scenario.restrictions.blocked}건, 혼잡 가중 ${scenario.restrictions.penalty}건`);
        for (const vehicle of scenario.problemVehicles) {
            lines.push(`  - ${vehicle.vehicleCode} ${vehicle.simStatus}${vehicle.blockedReason ? ` (${vehicle.blockedReason})` : ""}`);
        }
        if (Object.keys(scenario.recentEvents).length) {
            lines.push(`  최근 ${EVENT_WINDOW_MINUTES}분 이벤트: ${formatCounts(scenario.recentEvents)}`);
        }
    }
    return lines;
}

function renderVisionLines(snapshot: FleetSnapshot): string[] {
    const vision = snapshot.vision;
    const lines: string[] = [];
    lines.push(`[영상 감지 최근 ${vision.windowMinutes}분] 감지 ${vision.detections}건 (위험도: ${formatCounts(vision.byRisk)}), 주요 객체: ${vision.topClasses.length ? vision.topClasses.map((item) => `${item.className} ${item.count}`).join(", ") : "없음"}`);
    lines.push(`  미확인 경보 ${vision.unconfirmedAlerts}건`);
    for (const alert of vision.recentAlerts) {
        lines.push(`  - ${formatKst(alert.createdAt)} ${alert.alertType} ${alert.severity} ${alert.vehicleCode}${alert.message ? `: ${alert.message}` : ""}`);
    }
    return lines;
}

// Report figures rendered from data, never by the LLM, so the numbers in a
// report are always the snapshot's.
export function renderReportFigures(snapshot: FleetSnapshot, include: SnapshotSections = ALL_SECTIONS, title = "차량 현황 보고서"): string {
    const real = snapshot.realVehicles;
    const vision = snapshot.vision;
    const sections = [`## ${title}\n기준 시각: ${formatKst(snapshot.generatedAt)}`];
    if (include.real) sections.push(
        [
            "### 실차량",
            "| 항목 | 값 |", "|---|---|",
            `| 활성 차량 | ${real.total}대 |`,
            `| 출처별 | ${formatCounts(real.bySource)} |`,
            `| 상태별 | ${formatCounts(real.byStatus)} |`,
            `| 위치 수신 정상 / 지연 / 없음 | ${real.reporting} / ${real.stale} / ${real.noPosition} |`,
            `| 진행 중 운행 | ${real.activeTrips}건 |`,
            ...(real.notable.length ? ["", "주의 차량:", ...real.notable.map((note) => `- ${note.vehicleCode} (${note.status}) ${formatAge(note.lastFixAgeSeconds)}${note.tripDestination ? `, 목적지 ${note.tripDestination}` : ""}`)] : []),
        ].join("\n"));
    if (include.virtual) sections.push(renderScenarioTable(snapshot));
    if (include.vision) sections.push(
        [
            `### 영상 감지·경보 (최근 ${vision.windowMinutes}분)`,
            "| 항목 | 값 |", "|---|---|",
            `| 감지 | ${vision.detections}건 |`,
            `| 위험도별 | ${formatCounts(vision.byRisk)} |`,
            `| 주요 객체 | ${vision.topClasses.length ? vision.topClasses.map((item) => `${item.className} ${item.count}`).join(", ") : "없음"} |`,
            `| 미확인 경보 | ${vision.unconfirmedAlerts}건 |`,
        ].join("\n"));
    return sections.join("\n\n");
}

export function renderScenarioTable(snapshot: Pick<FleetSnapshot, "virtual">): string {
    return [
        "### 가상 시나리오",
        ...(snapshot.virtual.scenarios.length ? [
            "| 시나리오 | 차량 | 상태 | 차단 / 혼잡 가중 |", "|---|---|---|---|",
            ...snapshot.virtual.scenarios.map((scenario) => `| ${scenario.name} (#${scenario.scenarioId}) | ${scenario.vehicles}대 | ${formatCounts(scenario.byStatus)} | ${scenario.restrictions.blocked} / ${scenario.restrictions.penalty} |`),
            ...snapshot.virtual.scenarios.flatMap((scenario) => scenario.problemVehicles.map((vehicle) => `- ${scenario.name}: ${vehicle.vehicleCode} ${vehicle.simStatus}${vehicle.blockedReason ? ` (${vehicle.blockedReason})` : ""}`)),
        ] : ["활성 시나리오 없음"]),
    ].join("\n");
}

// Retrieval query for report mode: the generic request text would retrieve
// nothing specific, so steer it toward the guides relevant to current issues.
export function reportRetrievalQuery(snapshot: FleetSnapshot, include: SnapshotSections = ALL_SECTIONS): string {
    const topics = ["작업장 내 운반차량 운행 안전 수칙"];
    const virtualProblems = include.virtual && snapshot.virtual.scenarios.some((scenario) => scenario.problemVehicles.length || scenario.restrictions.blocked);
    if (virtualProblems) topics.push("도로 통제 시 차량 우회 운행 및 정차 안전");
    if (include.real && (snapshot.realVehicles.stale || snapshot.realVehicles.noPosition)) topics.push("운행 차량 관리 감독 및 연락 체계");
    if (include.vision && ((snapshot.vision.byRisk.DANGER ?? 0) > 0 || snapshot.vision.unconfirmedAlerts > 0)) topics.push("보행자 및 근로자 충돌 방지 접근 경보");
    return topics.join(", ");
}
