import { logger } from "../../config/logger.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import { virtualService } from "./virtual.service.ts";

type RouteGeometry = { type?: string; coordinates?: unknown };
type Point = { lat: number; lon: number };

const TICK_MS = 250;

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

function sample(points: Point[], fraction: number): { position: Point; offsetM: number; edgeIndex: number } {
    if (points.length === 0) return { position: { lat: 0, lon: 0 }, offsetM: 0, edgeIndex: 0 };
    if (points.length === 1) return { position: points[0]!, offsetM: 0, edgeIndex: 0 };
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
                edgeIndex: index,
            };
        }
        traversed += segment;
    }
    return { position: points.at(-1)!, offsetM: total, edgeIndex: lengths.length - 1 };
}

function edgeIdAt(itinerary: unknown, index: number): string | null {
    if (!Array.isArray(itinerary)) return null;
    const edge = itinerary[index] as { edgeId?: unknown } | undefined;
    return typeof edge?.edgeId === "string" ? edge.edgeId : null;
}

function physicalSegmentIdAt(itinerary: unknown, index: number): string | null {
    if (!Array.isArray(itinerary)) return null;
    const edge = itinerary[index] as { physicalSegmentId?: unknown } | undefined;
    return typeof edge?.physicalSegmentId === "string" ? edge.physicalSegmentId : null;
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
        include: { activeRoute: true, trip: true },
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
        const totalElapsedMs = Number(state.simElapsedMs) + elapsed * state.speedFactor;
        const durationMs = Math.max(1, route.durationSec * 1000);
        const fraction = Math.min(1, totalElapsedMs / durationMs);
        const position = sample(points, fraction);
        const itinerary = jsonValue(route.directedItinerary);
        const currentEdgeId = edgeIdAt(itinerary, position.edgeIndex);
        const currentPhysicalSegmentId = physicalSegmentIdAt(itinerary, position.edgeIndex);
        if (currentEdgeId && blockedByScenario.get(state.scenarioId.toString())?.has(currentEdgeId)) {
            await prisma.$transaction([
                prisma.virtualVehicleState.update({ where: { vehicleId: state.vehicleId }, data: { simStatus: "BLOCKED_AWAITING_OPERATOR", currentEdgeId, currentPhysicalSegmentId, blockedReason: "Blocked road ahead", lastCheckpointAt: new Date(now), updatedAt: new Date(now) } }),
                prisma.virtualTrip.update({ where: { virtualTripId: state.virtualTripId }, data: { state: "BLOCKED_AWAITING_OPERATOR", commandVersion: { increment: 1 } } }),
            ]);
            continue;
        }
        if (fraction >= 1) {
            await prisma.$transaction([
                prisma.virtualVehicleState.update({ where: { vehicleId: state.vehicleId }, data: { simStatus: "COMPLETED", simElapsedMs: BigInt(Math.round(durationMs)), currentEdgeId: null, currentPhysicalSegmentId: null, offsetM: position.offsetM, lastPosition: position.position, lastCheckpointAt: new Date(now), updatedAt: new Date(now) } }),
                prisma.virtualTrip.update({ where: { virtualTripId: state.virtualTripId }, data: { state: "COMPLETED", endedAt: new Date(now), updatedAt: new Date(now) } }),
                prisma.vehicle.update({ where: { vehicleId: state.vehicleId }, data: { vehicleStatus: "READY" } }),
            ]);
            continue;
        }
        await prisma.virtualVehicleState.updateMany({
            where: { vehicleId: state.vehicleId, virtualTripId: state.virtualTripId, simStatus: "DRIVING", commandVersion: state.commandVersion },
            data: { simElapsedMs: BigInt(Math.round(totalElapsedMs)), currentEdgeId, currentPhysicalSegmentId, offsetM: position.offsetM, lastPosition: position.position, lastCheckpointAt: new Date(now), updatedAt: new Date(now) },
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
