import { logger } from "../../config/logger.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import { virtualService } from "./virtual.service.ts";
import { waypointPassed } from "./virtual-waypoint-progress.ts";
import { TURBO_FACTOR, turboSpeedKmh } from "./virtual-turbo-speed.ts";

type RouteGeometry = { type?: string; coordinates?: unknown };
type Point = { lat: number; lon: number };

const TICK_MS = 250;

class TripStopConflict extends Error {}

function jsonValue(value: unknown): unknown {
    return value;
}

function coordinates(route: RouteGeometry): Point[] {
    if (!Array.isArray(route.coordinates)) return [];
    return route.coordinates.flatMap((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return [];
        const lon = Number(pair[0]);
        const lat = Number(pair[1]);
        return Number.isFinite(lat) && Number.isFinite(lon) ? [{ lat, lon }] : [];
    });
}

function distanceM(a: Point, b: Point): number {
    const lat1 = a.lat * Math.PI / 180;
    const lat2 = b.lat * Math.PI / 180;
    const dLat = lat2 - lat1;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function sample(points: Point[], fraction: number): { position: Point; offsetM: number } {
    if (points.length === 0) return { position: { lat: 0, lon: 0 }, offsetM: 0 };
    if (points.length === 1) return { position: points[0]!, offsetM: 0 };
    const lengths = points.slice(1).map((point, index) => distanceM(points[index]!, point));
    const total = lengths.reduce((sum, value) => sum + value, 0);
    const target = Math.max(0, Math.min(1, fraction)) * total;
    let traversed = 0;
    for (let index = 0; index < lengths.length; index += 1) {
        const segment = lengths[index]!;
        if (target <= traversed + segment || index === lengths.length - 1) {
            const ratio = segment <= 0 ? 0 : (target - traversed) / segment;
            const from = points[index]!;
            const to = points[index + 1]!;
            return {
                position: { lat: from.lat + (to.lat - from.lat) * ratio, lon: from.lon + (to.lon - from.lon) * ratio },
                offsetM: target,
            };
        }
        traversed += segment;
    }
    return { position: points.at(-1)!, offsetM: total };
}

function itineraryEdgeAt(itinerary: unknown, offsetM: number, key: "edgeId" | "physicalSegmentId"): string | null {
    if (!Array.isArray(itinerary)) return null;
    const edges = itinerary as Array<{ cumulativeStartM?: unknown; lengthM?: unknown; [name: string]: unknown }>;
    let fallback: string | null = null;
    for (const edge of edges) {
        const value = edge[key];
        if (typeof value !== "string") continue;
        fallback = value;
        const start = Number(edge.cumulativeStartM);
        const length = Number(edge.lengthM);
        if (!Number.isFinite(start) || !Number.isFinite(length)) continue;
        // Edge intervals are half-open except for the final edge.  This
        // keeps a point exactly at a junction associated with the edge it is
        // entering, while still returning the final edge at route end.
        if (offsetM >= start && offsetM < start + Math.max(0, length)) return value;
    }
    return fallback;
}

async function acceptDueRequests() {
    const due = await prisma.virtualDispatchRequest.findMany({
        where: { state: "PENDING", acceptAt: { lte: new Date() } },
        orderBy: { requestId: "asc" },
        take: 50,
        select: { requestId: true },
    });
    for (const request of due) {
        try {
            await virtualService.acceptRequest(request.requestId);
        } catch (error) {
            logger.warn({ err: error, requestId: request.requestId.toString() }, "Virtual dispatch auto-accept failed");
        }
    }
}

async function advanceVehicles() {
    const states = await prisma.virtualVehicleState.findMany({
        where: { simStatus: "DRIVING" },
        include: {
            activeRoute: true,
            trip: { include: { waypoints: { where: { status: "PENDING" }, select: { waypointId: true, snappedOffsetM: true } } } },
        },
        take: 200,
    });
    const scenarios = [...new Set(states.map((state) => state.scenarioId.toString()))].map((value) => BigInt(value));
    const activeRestrictions = await prisma.virtualRoadRestriction.findMany({ where: { scenarioId: { in: scenarios }, isActive: true, kind: "BLOCKED" }, select: { scenarioId: true, affectedDirectedEdgeIds: true } });
    const blockedByScenario = new Map<string, Set<string>>();
    for (const restriction of activeRestrictions) {
        const key = restriction.scenarioId.toString();
        const set = blockedByScenario.get(key) ?? new Set<string>();
        if (Array.isArray(restriction.affectedDirectedEdgeIds)) for (const edge of restriction.affectedDirectedEdgeIds) if (typeof edge === "string") set.add(edge);
        blockedByScenario.set(key, set);
    }
    const now = Date.now();
    for (const state of states) {
        const route = state.activeRoute;
        if (!route || state.trip.state !== "DRIVING") continue;
        const points = coordinates(jsonValue(route.routeGeojson) as RouteGeometry);
        if (points.length < 2) continue;
        const elapsed = Math.max(0, now - state.lastCheckpointAt.getTime());
        const durationMs = Math.max(1, route.durationSec * 1000);
        // Route duration is the routing engine's nominal travel time.  The
        // simulation speed is controlled independently by the vehicle's
        // speedKmh setting, so a live speed change affects the next tick even
        // while the trip is already driving.  Keep speedFactor as a legacy
        // multiplier for older clients that still send SET_SPEED_FACTOR.
        const routeDistanceM = Number(route.distanceM);
        const nominalSpeedMps = routeDistanceM > 0 && route.durationSec > 0
            ? routeDistanceM / route.durationSec
            : 0;
        const configuredSpeedKmh = state.speedFactor >= TURBO_FACTOR
            ? turboSpeedKmh(routeDistanceM)
            : Number(state.speedKmh);
        const configuredSpeedMps = configuredSpeedKmh > 0 ? configuredSpeedKmh / 3.6 : 0;
        const legacyFactor = Number.isFinite(state.speedFactor) && state.speedFactor > 0 ? state.speedFactor : 1;
        const motionFactor = nominalSpeedMps > 0 && configuredSpeedMps > 0
            ? (configuredSpeedMps * legacyFactor) / nominalSpeedMps
            : legacyFactor;
        const totalElapsedMs = Number(state.simElapsedMs) + elapsed * motionFactor;
        const fraction = Math.min(1, totalElapsedMs / durationMs);
        const position = sample(points, fraction);
        const itinerary = jsonValue(route.directedItinerary);
        const currentEdgeId = itineraryEdgeAt(itinerary, position.offsetM, "edgeId");
        const currentPhysicalSegmentId = itineraryEdgeAt(itinerary, position.offsetM, "physicalSegmentId");
        if (currentEdgeId && blockedByScenario.get(state.scenarioId.toString())?.has(currentEdgeId)) {
            logger.warn({
                scenarioId: state.scenarioId.toString(),
                vehicleId: state.vehicleId.toString(),
                tripId: state.virtualTripId.toString(),
                currentEdgeId,
                currentPhysicalSegmentId,
            }, "Virtual vehicle stopped before entering a blocked road edge");
            const stopped = await prisma.$transaction(async (tx) => {
                const stateClaim = await tx.virtualVehicleState.updateMany({
                    where: {
                        vehicleId: state.vehicleId,
                        virtualTripId: state.virtualTripId,
                        activeRouteId: state.activeRouteId,
                        simStatus: "DRIVING",
                        commandVersion: state.commandVersion,
                        lastCheckpointAt: state.lastCheckpointAt,
                    },
                    data: {
                        simStatus: "BLOCKED_AWAITING_OPERATOR",
                        currentEdgeId,
                        currentPhysicalSegmentId,
                        blockedReason: "Blocked road ahead",
                        lastCheckpointAt: new Date(now),
                        updatedAt: new Date(now),
                        commandVersion: { increment: 1 },
                    },
                });
                if (!stateClaim.count) return false;
                // The state claim above is the version check. The trip row
                // has its own commandVersion, which drifts from the state's
                // (a speed change bumps only the state, a waypoint change
                // only the trip), so comparing it with the state's version
                // failed every tick once they diverged and let the vehicle
                // drive through the closure.
                const tripClaim = await tx.virtualTrip.updateMany({
                    where: { virtualTripId: state.virtualTripId, state: "DRIVING" },
                    data: { state: "BLOCKED_AWAITING_OPERATOR", commandVersion: { increment: 1 } },
                });
                if (!tripClaim.count) throw new TripStopConflict();
                await tx.virtualOperatorEvent.create({ data: {
                    scenarioId: state.scenarioId,
                    virtualTripId: state.virtualTripId,
                    eventType: "VEHICLE_BLOCKED_BY_RESTRICTION",
                    payload: { vehicleId: state.vehicleId.toString(), tripId: state.virtualTripId.toString(), currentEdgeId, currentPhysicalSegmentId },
                } });
                return true;
            }).catch((error: unknown) => {
                // The trip left DRIVING concurrently (e.g. cancelled). Roll back
                // this stop and leave the other vehicles' tick unaffected.
                if (!(error instanceof TripStopConflict)) throw error;
                logger.warn({ vehicleId: state.vehicleId.toString(), tripId: state.virtualTripId.toString() }, "Trip changed while the simulation worker was stopping at a blocked road");
                return false;
            });
            if (!stopped) continue;
            continue;
        }
        if (fraction >= 1) {
            await prisma.$transaction([
                prisma.virtualVehicleState.update({ where: { vehicleId: state.vehicleId }, data: { simStatus: "COMPLETED", speedKmh: configuredSpeedKmh, simElapsedMs: BigInt(Math.round(durationMs)), currentEdgeId: null, currentPhysicalSegmentId: null, offsetM: position.offsetM, lastPosition: position.position, lastCheckpointAt: new Date(now), updatedAt: new Date(now) } }),
                prisma.virtualTrip.update({ where: { virtualTripId: state.virtualTripId }, data: { state: "COMPLETED", endedAt: new Date(now), updatedAt: new Date(now) } }),
                prisma.virtualTripWaypoint.updateMany({ where: { virtualTripId: state.virtualTripId, status: "PENDING" }, data: { status: "REACHED", reachedAt: new Date(now) } }),
                prisma.vehicle.update({ where: { vehicleId: state.vehicleId }, data: { vehicleStatus: "READY" } }),
            ]);
            continue;
        }
        const checkpoint = {
            where: { vehicleId: state.vehicleId, virtualTripId: state.virtualTripId, simStatus: "DRIVING", commandVersion: state.commandVersion },
            data: { speedKmh: configuredSpeedKmh, simElapsedMs: BigInt(Math.round(totalElapsedMs)), currentEdgeId, currentPhysicalSegmentId, offsetM: position.offsetM, lastPosition: position.position, lastCheckpointAt: new Date(now), updatedAt: new Date(now) },
        };
        const reachedWaypointIds = state.trip.waypoints
            .filter((waypoint) => waypointPassed(waypoint.snappedOffsetM, position.offsetM))
            .map((waypoint) => waypoint.waypointId);
        if (!reachedWaypointIds.length) {
            await prisma.virtualVehicleState.updateMany(checkpoint);
            continue;
        }
        // Waypoint offsets belong to the route read this tick. A reroute
        // committed meanwhile bumps commandVersion, which rejects this
        // checkpoint, so the stale offsets are never applied to a new route.
        await prisma.$transaction(async (tx) => {
            const claimed = await tx.virtualVehicleState.updateMany(checkpoint);
            if (!claimed.count) return;
            await tx.virtualTripWaypoint.updateMany({
                where: { waypointId: { in: reachedWaypointIds }, status: "PENDING" },
                data: { status: "REACHED", reachedAt: new Date(now) },
            });
        });
    }
}

export function startVirtualSimulationWorker() {
    let running = true;
    const tick = async () => {
        if (!running) return;
        try {
            await acceptDueRequests();
            await advanceVehicles();
        } catch (error) {
            logger.error({ err: error }, "Virtual simulation worker tick failed");
        }
    };
    const timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
    void tick();
    return () => {
        running = false;
        clearInterval(timer);
    };
}
