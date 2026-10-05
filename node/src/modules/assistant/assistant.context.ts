// Assistant context scoped to what the operator is looking at.
//
// The panel sends its current selection: in monitoring mode the selected
// real vehicle, in virtual mode the selected scenario and virtual vehicle.
// The live text handed to the LLM then describes that subject in detail
// (position, speed, trip, nearby vehicles, detections, alerts) instead of
// only fleet-wide counts. A scenario summary is added whenever the question
// asks about the scenario, and a request without a scope gets the
// fleet-wide snapshot as before.
//
// Collectors only read. Renderers are pure so they can be tested without a
// database.
import type { PrismaClient } from "../../generated/prisma/client.ts";
import {
    ALL_SECTIONS,
    EVENT_WINDOW_MINUTES,
    STALE_FIX_SECONDS,
    VISION_WINDOW_MINUTES,
    capText,
    collectFleetSnapshot,
    formatAge,
    formatCounts,
    formatKst,
    renderReportFigures,
    renderScenarioTable,
    renderSnapshotText,
    renderVirtualLines,
    reportRetrievalQuery,
    vehicleDisplayName,
    type AlertNote,
    type CountMap,
    type FleetSnapshot,
    type SnapshotSections,
} from "../fleet/fleet.snapshot.ts";
import {
    ALERT_TYPE_LABELS,
    EVENT_TYPE_LABELS,
    OBJECT_CLASS_LABELS,
    RISK_LABELS,
    SCENARIO_STATE_LABELS,
    SEVERITY_LABELS,
    SIM_STATUS_LABELS,
    TELEMETRY_SOURCE_LABELS,
    TRIP_STATUS_LABELS,
    VEHICLE_SOURCE_LABELS,
    VEHICLE_STATUS_GLOSSARY,
    VEHICLE_STATUS_LABELS,
    displayVehicleStatus,
    label,
    reasonText,
} from "../fleet/fleet.labels.ts";
import type { AssistantChatBody, AssistantScope } from "./assistant.schema.ts";
import { AppError } from "../../common/errors/app-error.ts";
import { trackingClient, type TrackingSnapshot } from "../tracking/tracking.client.ts";
import { logger } from "../../config/logger.ts";
import { replayRemaining, routeRemaining, type TripRemaining } from "./trip.progress.ts";
import { routingInternalClient } from "../virtual/routing-internal.client.ts";

const ACTIVE_TRIP_STATES = ["READY", "IN_PROGRESS", "PAUSED"];
const MOVING_SIM_STATES = ["DRIVING", "PAUSED", "REROUTING", "BLOCKED_AWAITING_OPERATOR", "NO_ROUTE"];
const SPEED_WINDOW_SECONDS = 60;
const NEARBY_LIMIT = 3;
const MAX_SCENARIO_VEHICLES = 12;
const LAST_EVENTS = 5;

export type AssistantContext = {
    generatedAt: string;
    // Short Korean label of what the answer is about, shown in the panel.
    subject: string;
    liveText: string;
    reportFigures: string;
    retrievalQuery: string;
};

export type NearbyVehicle = { vehicleCode: string; distanceM: number; speedKmh: number | null; ageSeconds: number | null };
export type EventNote = { eventType: string; createdAt: string };

export type RealVehicleDetail = {
    vehicleCode: string;
    vehicleName: string | null;
    source: string;
    status: string;
    fix: {
        recordedAt: string; receivedAt?: string; ageSeconds: number; lat: number; lon: number;
        speedKmh: number | null; headingDeg: number | null; accuracyM: number | null; telemetrySource: string;
    } | null;
    recentSpeed: { samples: number; minKmh: number; avgKmh: number; maxKmh: number } | null;
    trip: { tripId: string; status: string; originName: string | null; destinationName: string; destination: { lat: number; lon: number } | null; remaining?: TripRemaining | null; startedAt: string | null } | null;
    nearby: NearbyVehicle[];
    detections: {
        total: number;
        byRisk: CountMap;
        topClasses: Array<{ className: string; count: number }>;
        nearest: { className: string; distanceM: number; riskLevel: string; detectedAt: string } | null;
        attitude: { pitchDeg: number | null; rollDeg: number | null; detectedAt: string } | null;
    };
    alerts: { unconfirmed: number; recent: AlertNote[] };
};

export type VirtualVehicleDetail = {
    vehicleCode: string;
    vehicleName: string | null;
    state: {
        simStatus: string; speedKmh: number | null; speedFactor: number; blockedReason: string | null;
        lastCheckpointAt: string; position: { lat: number; lon: number } | null; routeVersion: number;
    } | null;
    trip: {
        tripId: string; state: string; startedAt: string; endedAt: string | null;
        waypointsReached: number; waypointsTotal: number;
        route: { distanceM: number; durationSec: number; reason: string | null } | null;
    } | null;
    nearby: NearbyVehicle[];
    recentEvents: CountMap;
    lastEvents: EventNote[];
};

export type ScenarioDetail = {
    scenarioId: string;
    name: string;
    state: string;
    vehicles: Array<{ vehicleCode: string; simStatus: string; speedKmh: number | null; blockedReason: string | null }>;
    byStatus: CountMap;
    restrictions: { blocked: number; penalty: number; reasons: string[] };
    recentEvents: CountMap;
    lastEvents: EventNote[];
};

export function asksAboutScenario(question: string | undefined): boolean {
    return Boolean(question && /시나리오|scenario/i.test(question));
}

function toNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function ageSeconds(now: Date, at: Date | null): number | null {
    return at ? Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000)) : null;
}

function point(value: unknown): { lat: number; lon: number } | null {
    const candidate = value as { lat?: unknown; lon?: unknown } | null;
    const lat = toNumber(candidate?.lat), lon = toNumber(candidate?.lon);
    return lat === null || lon === null || (lat === 0 && lon === 0) ? null : { lat, lon };
}

export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Collectors (read-only)
// ---------------------------------------------------------------------------

type CurrentObservationReader = (externalId: string) => Promise<TrackingSnapshot["vehicles"][number] | null>;

export async function collectRealVehicleDetail(db: PrismaClient, vehicleId: bigint, now = new Date(), readCurrent: CurrentObservationReader = trackingClient.vehicle, readRoute = routingInternalClient.route): Promise<RealVehicleDetail | null> {
    const vehicle = await db.vehicle.findUnique({
        where: { vehicleId },
        select: { vehicleCode: true, vehicleName: true, vehicleSource: true, vehicleStatus: true, externalId: true, heightM: true, widthM: true },
    });
    if (!vehicle || vehicle.vehicleSource === "VIRTUAL") return null;
    const visionSince = new Date(now.getTime() - VISION_WINDOW_MINUTES * 60_000);
    const reportingSince = new Date(now.getTime() - STALE_FIX_SECONDS * 1000);
    const speedSince = new Date(now.getTime() - SPEED_WINDOW_SECONDS * 1000);

    const [fixes, speeds, nearby, trip, byRisk, byClass, nearest, attitude, unconfirmed, recentAlerts, current] = await Promise.all([
        db.$queryRaw<Array<{ recorded_at: Date; received_at: Date; recording_session_id: string | null; source_timestamp_ns: string | null; speed_kmh: unknown; heading_deg: unknown; horizontal_accuracy_m: unknown; telemetry_source: string; lat: number; lon: number }>>`
            SELECT recorded_at, received_at, recording_session_id, source_timestamp_ns::text AS source_timestamp_ns, speed_kmh, heading_deg, horizontal_accuracy_m, telemetry_source,
                   ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon
            FROM vehicle_position WHERE vehicle_id = ${vehicleId}
            ORDER BY received_at DESC, source_timestamp_ns DESC NULLS LAST, position_id DESC LIMIT 1`,
        // Replay source dates can go backwards, so "recent" follows reception
        // time up to now, per recording session; the current session is picked below.
        db.$queryRaw<Array<{ recording_session_id: string | null; samples: bigint; min_kmh: unknown; avg_kmh: unknown; max_kmh: unknown }>>`
            SELECT recording_session_id, count(speed_kmh) AS samples, min(speed_kmh) AS min_kmh, avg(speed_kmh) AS avg_kmh, max(speed_kmh) AS max_kmh
            FROM vehicle_position
            WHERE vehicle_id = ${vehicleId} AND received_at >= ${speedSince}
            GROUP BY recording_session_id`,
        // Other real vehicles that are reporting now, nearest first.
        db.$queryRaw<Array<{ vehicle_id: bigint; received_at: Date; speed_kmh: unknown; distance_m: number }>>`
            WITH me AS (
                SELECT location FROM vehicle_position WHERE vehicle_id = ${vehicleId}
                ORDER BY received_at DESC, source_timestamp_ns DESC NULLS LAST, position_id DESC LIMIT 1
            )
            SELECT v.vehicle_id, p.received_at, p.speed_kmh, ST_Distance(p.location, me.location) AS distance_m
            FROM vehicle v
            CROSS JOIN me
            JOIN LATERAL (
                SELECT location, received_at, speed_kmh FROM vehicle_position vp
                WHERE vp.vehicle_id = v.vehicle_id
                ORDER BY received_at DESC, source_timestamp_ns DESC NULLS LAST, position_id DESC LIMIT 1
            ) p ON true
            WHERE v.is_active AND v.vehicle_source <> 'VIRTUAL' AND v.vehicle_id <> ${vehicleId}
              AND p.received_at >= ${reportingSince}
            ORDER BY distance_m ASC LIMIT ${NEARBY_LIMIT}`,
        db.trip.findFirst({
            where: { vehicleId, tripStatus: { in: ACTIVE_TRIP_STATES } },
            orderBy: { tripId: "desc" },
            select: { tripId: true, tripStatus: true, originName: true, destinationName: true, startedAt: true, routeMode: true,
                replayPreview: { select: { points: true } },
                routes: { where: { isCurrent: true }, take: 1, orderBy: { routeVersion: "desc" }, select: { distanceM: true, durationSec: true, routeGeojson: true } } },
        }),
        db.detectionEvent.groupBy({ by: ["riskLevel"], where: { vehicleId, detectedAt: { gte: visionSince } }, _count: { _all: true } }),
        db.detectionEvent.groupBy({
            by: ["className"], where: { vehicleId, detectedAt: { gte: visionSince } }, _count: { _all: true },
            orderBy: { _count: { className: "desc" } }, take: 5,
        }),
        db.detectionEvent.findFirst({
            where: { vehicleId, detectedAt: { gte: visionSince }, distanceM: { not: null } },
            orderBy: { distanceM: "asc" },
            select: { className: true, distanceM: true, riskLevel: true, detectedAt: true },
        }),
        // Camera attitude from the device IMU, recorded with each detection.
        db.detectionEvent.findFirst({
            where: { vehicleId, detectedAt: { gte: visionSince }, OR: [{ pitchAtCaptureDeg: { not: null } }, { rollAtCaptureDeg: { not: null } }] },
            orderBy: { detectedAt: "desc" },
            select: { pitchAtCaptureDeg: true, rollAtCaptureDeg: true, detectedAt: true },
        }),
        db.alert.count({ where: { vehicleId, alertStatus: "UNCONFIRMED" } }),
        db.alert.findMany({
            where: { vehicleId, createdAt: { gte: visionSince } }, orderBy: { createdAt: "desc" }, take: 5,
            select: { alertType: true, severity: true, alertMessage: true, createdAt: true },
        }),
        readCurrent(vehicle.vehicleSource === "BIMS" && vehicle.externalId ? vehicle.externalId : `device:${vehicleId}`).catch((error: unknown) => {
            logger.warn({ vehicleId: vehicleId.toString(), code: error instanceof AppError ? error.code : "TRACKING_LOOKUP_FAILED" },
                "Assistant current telemetry lookup failed; checking persisted GPS freshness");
            return null;
        }),
    ]);

    // Prisma cannot read the PostGIS point. A replay trip's destination is
    // the recording's last fix, the same point the map pins.
    const destination = trip ? (await db.$queryRaw<Array<{ lat: number; lon: number }>>`
        SELECT ST_Y(destination_location::geometry) AS lat, ST_X(destination_location::geometry) AS lon
        FROM trip WHERE trip_id = ${trip.tripId}`)?.[0] ?? null : null;
    const fix = fixes[0];
    let currentFix: RealVehicleDetail["fix"] = fix ? {
        recordedAt: fix.recorded_at.toISOString(), receivedAt: fix.received_at.toISOString(), ageSeconds: ageSeconds(now, fix.received_at) ?? 0,
        lat: Number(fix.lat), lon: Number(fix.lon), speedKmh: toNumber(fix.speed_kmh), headingDeg: toNumber(fix.heading_deg),
        accuracyM: toNumber(fix.horizontal_accuracy_m), telemetrySource: fix.telemetry_source,
    } : null;
    if (current && Number.isFinite(current.latitude) && Number.isFinite(current.longitude)) {
        const received = current.source_metadata?.receivedAt ?? current.observed_at_utc;
        const receivedAt = typeof received === "string" ? new Date(received) : null;
        if (receivedAt && Number.isFinite(receivedAt.getTime())) currentFix = {
            recordedAt: current.observed_at_utc ?? receivedAt.toISOString(), receivedAt: receivedAt.toISOString(),
            ageSeconds: ageSeconds(now, receivedAt) ?? 0, lat: current.latitude, lon: current.longitude,
            speedKmh: toNumber(current.speed_kmh), headingDeg: toNumber(current.heading_deg),
            accuracyM: toNumber(current.source_metadata?.horizontalAccuracyM), telemetrySource: current.telemetry_source,
        };
    }
    logger.debug({ vehicleId: vehicleId.toString(), telemetrySource: currentFix?.telemetrySource,
        speedKmh: currentFix?.speedKmh, receivedAt: currentFix?.receivedAt, ageSeconds: currentFix?.ageSeconds,
        currentTrackingAvailable: Boolean(current) }, "Assistant vehicle telemetry snapshot");
    // A replay trip is placed by how far the recording has played: the phone's
    // replay clock, which keeps running where the recording has no GPS.
    const currentMetadata = current?.source_metadata;
    const sourceTimes = [currentMetadata?.sourceClockNs, currentMetadata?.sourceTimestampNs, current ? null : fix?.source_timestamp_ns]
        .filter((value): value is string => typeof value === "string" && /^\d+$/.test(value));
    const sourceNow = sourceTimes.length ? sourceTimes.reduce((a, b) => (BigInt(a) >= BigInt(b) ? a : b)) : null;
    const route = trip?.routes?.[0];
    let remaining = !trip ? null : trip.routeMode === "REPLAY_ONLY"
        ? replayRemaining(trip.replayPreview?.points, sourceNow)
        : currentFix && route ? routeRemaining(route.routeGeojson, currentFix, route.distanceM, route.durationSec) : null;
    // Timeline and proportional whole-route durations are not navigation
    // ETAs. Keep only the known distance if the road router is unavailable.
    if (remaining && remaining.distanceM > 0) remaining = { ...remaining, durationSec: null };
    if (trip && destination && currentFix && currentFix.ageSeconds <= STALE_FIX_SECONDS
        && remaining?.distanceM !== 0) {
        const vehicleProfile = vehicle.vehicleSource === "BIMS" || Number(vehicle.widthM ?? 0) >= 2.3 || Number(vehicle.heightM ?? 0) >= 3.5 ? "semi" : "car";
        try {
            const navigation = await readRoute({
                origin: { lat: currentFix.lat, lon: currentFix.lon },
                destination: { lat: Number(destination.lat), lon: Number(destination.lon) },
                waypoints: [], vehicleProfile,
            });
            if (Number.isFinite(navigation.distanceM) && navigation.distanceM >= 0
                && Number.isFinite(navigation.durationSec) && navigation.durationSec >= 0) {
                remaining = { distanceM: navigation.distanceM, durationSec: navigation.durationSec, basis: "NAVIGATION" };
            }
        } catch (error) {
            logger.warn({ vehicleId: vehicleId.toString(), code: error instanceof AppError ? error.code : "ROUTING_LOOKUP_FAILED" },
                "Assistant navigation estimate unavailable; retaining distance without ETA");
        }
    }
    // The speed window belongs to the stream the current fix comes from.
    const currentSession = current ? current.source_metadata?.recordingSessionId ?? null : fix?.recording_session_id ?? null;
    const speed = speeds.find((row) => (row.recording_session_id ?? null) === currentSession);
    const samples = speed ? Number(speed.samples) : 0;
    return {
        vehicleCode: vehicleDisplayName(vehicleId),
        vehicleName: vehicle.vehicleName,
        source: vehicle.vehicleSource,
        // As the map shows it, so "대기" here is what the operator sees.
        status: current?.source_metadata?.state === "stale" ? "GPS 지연" : displayVehicleStatus(vehicle.vehicleStatus, trip?.tripStatus),
        fix: currentFix,
        recentSpeed: samples > 0 ? {
            samples, minKmh: toNumber(speed!.min_kmh) ?? 0, avgKmh: toNumber(speed!.avg_kmh) ?? 0, maxKmh: toNumber(speed!.max_kmh) ?? 0,
        } : null,
        trip: trip ? {
            tripId: trip.tripId.toString(), status: trip.tripStatus, originName: trip.originName,
            destinationName: trip.destinationName, startedAt: trip.startedAt?.toISOString() ?? null,
            destination: destination ? { lat: Number(destination.lat), lon: Number(destination.lon) } : null, remaining,
        } : null,
        nearby: nearby.map((row) => ({
            vehicleCode: vehicleDisplayName(row.vehicle_id), distanceM: Number(row.distance_m),
            speedKmh: toNumber(row.speed_kmh), ageSeconds: ageSeconds(now, row.received_at),
        })),
        detections: {
            total: byRisk.reduce((sum, row) => sum + row._count._all, 0),
            byRisk: Object.fromEntries(byRisk.map((row) => [row.riskLevel, row._count._all])),
            topClasses: byClass.map((row) => ({ className: row.className, count: row._count._all })),
            nearest: nearest?.distanceM != null ? {
                className: nearest.className, distanceM: Number(nearest.distanceM),
                riskLevel: nearest.riskLevel, detectedAt: nearest.detectedAt.toISOString(),
            } : null,
            attitude: attitude ? {
                pitchDeg: toNumber(attitude.pitchAtCaptureDeg), rollDeg: toNumber(attitude.rollAtCaptureDeg),
                detectedAt: attitude.detectedAt.toISOString(),
            } : null,
        },
        alerts: {
            unconfirmed,
            recent: recentAlerts.map((alert) => ({
                alertType: alert.alertType, severity: alert.severity, vehicleCode: vehicleDisplayName(vehicleId),
                message: alert.alertMessage, createdAt: alert.createdAt.toISOString(),
            })),
        },
    };
}

export async function collectScenarioDetail(db: PrismaClient, scenarioId: bigint, now = new Date()): Promise<ScenarioDetail | null> {
    const eventsSince = new Date(now.getTime() - EVENT_WINDOW_MINUTES * 60_000);
    const scenario = await db.virtualScenario.findUnique({
        where: { scenarioId },
        select: {
            scenarioId: true, name: true, state: true,
            vehicleStates: {
                where: { vehicle: { isActive: true } },
                select: { simStatus: true, speedKmh: true, blockedReason: true, vehicle: { select: { vehicleId: true } } },
            },
            restrictions: { where: { isActive: true }, select: { kind: true, reason: true } },
            events: { where: { createdAt: { gte: eventsSince } }, orderBy: { createdAt: "desc" }, select: { eventType: true, createdAt: true } },
        },
    });
    if (!scenario) return null;
    const states = [...scenario.vehicleStates].sort((a, b) =>
        Number(MOVING_SIM_STATES.includes(b.simStatus)) - Number(MOVING_SIM_STATES.includes(a.simStatus))
        || (a.vehicle.vehicleId < b.vehicle.vehicleId ? -1 : a.vehicle.vehicleId > b.vehicle.vehicleId ? 1 : 0));
    return {
        scenarioId: scenario.scenarioId.toString(),
        name: scenario.name,
        state: scenario.state,
        vehicles: states.map((state) => ({
            vehicleCode: vehicleDisplayName(state.vehicle.vehicleId), simStatus: state.simStatus,
            speedKmh: state.speedKmh, blockedReason: state.blockedReason,
        })),
        byStatus: countBy(states.map((state) => state.simStatus)),
        restrictions: {
            blocked: scenario.restrictions.filter((restriction) => restriction.kind === "BLOCKED").length,
            penalty: scenario.restrictions.filter((restriction) => restriction.kind !== "BLOCKED").length,
            reasons: [...new Set(scenario.restrictions.map((restriction) => restriction.reason).filter((reason): reason is string => Boolean(reason)))].slice(0, 5),
        },
        recentEvents: countBy(scenario.events.map((event) => event.eventType)),
        lastEvents: scenario.events.slice(0, LAST_EVENTS).map((event) => ({ eventType: event.eventType, createdAt: event.createdAt.toISOString() })),
    };
}

export async function collectVirtualVehicleDetail(db: PrismaClient, scenarioId: bigint, vehicleId: bigint, now = new Date()): Promise<VirtualVehicleDetail | null> {
    const eventsSince = new Date(now.getTime() - EVENT_WINDOW_MINUTES * 60_000);
    const vehicle = await db.vehicle.findUnique({
        where: { vehicleId },
        select: {
            vehicleCode: true, vehicleName: true, vehicleSource: true,
            virtualState: {
                select: {
                    scenarioId: true, simStatus: true, speedKmh: true, speedFactor: true, blockedReason: true,
                    lastCheckpointAt: true, lastPosition: true, routeVersion: true,
                    trip: {
                        select: {
                            virtualTripId: true, state: true, startedAt: true, endedAt: true,
                            waypoints: { select: { status: true } },
                            routes: { where: { isCurrent: true }, take: 1, select: { distanceM: true, durationSec: true, reason: true } },
                            events: { where: { createdAt: { gte: eventsSince } }, orderBy: { createdAt: "desc" }, select: { eventType: true, createdAt: true } },
                        },
                    },
                },
            },
        },
    });
    if (!vehicle || vehicle.vehicleSource !== "VIRTUAL") return null;
    // A vehicle keeps one state row; it describes this scenario only if the
    // vehicle's last trip ran here.
    const state = vehicle.virtualState?.scenarioId === scenarioId ? vehicle.virtualState : null;
    const position = state ? point(state.lastPosition) : null;
    let nearby: NearbyVehicle[] = [];
    if (position && MOVING_SIM_STATES.includes(state!.simStatus)) {
        const others = await db.virtualVehicleState.findMany({
            where: { scenarioId, vehicleId: { not: vehicleId }, simStatus: { in: MOVING_SIM_STATES }, vehicle: { isActive: true } },
            select: { lastPosition: true, speedKmh: true, lastCheckpointAt: true, vehicle: { select: { vehicleId: true } } },
        });
        nearby = others
            .map((other) => ({ other, at: point(other.lastPosition) }))
            .filter((item): item is { other: typeof others[number]; at: { lat: number; lon: number } } => item.at !== null)
            .map(({ other, at }) => ({
                vehicleCode: vehicleDisplayName(other.vehicle.vehicleId), distanceM: haversineM(position, at),
                speedKmh: other.speedKmh, ageSeconds: ageSeconds(now, other.lastCheckpointAt),
            }))
            .sort((a, b) => a.distanceM - b.distanceM)
            .slice(0, NEARBY_LIMIT);
    }
    const trip = state?.trip ?? null;
    const route = trip?.routes[0] ?? null;
    return {
        vehicleCode: vehicleDisplayName(vehicleId),
        vehicleName: vehicle.vehicleName,
        state: state ? {
            simStatus: state.simStatus, speedKmh: state.speedKmh, speedFactor: state.speedFactor,
            blockedReason: state.blockedReason, lastCheckpointAt: state.lastCheckpointAt.toISOString(),
            position, routeVersion: state.routeVersion,
        } : null,
        trip: trip ? {
            tripId: trip.virtualTripId.toString(), state: trip.state,
            startedAt: trip.startedAt.toISOString(), endedAt: trip.endedAt?.toISOString() ?? null,
            waypointsReached: trip.waypoints.filter((waypoint) => waypoint.status === "REACHED").length,
            waypointsTotal: trip.waypoints.length,
            route: route ? { distanceM: route.distanceM, durationSec: route.durationSec, reason: route.reason } : null,
        } : null,
        nearby,
        recentEvents: countBy(trip?.events.map((event) => event.eventType) ?? []),
        lastEvents: (trip?.events ?? []).slice(0, LAST_EVENTS).map((event) => ({ eventType: event.eventType, createdAt: event.createdAt.toISOString() })),
    };
}

function countBy(values: string[]): CountMap {
    const result: CountMap = {};
    for (const value of values) result[value] = (result[value] ?? 0) + 1;
    return result;
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

function km(value: number | null): string {
    return value === null ? "미상" : `${value.toFixed(1)} km/h`;
}

function meters(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m`;
}

function kstTime(iso: string): string {
    return formatKst(iso).replace(/^.*?(\d{2}:\d{2}).*$/, "$1");
}

function nearbyText(nearby: NearbyVehicle[]): string {
    return nearby.length
        ? nearby.map((item) => `${item.vehicleCode} ${meters(item.distanceM)} (속도 ${km(item.speedKmh)})`).join(", ")
        : "없음";
}

function minutesText(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    return minutes < 1 ? "1분 미만" : minutes < 60 ? `약 ${minutes}분` : `약 ${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

export function remainingText(remaining: TripRemaining): string {
    const distance = `남은 거리 ${(remaining.distanceM / 1000).toFixed(1)} km`;
    const basis = remaining.basis === "REPLAY" ? "" : remaining.basis === "NAVIGATION" ? "도로 경로 기준" : "계획 경로 기준";
    return remaining.durationSec === null
        ? `${distance} (${basis ? `${basis}, ` : ""}남은 시간 확인 불가)`
        : `${distance}, 남은 시간 ${minutesText(remaining.durationSec)}${basis ? ` (${basis})` : ""}`;
}

export function renderRealVehicleLines(detail: RealVehicleDetail): string[] {
    const lines = [`[선택 실차량] ${detail.vehicleCode}: 출처 ${label(detail.source, VEHICLE_SOURCE_LABELS)}, 상태 ${label(detail.status, VEHICLE_STATUS_LABELS)}`];
    lines.push(`  ${VEHICLE_STATUS_GLOSSARY}`);
    const fix = detail.fix;
    if (!fix) {
        lines.push("  위치: 수신 기록 없음");
    } else {
        const stale = fix.ageSeconds > STALE_FIX_SECONDS ? " — 위치 수신 지연" : "";
        const accuracy = fix.accuracyM === null ? "" : `, 정확도 ±${Math.round(fix.accuracyM)} m`;
        const source = fix.telemetrySource === "RECORDED_GPS" ? "" : `, ${label(fix.telemetrySource, TELEMETRY_SOURCE_LABELS)}`;
        lines.push(`  위치: 위도 ${fix.lat.toFixed(5)}, 경도 ${fix.lon.toFixed(5)} (${formatAge(fix.ageSeconds)}${source}${accuracy})${stale}`);
        lines.push(fix.ageSeconds > STALE_FIX_SECONDS
            ? "  현재 속도: 확인 불가 (최신 GPS 수신 없음; 과거 속도로 현재 저속·정상 운행 여부를 판단하지 않음)"
            : `  속도 ${km(fix.speedKmh)}${fix.headingDeg === null ? "" : `, 진행 방향 ${Math.round(fix.headingDeg)}°`}`);
        if (fix.telemetrySource === "RECORDED_GPS") lines.push(`  GPS 시각: 원본 시각 ${fix.recordedAt}, 최근 수신 시각 ${fix.receivedAt ?? "미상"} (원본 시각은 현재 수신 지연이 아님)`);
    }
    if (detail.recentSpeed && fix && fix.ageSeconds <= STALE_FIX_SECONDS) {
        const speed = detail.recentSpeed;
        lines.push(`  최근 ${SPEED_WINDOW_SECONDS}초 속도: 최소 ${speed.minKmh.toFixed(1)}, 평균 ${speed.avgKmh.toFixed(1)}, 최대 ${speed.maxKmh.toFixed(1)} km/h (${speed.samples}건)`);
    }
    const trip = detail.trip;
    lines.push(trip
        ? `  운행 #${trip.tripId} ${label(trip.status, TRIP_STATUS_LABELS)}: ${trip.originName ?? "출발지 미상"} → ${trip.destinationName}${trip.startedAt ? `, 시작 ${kstTime(trip.startedAt)}` : ""}`
        : "  진행 중 운행 없음");
    if (trip?.destination) lines.push(`  목적지 좌표: 위도 ${trip.destination.lat.toFixed(5)}, 경도 ${trip.destination.lon.toFixed(5)}`);
    if (trip?.remaining) lines.push(`  목적지까지: ${remainingText(trip.remaining)}`);
    lines.push(`  주변 실차량(위치 수신 중, 가까운 순): ${nearbyText(detail.nearby)}`);
    const detections = detail.detections;
    lines.push(`  [영상 감지 최근 ${VISION_WINDOW_MINUTES}분] 감지 ${detections.total}건 (위험도: ${formatCounts(detections.byRisk, RISK_LABELS)}), 주요 객체: ${detections.topClasses.length ? detections.topClasses.map((item) => `${label(item.className, OBJECT_CLASS_LABELS)} ${item.count}`).join(", ") : "없음"}`);
    if (!detections.total) lines.push("  영상 감지 기록 없음은 영상·감지 시스템 정상이나 실제 위험 객체 없음의 증거가 아님");
    if (detections.nearest) {
        const nearest = detections.nearest;
        lines.push(`  가장 가까운 감지 객체: ${label(nearest.className, OBJECT_CLASS_LABELS)} ${nearest.distanceM.toFixed(1)} m (${label(nearest.riskLevel, RISK_LABELS)}, ${kstTime(nearest.detectedAt)})`);
    }
    if (detections.attitude) {
        const attitude = detections.attitude;
        const parts = [attitude.pitchDeg === null ? null : `피치 ${attitude.pitchDeg.toFixed(1)}°`, attitude.rollDeg === null ? null : `롤 ${attitude.rollDeg.toFixed(1)}°`].filter(Boolean);
        lines.push(`  차량 자세(IMU, ${kstTime(attitude.detectedAt)} 감지 시점): ${parts.join(", ")}`);
    }
    lines.push(`  경보: 미확인 ${detail.alerts.unconfirmed}건`);
    for (const alert of detail.alerts.recent) {
        lines.push(`  - ${kstTime(alert.createdAt)} ${label(alert.alertType, ALERT_TYPE_LABELS)} ${label(alert.severity, SEVERITY_LABELS)}${alert.message ? `: ${alert.message}` : ""}`);
    }
    return lines;
}

export function renderVirtualVehicleLines(detail: VirtualVehicleDetail, scenarioName: string | null): string[] {
    const lines = [`[선택 가상 차량] ${detail.vehicleCode}${scenarioName ? `, 시나리오 '${scenarioName}'` : ""}`];
    const state = detail.state;
    if (!state) {
        lines.push("  이 시나리오에서 운행 기록 없음 (대기 중)");
        return lines;
    }
    lines.push(`  상태 ${label(state.simStatus, SIM_STATUS_LABELS)}${state.blockedReason ? ` (${reasonText(state.blockedReason)})` : ""}, 속도 ${km(state.speedKmh)}${state.speedFactor !== 1 ? `, 속도 배율 ${state.speedFactor}×` : ""}`);
    if (state.position) lines.push(`  위치: 위도 ${state.position.lat.toFixed(5)}, 경도 ${state.position.lon.toFixed(5)} (갱신 ${kstTime(state.lastCheckpointAt)})`);
    const trip = detail.trip;
    if (trip) {
        const route = trip.route ? `, 현재 경로 ${meters(trip.route.distanceM)} / 예상 ${Math.round(trip.route.durationSec / 60)}분` : "";
        lines.push(`  운행 #${trip.tripId} ${label(trip.state, SIM_STATUS_LABELS)}: 시작 ${kstTime(trip.startedAt)}${trip.endedAt ? `, 종료 ${kstTime(trip.endedAt)}` : ""}, 경유지 ${trip.waypointsReached}/${trip.waypointsTotal} 도달${route}, 경로 재계산 ${Math.max(0, state.routeVersion - 1)}회`);
    }
    lines.push(`  같은 시나리오 주변 차량(가까운 순): ${nearbyText(detail.nearby)}`);
    if (Object.keys(detail.recentEvents).length) lines.push(`  최근 ${EVENT_WINDOW_MINUTES}분 이벤트: ${formatCounts(detail.recentEvents, EVENT_TYPE_LABELS)}`);
    for (const event of detail.lastEvents) lines.push(`  - ${kstTime(event.createdAt)} ${label(event.eventType, EVENT_TYPE_LABELS)}`);
    return lines;
}

export function renderScenarioLines(detail: ScenarioDetail): string[] {
    const lines = [
        `[가상 시나리오] '${detail.name}'(#${detail.scenarioId}, ${label(detail.state, SCENARIO_STATE_LABELS)}): 차량 ${detail.vehicles.length}대 (${formatCounts(detail.byStatus, SIM_STATUS_LABELS)})`,
        `  도로 통제: 차단 ${detail.restrictions.blocked}건, 혼잡 가중 ${detail.restrictions.penalty}건${detail.restrictions.reasons.length ? ` (사유: ${detail.restrictions.reasons.join(", ")})` : ""}`,
    ];
    for (const vehicle of detail.vehicles.slice(0, MAX_SCENARIO_VEHICLES)) {
        lines.push(`  - ${vehicle.vehicleCode} ${label(vehicle.simStatus, SIM_STATUS_LABELS)}, 속도 ${km(vehicle.speedKmh)}${vehicle.blockedReason ? ` (${reasonText(vehicle.blockedReason)})` : ""}`);
    }
    if (detail.vehicles.length > MAX_SCENARIO_VEHICLES) lines.push(`  … 외 ${detail.vehicles.length - MAX_SCENARIO_VEHICLES}대`);
    if (Object.keys(detail.recentEvents).length) lines.push(`  최근 ${EVENT_WINDOW_MINUTES}분 이벤트: ${formatCounts(detail.recentEvents, EVENT_TYPE_LABELS)}`);
    for (const event of detail.lastEvents) lines.push(`  - ${kstTime(event.createdAt)} ${label(event.eventType, EVENT_TYPE_LABELS)}`);
    return lines;
}

function realVehicleReport(detail: RealVehicleDetail): string {
    const fix = detail.fix;
    return [
        `### 실차량 ${detail.vehicleCode}`,
        "| 항목 | 값 |", "|---|---|",
        `| 출처 / 상태 | ${label(detail.source, VEHICLE_SOURCE_LABELS)} / ${label(detail.status, VEHICLE_STATUS_LABELS)} |`,
        `| 마지막 위치 | ${fix ? `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)} (${formatAge(fix.ageSeconds)})` : "기록 없음"} |`,
        `| 현재 속도 | ${fix && fix.ageSeconds <= STALE_FIX_SECONDS ? km(fix.speedKmh) : "확인 불가 (최신 GPS 수신 없음)"} |`,
        ...(fix?.telemetrySource === "RECORDED_GPS" ? [`| 원본 시각 / 최근 수신 시각 | ${fix.recordedAt} / ${fix.receivedAt ?? "미상"} |`] : []),
        `| 최근 ${SPEED_WINDOW_SECONDS}초 평균 / 최대 | ${detail.recentSpeed && fix && fix.ageSeconds <= STALE_FIX_SECONDS ? `${detail.recentSpeed.avgKmh.toFixed(1)} / ${detail.recentSpeed.maxKmh.toFixed(1)} km/h` : "-"} |`,
        `| 운행 | ${detail.trip ? `#${detail.trip.tripId} ${label(detail.trip.status, TRIP_STATUS_LABELS)} → ${detail.trip.destinationName}` : "없음"} |`,
        ...(detail.trip?.remaining ? [`| 목적지까지 남은 거리 / 시간 | ${remainingText(detail.trip.remaining)} |`] : []),
        ...(detail.trip?.destination ? [`| 목적지 좌표 | ${detail.trip.destination.lat.toFixed(5)}, ${detail.trip.destination.lon.toFixed(5)} |`] : []),
        `| 가장 가까운 실차량 | ${detail.nearby[0] ? `${detail.nearby[0].vehicleCode} ${meters(detail.nearby[0].distanceM)}` : "없음"} |`,
        `| 영상 감지 (${VISION_WINDOW_MINUTES}분) | ${detail.detections.total}건 (${formatCounts(detail.detections.byRisk, RISK_LABELS)}) |`,
        `| 가장 가까운 감지 객체 | ${detail.detections.nearest ? `${label(detail.detections.nearest.className, OBJECT_CLASS_LABELS)} ${detail.detections.nearest.distanceM.toFixed(1)} m (${label(detail.detections.nearest.riskLevel, RISK_LABELS)})` : "없음"} |`,
        `| 미확인 경보 | ${detail.alerts.unconfirmed}건 |`,
    ].join("\n");
}

function virtualVehicleReport(detail: VirtualVehicleDetail): string {
    const state = detail.state, trip = detail.trip;
    return [
        `### 가상 차량 ${detail.vehicleCode}`,
        "| 항목 | 값 |", "|---|---|",
        `| 상태 | ${state ? `${label(state.simStatus, SIM_STATUS_LABELS)}${state.blockedReason ? ` (${reasonText(state.blockedReason)})` : ""}` : "대기"} |`,
        `| 속도 | ${km(state?.speedKmh ?? null)} |`,
        `| 운행 | ${trip ? `#${trip.tripId} ${label(trip.state, SIM_STATUS_LABELS)}, 경유지 ${trip.waypointsReached}/${trip.waypointsTotal}` : "없음"} |`,
        `| 현재 경로 | ${trip?.route ? `${meters(trip.route.distanceM)}, 예상 ${Math.round(trip.route.durationSec / 60)}분` : "-"} |`,
        `| 경로 재계산 | ${state ? Math.max(0, state.routeVersion - 1) : 0}회 |`,
        `| 가장 가까운 차량 | ${detail.nearby[0] ? `${detail.nearby[0].vehicleCode} ${meters(detail.nearby[0].distanceM)}` : "없음"} |`,
    ].join("\n");
}

function scenarioReport(detail: ScenarioDetail): string {
    return [
        `### 시나리오 '${detail.name}' (#${detail.scenarioId})`,
        "| 항목 | 값 |", "|---|---|",
        `| 차량 | ${detail.vehicles.length}대 (${formatCounts(detail.byStatus, SIM_STATUS_LABELS)}) |`,
        `| 도로 통제 | 차단 ${detail.restrictions.blocked}건 / 혼잡 가중 ${detail.restrictions.penalty}건 |`,
        `| 최근 ${EVENT_WINDOW_MINUTES}분 이벤트 | ${formatCounts(detail.recentEvents, EVENT_TYPE_LABELS)} |`,
        ...detail.vehicles.filter((vehicle) => ["NO_ROUTE", "BLOCKED_AWAITING_OPERATOR"].includes(vehicle.simStatus))
            .map((vehicle) => `- ${vehicle.vehicleCode} ${label(vehicle.simStatus, SIM_STATUS_LABELS)}${vehicle.blockedReason ? ` (${reasonText(vehicle.blockedReason)})` : ""}`),
    ].join("\n");
}

function reportHeader(title: string, generatedAt: string): string {
    return `## ${title}\n기준 시각: ${formatKst(generatedAt)}`;
}

const SAFETY_TOPIC = "작업장 내 운반차량 운행 안전 수칙";

export function realVehicleContext(detail: RealVehicleDetail, generatedAt: string, scenarios: Pick<FleetSnapshot, "virtual"> | null): AssistantContext {
    const lines = [`[기준 시각] ${formatKst(generatedAt)}`, ...renderRealVehicleLines(detail)];
    if (scenarios) lines.push(...renderVirtualLines(scenarios));
    const topics = [SAFETY_TOPIC, "차량 간 안전거리 및 제한속도"];
    if ((detail.detections.byRisk.DANGER ?? 0) > 0 || detail.alerts.unconfirmed > 0) topics.push("보행자 및 근로자 충돌 방지 접근 경보");
    if (!detail.fix || detail.fix.ageSeconds > STALE_FIX_SECONDS) topics.push("운행 차량 관리 감독 및 연락 체계");
    return {
        generatedAt,
        subject: `실차량 ${detail.vehicleCode}`,
        liveText: capText(lines.join("\n")),
        reportFigures: [reportHeader(`${detail.vehicleCode} 현황 보고서`, generatedAt), realVehicleReport(detail), ...(scenarios ? [renderScenarioTable(scenarios)] : [])].join("\n\n"),
        retrievalQuery: topics.join(", "),
    };
}

export function virtualVehicleContext(detail: VirtualVehicleDetail, scenario: ScenarioDetail, generatedAt: string, includeScenario: boolean): AssistantContext {
    const lines = [`[기준 시각] ${formatKst(generatedAt)}`, ...renderVirtualVehicleLines(detail, scenario.name)];
    if (includeScenario) lines.push(...renderScenarioLines(scenario));
    const topics = [SAFETY_TOPIC, "차량 간 안전거리 및 제한속도"];
    if (detail.state && ["NO_ROUTE", "BLOCKED_AWAITING_OPERATOR"].includes(detail.state.simStatus)) topics.push("도로 통제 시 차량 우회 운행 및 정차 안전");
    return {
        generatedAt,
        subject: `가상 차량 ${detail.vehicleCode} · 시나리오 ${scenario.name}`,
        liveText: capText(lines.join("\n")),
        // A report always places the vehicle within its scenario.
        reportFigures: [reportHeader(`가상 차량 ${detail.vehicleCode} 현황 보고서`, generatedAt), virtualVehicleReport(detail), scenarioReport(scenario)].join("\n\n"),
        retrievalQuery: topics.join(", "),
    };
}

export function scenarioContext(detail: ScenarioDetail, generatedAt: string): AssistantContext {
    const topics = [SAFETY_TOPIC];
    if (detail.restrictions.blocked || detail.vehicles.some((vehicle) => ["NO_ROUTE", "BLOCKED_AWAITING_OPERATOR"].includes(vehicle.simStatus))) {
        topics.push("도로 통제 시 차량 우회 운행 및 정차 안전");
    }
    return {
        generatedAt,
        subject: `시나리오 ${detail.name}`,
        liveText: capText([`[기준 시각] ${formatKst(generatedAt)}`, ...renderScenarioLines(detail)].join("\n")),
        reportFigures: [reportHeader(`시나리오 '${detail.name}' 현황 보고서`, generatedAt), scenarioReport(detail)].join("\n\n"),
        retrievalQuery: topics.join(", "),
    };
}

export function fleetContext(snapshot: FleetSnapshot, sections: SnapshotSections, subject: string, note?: string): AssistantContext {
    const liveText = renderSnapshotText(snapshot, sections);
    return {
        generatedAt: snapshot.generatedAt,
        subject,
        liveText: note ? capText(`${note}\n${liveText}`) : liveText,
        reportFigures: renderReportFigures(snapshot, sections),
        retrievalQuery: reportRetrievalQuery(snapshot, sections),
    };
}

const MONITORING_SECTIONS: SnapshotSections = { real: true, virtual: false, vision: true };
const VIRTUAL_SECTIONS: SnapshotSections = { real: false, virtual: true, vision: false };

// "모든 차량" keeps the current target, including an explicitly chosen
// panel target. Otherwise a numbered mention overrides the selection.
export function mentionedVehicleId(question?: string): string | undefined {
    if (!question || (/모든/.test(question) && /화물차|차량|운반차|트럭|자동차|차|vehicle|truck/i.test(question))) return undefined;
    const number = question.match(/(?:^|[^\d.\-])(\d+)\s*호(?![\dA-Za-z]|선|실)/)?.[1];
    if (!number || BigInt(number) === 0n) return undefined;
    return BigInt(number).toString();
}

async function resolveQuestionScope(db: PrismaClient, body: Pick<AssistantChatBody, "question" | "scope">): Promise<AssistantScope | undefined> {
    const vehicleId = mentionedVehicleId(body.question);
    if (!vehicleId) return body.scope;
    const vehicle = await db.vehicle.findUnique({
        where: { vehicleId: BigInt(vehicleId) },
        select: { vehicleSource: true, virtualState: { select: { scenarioId: true } } },
    });
    if (!vehicle) throw new AppError(404, `화물차 ${vehicleId}호를 찾을 수 없습니다.`, "VEHICLE_NOT_FOUND");
    if (vehicle.vehicleSource !== "VIRTUAL") return { view: "monitoring", vehicleId };
    const scenarioId = (body.scope?.view === "virtual" ? body.scope.scenarioId : undefined) ?? vehicle.virtualState?.scenarioId.toString();
    if (!scenarioId) throw new AppError(400, `화물차 ${vehicleId}호의 시나리오를 선택해 주세요.`, "ASSISTANT_SCENARIO_REQUIRED");
    return { view: "virtual", scenarioId, vehicleId };
}

// Picks the context from the question and the panel's current scope.
export async function buildAssistantContext(db: PrismaClient, body: Pick<AssistantChatBody, "question" | "scope">, now = new Date()): Promise<AssistantContext> {
    const scope = await resolveQuestionScope(db, body);
    const generatedAt = now.toISOString();
    const aboutScenario = asksAboutScenario(body.question);

    if (!scope) return fleetContext(await collectFleetSnapshot(db, now), ALL_SECTIONS, "전체 현황");

    if (scope.view === "monitoring") {
        if (scope.vehicleId) {
            const [detail, snapshot] = await Promise.all([
                collectRealVehicleDetail(db, BigInt(scope.vehicleId), now),
                aboutScenario ? collectFleetSnapshot(db, now) : Promise.resolve(null),
            ]);
            if (detail) return realVehicleContext(detail, generatedAt, snapshot);
            return fleetContext(snapshot ?? await collectFleetSnapshot(db, now), { ...MONITORING_SECTIONS, virtual: aboutScenario }, "실차량 전체",
                "[참고] 선택한 차량을 찾을 수 없어 전체 실차량 현황을 제공합니다.");
        }
        return fleetContext(await collectFleetSnapshot(db, now), { ...MONITORING_SECTIONS, virtual: aboutScenario }, "실차량 전체");
    }

    if (scope.scenarioId) {
        const scenarioId = BigInt(scope.scenarioId);
        const [scenario, vehicle] = await Promise.all([
            collectScenarioDetail(db, scenarioId, now),
            scope.vehicleId ? collectVirtualVehicleDetail(db, scenarioId, BigInt(scope.vehicleId), now) : Promise.resolve(null),
        ]);
        if (scenario && vehicle) return virtualVehicleContext(vehicle, scenario, generatedAt, aboutScenario);
        if (scenario) return scenarioContext(scenario, generatedAt);
    }
    return fleetContext(await collectFleetSnapshot(db, now), VIRTUAL_SECTIONS, "가상 시나리오 전체",
        scope.scenarioId ? "[참고] 선택한 시나리오를 찾을 수 없어 활성 시나리오 전체 현황을 제공합니다." : undefined);
}
