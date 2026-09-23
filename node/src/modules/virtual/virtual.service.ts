import { prisma } from "../../infrastructure/database/prisma.ts";
import { AppError } from "../../common/errors/app-error.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { routingInternalClient } from "./routing-internal.client.ts";
import type {
    CommandBody,
    Coordinate,
    CreateScenarioBody,
    CreateVirtualVehicleBody,
    DestinationBody,
    DispatchRequestBody,
    FollowingBody,
    RestrictionBody,
    RestrictionUpdateBody,
    RoutePreviewBody,
    WaypointsBody,
} from "./virtual.schema.ts";

const json = (value: unknown) => value as Prisma.InputJsonValue;
const ACTIVE_TRIP_STATES = ["DRIVING", "PAUSED", "REROUTING", "BLOCKED_AWAITING_OPERATOR", "NO_ROUTE"];
type RestrictionOverlay = {
    blockedEdgeIds: string[];
    blockedGeometries: unknown[];
    penaltyEdgeFactors: Record<string, number>;
};

type RerouteOptions = {
    destination?: Coordinate;
    expectedTripRevision?: number;
    reason?: string;
    actorId?: bigint;
    preloadedOverlay?: RestrictionOverlay;
};

function id(value: string): bigint {
    return BigInt(value);
}

function profileForVehicle(vehicle: { vehicleProfile?: unknown; widthM?: unknown; heightM?: unknown; lengthM?: unknown }) {
    if (typeof vehicle.vehicleProfile === "string") return vehicle.vehicleProfile;
    const width = Number(vehicle.widthM ?? 0);
    const height = Number(vehicle.heightM ?? 0);
    if (width >= 3 || height >= 4.5) return "special";
    if (width >= 2.3 || height >= 3.5) return "semi";
    return "small";
}

const PROFILE_DIMENSIONS: Record<string, { heightM: number; widthM: number; lengthM: number; maxLoadKg: number }> = {
    car: { heightM: 1.8, widthM: 1.9, lengthM: 5, maxLoadKg: 1_000 },
    small: { heightM: 2.5, widthM: 1.9, lengthM: 5, maxLoadKg: 3_500 },
    semi: { heightM: 4, widthM: 2.5, lengthM: 18, maxLoadKg: 40_000 },
    special: { heightM: 4.5, widthM: 3, lengthM: 20, maxLoadKg: 40_000 },
};
function point(value: unknown): Coordinate {
    const candidate = value as Partial<Coordinate>;
    return { lat: Number(candidate.lat), lon: Number(candidate.lon) };
}

function distanceMeters(first: Coordinate, second: Coordinate): number {
    const radians = Math.PI / 180;
    const lat1 = first.lat * radians;
    const lat2 = second.lat * radians;
    const dLat = lat2 - lat1;
    const dLon = (second.lon - first.lon) * radians;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

type RerouteContinuation = {
    origin: Coordinate;
    coordinates: number[][];
    distanceM: number;
    edge: Record<string, unknown>;
};

function routeCoordinates(value: unknown): number[][] {
    const candidate = value as { coordinates?: unknown } | null;
    if (!candidate || !Array.isArray(candidate.coordinates)) return [];
    return candidate.coordinates.flatMap((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return [];
        const lon = Number(pair[0]);
        const lat = Number(pair[1]);
        return Number.isFinite(lon) && Number.isFinite(lat) ? [[lon, lat]] : [];
    });
}

function routeLineLength(coordinates: number[][]): number {
    let total = 0;
    for (let index = 1; index < coordinates.length; index += 1) {
        total += distanceMeters(
            { lat: Number(coordinates[index - 1]![1]), lon: Number(coordinates[index - 1]![0]) },
            { lat: Number(coordinates[index]![1]), lon: Number(coordinates[index]![0]) },
        );
    }
    return total;
}

function sliceRouteLine(coordinates: number[][], startM: number, endM: number): number[][] {
    if (coordinates.length < 2) return coordinates;
    const total = routeLineLength(coordinates);
    const start = Math.max(0, Math.min(total, startM));
    const end = Math.max(start, Math.min(total, endM));
    const result: number[][] = [];
    let traversed = 0;
    for (let index = 1; index < coordinates.length; index += 1) {
        const from = coordinates[index - 1]!;
        const to = coordinates[index]!;
        const segmentM = distanceMeters(
            { lat: Number(from[1]), lon: Number(from[0]) },
            { lat: Number(to[1]), lon: Number(to[0]) },
        );
        const next = traversed + segmentM;
        if (segmentM <= 0) {
            traversed = next;
            continue;
        }
        if (next >= start && traversed <= end) {
            const startRatio = Math.max(0, Math.min(1, (start - traversed) / segmentM));
            const endRatio = Math.max(0, Math.min(1, (end - traversed) / segmentM));
            const startPoint = [
                from[0]! + (to[0]! - from[0]!) * startRatio,
                from[1]! + (to[1]! - from[1]!) * startRatio,
            ];
            const endPoint = [
                from[0]! + (to[0]! - from[0]!) * endRatio,
                from[1]! + (to[1]! - from[1]!) * endRatio,
            ];
            if (!result.length) result.push(startPoint);
            if (endRatio > startRatio || result.length === 1) result.push(endPoint);
        }
        traversed = next;
        if (traversed >= end) break;
    }
    return result.length >= 2 ? result : [];
}

function activeRouteForReroute(current: Awaited<ReturnType<typeof activeVehicleState>>) {
    const routes = current?.trip?.routes ?? [];
    return routes.find((route) => String(route.routeId) === String(current?.activeRouteId)) ?? routes.at(-1);
}

function forwardContinuationForReroute(
    current: Awaited<ReturnType<typeof activeVehicleState>>,
    position: Coordinate,
): RerouteContinuation | null {
    if (!current?.currentEdgeId) return null;
    // The simulation worker records the next blocked edge when it stops at
    // its entry boundary.  That edge is not occupied yet; preserving it as a
    // continuation would cross the closure before searching for an option.
    // NO_ROUTE likewise retries from the saved checkpoint rather than
    // replaying the old route's edge remainder.
    if (["BLOCKED_AWAITING_OPERATOR", "NO_ROUTE"].includes(current.simStatus)) return null;
    const route = activeRouteForReroute(current);
    if (!route) return null;
    const itinerary = Array.isArray(route.directedItinerary)
        ? route.directedItinerary as Array<Record<string, unknown>>
        : [];
    const edge = itinerary.find((item) => item.edgeId === current.currentEdgeId);
    if (!edge) return null;
    const edgeStartM = Number(edge.cumulativeStartM);
    const edgeLengthM = Number(edge.lengthM);
    if (!Number.isFinite(edgeStartM) || !Number.isFinite(edgeLengthM) || edgeLengthM <= 0) return null;
    const currentOffsetM = Number(current.offsetM);
    const startM = Number.isFinite(currentOffsetM)
        ? Math.max(edgeStartM, Math.min(edgeStartM + edgeLengthM, currentOffsetM))
        : edgeStartM;
    const endM = edgeStartM + edgeLengthM;
    const coordinates = sliceRouteLine(routeCoordinates(route.routeGeojson), startM, endM);
    if (coordinates.length < 2) return null;
    coordinates[0] = [position.lon, position.lat];
    const distanceM = routeLineLength(coordinates);
    const last = coordinates.at(-1)!;
    const continuationEdge = {
        ...edge,
        cumulativeStartM: 0,
        lengthM: distanceM,
    };
    return {
        origin: { lat: Number(last[1]), lon: Number(last[0]) },
        coordinates,
        distanceM,
        edge: continuationEdge,
    };
}

function anchorRerouteAtPosition(
    route: Awaited<ReturnType<typeof routingInternalClient.route>>,
    position: Coordinate,
    continuation?: RerouteContinuation | null,
) {
    const coordinates = route.routeGeojson?.coordinates;
    const first = coordinates?.[0];
    if (!Array.isArray(first) || first.length < 2
        || !Number.isFinite(position.lat) || !Number.isFinite(position.lon)
        || !Number.isFinite(Number(first[0])) || !Number.isFinite(Number(first[1]))) return route;

    if (continuation) {
        const continuationLast = continuation.coordinates.at(-1)!;
        const connectorDistanceM = distanceMeters(
            { lat: Number(continuationLast[1]), lon: Number(continuationLast[0]) },
            { lat: Number(first[1]), lon: Number(first[0]) },
        );
        const prefix = [...continuation.coordinates];
        if (connectorDistanceM >= 1) prefix.push([Number(first[0]), Number(first[1])]);
        const prefixDistanceM = continuation.distanceM + (connectorDistanceM >= 1 ? connectorDistanceM : 0);
        const averageSpeedMps = Number.isFinite(route.distanceM) && Number.isFinite(route.durationSec)
            && route.durationSec > 0 && route.distanceM > 0
            ? Math.max(1, route.distanceM / route.durationSec)
            : 8;
        const shiftedItinerary = Array.isArray(route.directedItinerary)
            ? route.directedItinerary.map((rawEdge) => {
                const edge = { ...rawEdge };
                const cumulativeStartM = Number(edge.cumulativeStartM);
                if (Number.isFinite(cumulativeStartM)) edge.cumulativeStartM = cumulativeStartM + prefixDistanceM;
                return edge;
            })
            : route.directedItinerary;
        return {
            ...route,
            routeGeojson: {
                ...route.routeGeojson,
                coordinates: [...prefix, ...coordinates.slice(1)],
            },
            directedItinerary: [continuation.edge, ...(shiftedItinerary ?? [])],
            distanceM: route.distanceM + prefixDistanceM,
            durationSec: route.durationSec + prefixDistanceM / averageSpeedMps,
        };
    }

    const snappedOrigin = { lat: Number(first[1]), lon: Number(first[0]) };
    const connectorDistanceM = distanceMeters(position, snappedOrigin);
    // The routing graph snaps the request to a node.  For a live reroute the
    // first simulation tick must still begin at the vehicle's authoritative
    // position, otherwise resetting elapsed time makes the worker teleport to
    // that snapped node.  A tiny connector is unnecessary and would only add
    // duplicate geometry.
    if (!Number.isFinite(connectorDistanceM) || connectorDistanceM < 1) return route;

    const averageSpeedMps = Number.isFinite(route.distanceM) && Number.isFinite(route.durationSec)
        && route.durationSec > 0 && route.distanceM > 0
        ? Math.max(1, route.distanceM / route.durationSec)
        : 8;
    const anchoredItinerary = Array.isArray(route.directedItinerary)
        ? route.directedItinerary.map((rawEdge, index) => {
            const edge = { ...rawEdge };
            const cumulativeStartM = Number(edge.cumulativeStartM);
            if (Number.isFinite(cumulativeStartM)) edge.cumulativeStartM = cumulativeStartM + connectorDistanceM;
            if (index === 0) {
                const lengthM = Number(edge.lengthM);
                if (Number.isFinite(lengthM)) edge.lengthM = lengthM + connectorDistanceM;
            }
            return edge;
        })
        : route.directedItinerary;

    return {
        ...route,
        routeGeojson: {
            ...route.routeGeojson,
            coordinates: [[position.lon, position.lat], ...coordinates],
        },
        directedItinerary: anchoredItinerary,
        distanceM: route.distanceM + connectorDistanceM,
        durationSec: route.durationSec + connectorDistanceM / averageSpeedMps,
    };
}

function itineraryEdge(value: unknown, key: "edgeId" | "physicalSegmentId"): string | null {
    if (!Array.isArray(value)) return null;
    const first = value[0] as Record<string, unknown> | undefined;
    return typeof first?.[key] === "string" ? first[key] as string : null;
}

async function restrictionOverlay(scenarioId: bigint) {
    const restrictions = await prisma.virtualRoadRestriction.findMany({ where: { scenarioId, isActive: true } });
    const blocked = new Set<string>();
    const blockedGeometries: unknown[] = [];
    const penalties: Record<string, number> = {};
    for (const restriction of restrictions) {
        const directed = Array.isArray(restriction.affectedDirectedEdgeIds) ? restriction.affectedDirectedEdgeIds : [];
        for (const edge of directed) {
            if (typeof edge !== "string") continue;
            if (restriction.kind === "BLOCKED") blocked.add(edge);
            else if (restriction.penaltyFactor !== null) penalties[edge] = Math.max(penalties[edge] ?? 1, restriction.penaltyFactor);
        }
        if (restriction.kind === "BLOCKED") blockedGeometries.push(restriction.geometry);
    }
    return { blockedEdgeIds: [...blocked], blockedGeometries, penaltyEdgeFactors: penalties };
}

function activeTripWhere(vehicleId: bigint) {
    return { vehicleId, state: { in: ACTIVE_TRIP_STATES } };
}

async function getScenario(scenarioId: bigint) {
    const scenario = await prisma.virtualScenario.findUnique({ where: { scenarioId } });
    if (!scenario) throw new AppError(404, "Virtual scenario not found", "SCENARIO_NOT_FOUND");
    return scenario;
}

async function getVirtualVehicle(vehicleId: bigint) {
    const vehicle = await prisma.vehicle.findUnique({ where: { vehicleId } });
    if (!vehicle || vehicle.vehicleSource !== "VIRTUAL" || !vehicle.isActive) {
        throw new AppError(404, "Virtual vehicle not found", "VIRTUAL_VEHICLE_NOT_FOUND");
    }
    return vehicle;
}

async function ensureSettings(vehicleId: bigint, autoFollowEnabled = true) {
    return prisma.virtualVehicleSettings.upsert({
        where: { vehicleId },
        create: { vehicleId, autoFollowEnabled },
        update: {},
    });
}

async function createEvent(
    tx: Prisma.TransactionClient,
    input: { scenarioId: bigint; virtualTripId?: bigint; requestId?: bigint; actorId: bigint | null; eventType: string; payload: unknown },
) {
    return tx.virtualOperatorEvent.create({
        data: {
            scenarioId: input.scenarioId,
            virtualTripId: input.virtualTripId ?? null,
            requestId: input.requestId ?? null,
            actorId: input.actorId ?? null,
            eventType: input.eventType,
            payload: json(input.payload),
        },
    });
}

async function activeVehicleState(vehicleId: bigint) {
    return prisma.virtualVehicleState.findUnique({
        where: { vehicleId },
        include: { trip: { include: { routes: { where: { isCurrent: true } }, waypoints: { orderBy: { sequence: "asc" } } } } },
    });
}

function occupiedVehicleIds(
    states: Array<{ vehicleId: bigint; currentEdgeId: string | null; currentPhysicalSegmentId: string | null }>,
    resolved: { affectedDirectedEdgeIds: string[]; affectedPhysicalSegmentIds: string[] },
) {
    const directed = new Set(resolved.affectedDirectedEdgeIds);
    const physical = new Set(resolved.affectedPhysicalSegmentIds);
    return states
        .filter((state) => (state.currentEdgeId !== null && directed.has(state.currentEdgeId))
            || (state.currentPhysicalSegmentId !== null && physical.has(state.currentPhysicalSegmentId)))
        .map((state) => state.vehicleId.toString());
}

export const virtualService = {
    async createScenario(input: CreateScenarioBody, actorId?: bigint) {
        return prisma.virtualScenario.create({
            data: {
                name: input.name,
                autoAcceptAfterSeconds: input.autoAcceptAfterSeconds ?? null,
                createdBy: actorId ?? null,
            },
        });
    },

    async listScenarios() {
        return prisma.virtualScenario.findMany({
            where: { state: { not: "ARCHIVED" } },
            orderBy: { updatedAt: "desc" },
            include: { _count: { select: { dispatchRequests: true, trips: true, restrictions: true } } },
        });
    },

    async removeScenario(scenarioId: bigint, actorId?: bigint) {
        return prisma.$transaction(async (tx) => {
            const scenario = await tx.virtualScenario.findUnique({ where: { scenarioId } });
            if (!scenario) throw new AppError(404, "Virtual scenario not found", "SCENARIO_NOT_FOUND");
            if (scenario.state === "ARCHIVED") return scenario;

            const activeTrip = await tx.virtualTrip.findFirst({
                where: { scenarioId, state: { in: ACTIVE_TRIP_STATES } },
                select: { virtualTripId: true },
            });
            if (activeTrip) {
                throw new AppError(
                    409,
                    "Cancel all active virtual trips before removing this scenario",
                    "SCENARIO_BUSY",
                );
            }

            const rejected = await tx.virtualDispatchRequest.updateMany({
                where: { scenarioId, state: "PENDING" },
                data: { state: "REJECTED", decidedAt: new Date(), decidedBy: actorId ?? null },
            });
            const archived = await tx.virtualScenario.update({
                where: { scenarioId },
                data: { state: "ARCHIVED", updatedAt: new Date() },
            });
            await createEvent(tx, {
                scenarioId,
                actorId: actorId ?? null,
                eventType: "SCENARIO_ARCHIVED",
                payload: { rejectedPendingRequests: rejected.count },
            });
            return archived;
        }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
    },

    async getScenario(scenarioId: bigint) {
        const scenario = await getScenario(scenarioId);
        const vehicles = await this.listVehicles(scenarioId);
        const requests = await prisma.virtualDispatchRequest.findMany({
            where: { scenarioId, state: "PENDING" },
            orderBy: { createdAt: "asc" },
        });
        const restrictions = await prisma.virtualRoadRestriction.findMany({ where: { scenarioId, isActive: true }, orderBy: { revision: "asc" } });
        return { ...scenario, vehicles, pendingRequests: requests, restrictions };
    },

    async snapRoutePoint(scenarioId: bigint, coordinate: Coordinate) {
        await getScenario(scenarioId);
        return routingInternalClient.snap(coordinate);
    },

    async listVehicles(scenarioId: bigint) {
        const vehicles = await prisma.vehicle.findMany({
            where: { vehicleSource: "VIRTUAL", isActive: true },
            orderBy: { vehicleCode: "asc" },
        });
        const states = await prisma.virtualVehicleState.findMany({
            where: { scenarioId, vehicleId: { in: vehicles.map((vehicle) => vehicle.vehicleId) } },
            // Return the complete immutable route history so the operator map
            // can show how a blockage or penalty changed the trip. The
            // simulation worker still reads only its current route.
            include: { trip: { include: { routes: { orderBy: { routeVersion: "asc" } }, waypoints: { orderBy: { sequence: "asc" } } } } },
        });
        const settings = await prisma.virtualVehicleSettings.findMany({
            where: { vehicleId: { in: vehicles.map((vehicle) => vehicle.vehicleId) } },
        });
        const stateByVehicle = new Map(states.map((item) => [item.vehicleId.toString(), item]));
        const settingByVehicle = new Map(settings.map((item) => [item.vehicleId.toString(), item]));
        return vehicles.map((vehicle) => ({
            ...vehicle,
            vehicleProfile: profileForVehicle(vehicle),
            following: settingByVehicle.get(vehicle.vehicleId.toString()) ?? { autoFollowEnabled: true, policyVersion: 1 },
            state: stateByVehicle.get(vehicle.vehicleId.toString()) ?? null,
        }));
    },

    async createVehicle(input: CreateVirtualVehicleBody) {
        const defaults = PROFILE_DIMENSIONS[input.vehicleProfile] ?? PROFILE_DIMENSIONS.small!;
        const vehicle = await prisma.vehicle.create({
            data: {
                vehicleCode: input.vehicleCode,
                vehicleName: input.vehicleName ?? null,
                vehicleSource: "VIRTUAL",
                vehicleStatus: "READY",
                heightM: input.heightM ?? defaults.heightM,
                widthM: input.widthM ?? defaults.widthM,
                lengthM: input.lengthM ?? defaults.lengthM,
                maxLoadKg: input.maxLoadKg ?? defaults.maxLoadKg,
            },
        });
        await ensureSettings(vehicle.vehicleId, input.autoFollowEnabled);
        return vehicle;
    },

    async setVehicleActive(vehicleId: bigint, isActive: boolean) {
        return prisma.$transaction(async (tx) => {
            const vehicle = await tx.vehicle.findUnique({
                where: { vehicleId },
                select: { vehicleId: true, vehicleSource: true, isActive: true },
            });
            if (!vehicle || vehicle.vehicleSource !== "VIRTUAL") {
                throw new AppError(404, "Virtual vehicle not found", "VIRTUAL_VEHICLE_NOT_FOUND");
            }

            if (!isActive) {
                const activeTrip = await tx.virtualTrip.findFirst({
                    where: activeTripWhere(vehicleId),
                    select: { virtualTripId: true },
                });
                if (activeTrip) {
                    throw new AppError(
                        409,
                        "Cancel the virtual vehicle's active trip before removing it",
                        "VIRTUAL_VEHICLE_BUSY",
                    );
                }

                const pendingRequest = await tx.virtualDispatchRequest.findFirst({
                    where: { selectedVehicleId: vehicleId, state: "PENDING" },
                    select: { requestId: true },
                });
                if (pendingRequest) {
                    throw new AppError(
                        409,
                        "Reject the virtual vehicle's pending driver request before removing it",
                        "VIRTUAL_VEHICLE_PENDING_REQUEST",
                    );
                }
            }

            return tx.vehicle.update({
                where: { vehicleId },
                data: { isActive },
            });
        });
    },

    async previewRoute(scenarioId: bigint, input: RoutePreviewBody, actorId?: bigint) {
        const scenario = await getScenario(scenarioId);
        const vehicleId = id(input.selectedVehicleId);
        const vehicle = await getVirtualVehicle(vehicleId);
        if (vehicle.vehicleStatus !== "READY") throw new AppError(409, "Selected virtual vehicle is not available", "VEHICLE_BUSY");
        if (input.expectedRestrictionRevision !== undefined && input.expectedRestrictionRevision !== scenario.restrictionRevision) {
            throw new AppError(409, "Scenario restrictions changed; refresh the route preview", "STALE_REVISION");
        }
        if (await prisma.virtualTrip.findFirst({ where: activeTripWhere(vehicleId) })) {
            throw new AppError(409, "Selected virtual vehicle already has an active trip", "VEHICLE_BUSY");
        }
        await ensureSettings(vehicleId);
        const overlay = await restrictionOverlay(scenarioId);
        const route = await routingInternalClient.route({
            origin: input.origin,
            destination: input.destination,
            waypoints: input.waypoints,
            vehicleProfile: profileForVehicle(vehicle),
            ...overlay,
        });
        const draft = await prisma.virtualRouteDraft.create({
            data: {
                scenarioId,
                selectedVehicleId: vehicleId,
                origin: json(input.origin),
                destination: json(input.destination),
                waypoints: json(input.waypoints),
                requestedProfile: json({ vehicleProfile: profileForVehicle(vehicle), vehicleId: vehicleId.toString() }),
                routeGeojson: json(route.routeGeojson),
                directedItinerary: json(route.directedItinerary),
                snappedStops: json(route.snappedStops),
                graphVersion: route.graphVersion,
                restrictionRevision: scenario.restrictionRevision,
                distanceM: route.distanceM,
                durationSec: route.durationSec,
                expiresAt: new Date(Date.now() + 15 * 60_000),
                createdBy: actorId ?? null,
            },
        });
        return { ...draft, route, selectedVehicleId: vehicleId };
    },

    async listDispatchRequests(scenarioId: bigint) {
        await getScenario(scenarioId);
        return prisma.virtualDispatchRequest.findMany({ where: { scenarioId }, orderBy: { createdAt: "desc" } });
    },

    async createDispatchRequest(scenarioId: bigint, input: DispatchRequestBody, actorId?: bigint) {
        const scenario = await getScenario(scenarioId);
        const vehicleId = id(input.selectedVehicleId);
        const vehicle = await getVirtualVehicle(vehicleId);
        if (vehicle.vehicleStatus !== "READY") throw new AppError(409, "Selected virtual vehicle is not available", "VEHICLE_BUSY");
        const existing = await prisma.virtualDispatchRequest.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (existing) return existing;
        const draft = await prisma.virtualRouteDraft.findUnique({ where: { draftId: id(input.draftId) } });
        if (!draft || draft.scenarioId !== scenarioId || draft.selectedVehicleId !== vehicleId || draft.expiresAt <= new Date()) {
            throw new AppError(409, "Route draft is stale or belongs to another vehicle", "STALE_DRAFT");
        }
        if (await prisma.virtualTrip.findFirst({ where: activeTripWhere(vehicleId) })) {
            throw new AppError(409, "Selected virtual vehicle already has an active trip", "VEHICLE_BUSY");
        }
        const acceptAt = scenario.autoAcceptAfterSeconds === null ? null : new Date(Date.now() + (scenario.autoAcceptAfterSeconds ?? 0) * 1000);
        const request = await prisma.virtualDispatchRequest.create({
            data: {
                scenarioId,
                draftId: draft.draftId,
                selectedVehicleId: vehicleId,
                simulatedDriverName: `Virtual driver · ${vehicleId.toString()}`,
                acceptAt,
                idempotencyKey: input.idempotencyKey,
                requestedBy: actorId ?? null,
            },
        });
        await prisma.virtualOperatorEvent.create({ data: { scenarioId, requestId: request.requestId, actorId: actorId ?? null, eventType: "DISPATCH_REQUEST_CREATED", payload: json({ selectedVehicleId: vehicleId.toString(), draftId: draft.draftId.toString() }) } });
        return request;
    },

    async acceptRequest(requestId: bigint, actorId?: bigint) {
        const result = await prisma.$transaction(async (tx) => {
            const request = await tx.virtualDispatchRequest.findUnique({ where: { requestId }, include: { draft: true, scenario: true } });
            if (!request) throw new AppError(404, "Dispatch request not found", "REQUEST_NOT_FOUND");
            if (request.state === "ACCEPTED" && request.acceptedTripId) {
                return tx.virtualTrip.findUnique({ where: { virtualTripId: request.acceptedTripId }, include: { routes: true, waypoints: true, stateRecord: true } });
            }
            if (request.state !== "PENDING") throw new AppError(409, "Dispatch request is no longer pending", "REQUEST_NOT_PENDING");
            if (request.draft.expiresAt <= new Date()) throw new AppError(409, "Route draft has expired", "STALE_DRAFT");
            const occupied = await tx.virtualTrip.findFirst({ where: activeTripWhere(request.selectedVehicleId) });
            if (occupied) throw new AppError(409, "Selected virtual vehicle is already busy", "VEHICLE_BUSY");
            const selectedVehicle = await tx.vehicle.findUnique({ where: { vehicleId: request.selectedVehicleId }, select: { vehicleSource: true, isActive: true, vehicleStatus: true } });
            if (!selectedVehicle || selectedVehicle.vehicleSource !== "VIRTUAL" || !selectedVehicle.isActive || selectedVehicle.vehicleStatus !== "READY") throw new AppError(409, "Selected virtual vehicle is not available", "VEHICLE_BUSY");
            const settings = await tx.virtualVehicleSettings.upsert({ where: { vehicleId: request.selectedVehicleId }, create: { vehicleId: request.selectedVehicleId }, update: {} });
            const trip = await tx.virtualTrip.create({
                data: {
                    scenarioId: request.scenarioId,
                    vehicleId: request.selectedVehicleId,
                    dispatchRequestId: request.requestId,
                    origin: json(request.draft.origin),
                    destination: json(request.draft.destination),
                    state: "DRIVING",
                    routes: {
                        create: {
                            routeVersion: 1,
                            routeType: "INITIAL",
                            routeGeojson: json(request.draft.routeGeojson),
                            directedItinerary: json(request.draft.directedItinerary),
                            distanceM: request.draft.distanceM,
                            durationSec: request.draft.durationSec,
                            restrictionRevision: request.draft.restrictionRevision,
                            graphVersion: request.draft.graphVersion,
                            reason: "DISPATCH",
                            activatedAt: new Date(),
                        },
                    },
                    waypoints: {
                        create: (request.draft.waypoints as Array<{ lat: number; lon: number; clientId?: string }>).map((item, index) => ({
                            sequence: index,
                            originalPoint: json(item),
                            clientId: item.clientId ?? null,
                        })),
                    },
                },
                include: { routes: true, waypoints: true },
            });
            const route = trip.routes[0];
            if (!route) throw new AppError(500, "Accepted trip has no route", "ROUTE_INITIALIZATION_FAILED");
            await tx.virtualTrip.update({ where: { virtualTripId: trip.virtualTripId }, data: { activeRouteId: route.routeId } });
            const initialState = {
                scenarioId: request.scenarioId,
                virtualTripId: trip.virtualTripId,
                activeRouteId: route.routeId,
                simStatus: "DRIVING",
                routeVersion: 1,
                commandVersion: 1,
                eventSequence: 0n,
                graphVersion: route.graphVersion,
                currentEdgeId: itineraryEdge(request.draft.directedItinerary, "edgeId"),
                currentPhysicalSegmentId: itineraryEdge(request.draft.directedItinerary, "physicalSegmentId"),
                offsetM: null,
                speedKmh: 30,
                speedFactor: 1,
                simElapsedMs: 0n,
                lastPosition: json(request.draft.origin),
                blockedReason: null,
                lastCheckpointAt: new Date(),
                updatedAt: new Date(),
            };
            // A vehicle keeps its terminal checkpoint row for history. Reuse
            // that row when assigning the vehicle to its next trip; the
            // vehicle-level primary key must never be duplicated.
            await tx.virtualVehicleState.upsert({
                where: { vehicleId: request.selectedVehicleId },
                create: { vehicleId: request.selectedVehicleId, ...initialState },
                update: initialState,
            });
            await tx.virtualDispatchRequest.update({ where: { requestId }, data: { state: "ACCEPTED", acceptedTripId: trip.virtualTripId, decidedAt: new Date(), decidedBy: actorId ?? null, revision: { increment: 1 } } });
            await tx.vehicle.update({ where: { vehicleId: request.selectedVehicleId }, data: { vehicleStatus: "DRIVING" } });
            await createEvent(tx, { scenarioId: request.scenarioId, virtualTripId: trip.virtualTripId, requestId, actorId: actorId ?? null, eventType: "DISPATCH_ACCEPTED", payload: { vehicleId: request.selectedVehicleId.toString(), autoFollowEnabled: settings.autoFollowEnabled } });
            return tx.virtualTrip.findUnique({ where: { virtualTripId: trip.virtualTripId }, include: { routes: true, waypoints: true, stateRecord: true } });
        }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
        return result;
    },

    async rejectRequest(requestId: bigint, actorId?: bigint) {
        const request = await prisma.virtualDispatchRequest.findUnique({ where: { requestId } });
        if (!request) throw new AppError(404, "Dispatch request not found", "REQUEST_NOT_FOUND");
        if (request.state !== "PENDING") return request;
        return prisma.$transaction(async (tx) => {
            const rejected = await tx.virtualDispatchRequest.update({ where: { requestId }, data: { state: "REJECTED", decidedAt: new Date(), decidedBy: actorId ?? null, revision: { increment: 1 } } });
            await createEvent(tx, { scenarioId: request.scenarioId, requestId, actorId: actorId ?? null, eventType: "DISPATCH_REJECTED", payload: { requestId: requestId.toString() } });
            return rejected;
        });
    },

    async getTrip(tripId: bigint) {
        const trip = await prisma.virtualTrip.findUnique({ where: { virtualTripId: tripId }, include: { routes: { orderBy: { routeVersion: "desc" } }, waypoints: { orderBy: { sequence: "asc" } }, stateRecord: true, vehicle: true } });
        if (!trip) throw new AppError(404, "Virtual trip not found", "VIRTUAL_TRIP_NOT_FOUND");
        const settings = await ensureSettings(trip.vehicleId);
        return { ...trip, following: settings };
    },

    async command(tripId: bigint, input: CommandBody, actorId?: bigint) {
        const trip = await prisma.virtualTrip.findUnique({ where: { virtualTripId: tripId }, include: { stateRecord: true } });
        if (!trip || !trip.stateRecord) throw new AppError(404, "Virtual trip not found", "VIRTUAL_TRIP_NOT_FOUND");
        if (["COMPLETED", "CANCELLED"].includes(trip.state)) throw new AppError(409, "Virtual trip is terminal", "TRIP_TERMINAL");
        if (input.command === "PAUSE") return prisma.$transaction(async (tx) => { const result = await tx.virtualTrip.update({ where: { virtualTripId: tripId }, data: { state: "PAUSED", commandVersion: { increment: 1 } } }); await tx.virtualVehicleState.update({ where: { virtualTripId: tripId }, data: { simStatus: "PAUSED", lastCheckpointAt: new Date(), commandVersion: { increment: 1 } } }); await createEvent(tx, { scenarioId: trip.scenarioId, virtualTripId: tripId, actorId: actorId ?? null, eventType: "TRIP_PAUSED", payload: {} }); return result; });
        if (input.command === "RESUME") return prisma.$transaction(async (tx) => { const result = await tx.virtualTrip.update({ where: { virtualTripId: tripId }, data: { state: "DRIVING", commandVersion: { increment: 1 } } }); await tx.virtualVehicleState.update({ where: { virtualTripId: tripId }, data: { simStatus: "DRIVING", blockedReason: null, commandVersion: { increment: 1 } } }); await createEvent(tx, { scenarioId: trip.scenarioId, virtualTripId: tripId, actorId: actorId ?? null, eventType: "TRIP_RESUMED", payload: {} }); return result; });
        if (input.command === "CANCEL_TRIP") {
            return prisma.$transaction(async (tx) => { await tx.vehicle.update({ where: { vehicleId: trip.vehicleId }, data: { vehicleStatus: "READY" } }); await tx.virtualVehicleState.update({ where: { virtualTripId: tripId }, data: { simStatus: "CANCELLED", commandVersion: { increment: 1 } } }); const result = await tx.virtualTrip.update({ where: { virtualTripId: tripId }, data: { state: "CANCELLED", endedAt: new Date(), commandVersion: { increment: 1 } } }); await createEvent(tx, { scenarioId: trip.scenarioId, virtualTripId: tripId, actorId: actorId ?? null, eventType: "TRIP_CANCELLED", payload: {} }); return result; });
        }
        if (input.command === "SET_SPEED_FACTOR") return prisma.$transaction(async (tx) => { const result = await tx.virtualVehicleState.update({ where: { virtualTripId: tripId }, data: { speedFactor: input.speedFactor, commandVersion: { increment: 1 } } }); await createEvent(tx, { scenarioId: trip.scenarioId, virtualTripId: tripId, actorId: actorId ?? null, eventType: "SPEED_FACTOR_CHANGED", payload: { speedFactor: input.speedFactor } }); return result; });
        if (input.command === "SET_SPEED_KMH") return prisma.$transaction(async (tx) => {
            // speedKmh is the vehicle's requested cruising speed.  Reset the
            // legacy multiplier so selecting a preset has a direct meaning;
            // SET_SPEED_FACTOR remains available for older clients.
            const result = await tx.virtualVehicleState.update({ where: { virtualTripId: tripId }, data: { speedKmh: input.speedKmh, speedFactor: 1, commandVersion: { increment: 1 } } });
            await createEvent(tx, { scenarioId: trip.scenarioId, virtualTripId: tripId, actorId: actorId ?? null, eventType: "SPEED_CHANGED", payload: { speedKmh: input.speedKmh } });
            return result;
        });
        throw new AppError(409, "No route candidate is available", "NO_ROUTE_CANDIDATE");
    },

    async setFollowing(vehicleId: bigint, input: FollowingBody, actorId?: bigint) {
        await getVirtualVehicle(vehicleId);
        const current = await ensureSettings(vehicleId);
        if (input.expectedPolicyVersion !== undefined && input.expectedPolicyVersion !== current.policyVersion) throw new AppError(409, "Vehicle follow setting changed", "STALE_POLICY_VERSION");
        const state = await activeVehicleState(vehicleId);
        const settings = await prisma.virtualVehicleSettings.update({ where: { vehicleId }, data: { autoFollowEnabled: input.enabled, policyVersion: { increment: 1 } } });
        if (input.enabled && state && state.trip.state !== "PAUSED" && state.trip.state !== "COMPLETED" && state.trip.state !== "CANCELLED") {
            try {
                await this.rerouteFromCurrentPosition(vehicleId, state);
            } catch (error) {
                if (!(error instanceof AppError) || error.code !== "ROUTE_NOT_FOUND") throw error;
                await prisma.$transaction([
                    prisma.virtualVehicleState.update({ where: { vehicleId }, data: { simStatus: "NO_ROUTE", blockedReason: "No legal route under the current road state" } }),
                    prisma.virtualTrip.update({ where: { virtualTripId: state.virtualTripId }, data: { state: "NO_ROUTE", commandVersion: { increment: 1 } } }),
                ]);
            }
        }
        if (state) await prisma.virtualOperatorEvent.create({ data: { scenarioId: state.scenarioId, virtualTripId: state.virtualTripId, actorId: actorId ?? null, eventType: input.enabled ? "FOLLOWING_ENABLED" : "FOLLOWING_DISABLED", payload: json({ vehicleId: vehicleId.toString(), enabled: input.enabled, policyVersion: settings.policyVersion }) } });
        return { settings, state: await activeVehicleState(vehicleId) };
    },

    async rerouteFromCurrentPosition(vehicleId: bigint, state?: Awaited<ReturnType<typeof activeVehicleState>>, options: RerouteOptions = {}) {
        const current = state ?? await activeVehicleState(vehicleId);
        if (!current) return null;
        const vehicle = await getVirtualVehicle(vehicleId);
        const remainingWaypoints = current.trip.waypoints
            .filter((waypoint) => waypoint.status !== "REACHED")
            .map((waypoint) => point(waypoint.originalPoint));
        const currentPosition = point(current.lastPosition);
        const continuation = forwardContinuationForReroute(current, currentPosition);
        const routeInput = {
            // Start the graph solve at the forward endpoint of the edge the
            // vehicle currently occupies.  The edge remainder is prefixed to
            // the returned route below, so the vehicle keeps moving from its
            // real checkpoint while A* searches only the legal continuation.
            origin: continuation?.origin ?? currentPosition,
            destination: options.destination ?? point(current.trip.destination),
            waypoints: remainingWaypoints,
            vehicleProfile: profileForVehicle(vehicle),
            ...(options.preloadedOverlay ?? await restrictionOverlay(current.scenarioId)),
        };
        let route;
        try {
            route = await routingInternalClient.route({
                ...routeInput,
                ...(current.currentEdgeId ? { avoidInitialReverseOfEdgeId: current.currentEdgeId } : {}),
            });
        } catch (error) {
            // A closure can leave only a U-turn route. Prefer a forward
            // continuation, but retain a legal fallback when reversing is the
            // only way to reach the destination.
            if (!(error instanceof AppError) || error.code !== "ROUTE_NOT_FOUND" || !current.currentEdgeId) throw error;
            route = await routingInternalClient.route(routeInput);
        }
        route = anchorRerouteAtPosition(route, currentPosition, continuation);
        const scenario = await getScenario(current.scenarioId);
        return prisma.$transaction(async (tx) => {
            const latestTrip = await tx.virtualTrip.findUnique({ where: { virtualTripId: current.virtualTripId }, include: { stateRecord: true } });
            if (!latestTrip || !latestTrip.stateRecord || latestTrip.stateRecord.commandVersion !== current.commandVersion
                || (options.expectedTripRevision !== undefined && latestTrip.tripRevision !== options.expectedTripRevision)) return null;
            await tx.virtualRoute.updateMany({ where: { virtualTripId: current.virtualTripId, isCurrent: true }, data: { isCurrent: false } });
            const nextVersion = latestTrip.routeVersion + 1;
            const nextRoute = await tx.virtualRoute.create({
                data: {
                    virtualTripId: current.virtualTripId,
                    routeVersion: nextVersion,
                    routeType: "RECALCULATED",
                    routeGeojson: json(route.routeGeojson),
                    directedItinerary: json(route.directedItinerary),
                    distanceM: route.distanceM,
                    durationSec: route.durationSec,
                    restrictionRevision: scenario.restrictionRevision,
                    graphVersion: route.graphVersion,
                    reason: "FOLLOWING_ENABLED",
                    activatedAt: new Date(),
                },
            });
            const motionState = latestTrip.stateRecord.simStatus === "PAUSED" ? "PAUSED" : "DRIVING";
            const nextEdgeId = itineraryEdge(route.directedItinerary, "edgeId");
            const nextPhysicalSegmentId = itineraryEdge(route.directedItinerary, "physicalSegmentId");
            await tx.virtualTrip.update({
                where: { virtualTripId: current.virtualTripId },
                data: {
                    activeRouteId: nextRoute.routeId,
                    routeVersion: nextVersion,
                    state: motionState,
                    commandVersion: { increment: 1 },
                    ...(options.destination ? { destination: json(options.destination), tripRevision: { increment: 1 } } : {}),
                },
            });
            await tx.virtualVehicleState.update({ where: { vehicleId }, data: { activeRouteId: nextRoute.routeId, routeVersion: nextVersion, graphVersion: route.graphVersion, simStatus: motionState, simElapsedMs: 0, currentEdgeId: nextEdgeId, currentPhysicalSegmentId: nextPhysicalSegmentId, offsetM: 0, lastCheckpointAt: new Date(), blockedReason: null, commandVersion: { increment: 1 } } });
            await createEvent(tx, { scenarioId: current.scenarioId, virtualTripId: current.virtualTripId, actorId: options.actorId ?? null, eventType: "ROUTE_RECALCULATED", payload: { reason: options.reason ?? "FOLLOWING_ENABLED", routeVersion: nextVersion } });
            return nextRoute;
        }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15000 });
    },

    async replaceWaypoints(tripId: bigint, input: WaypointsBody, actorId?: bigint) {
        const trip = await prisma.virtualTrip.findUnique({ where: { virtualTripId: tripId }, include: { waypoints: true } });
        if (!trip) throw new AppError(404, "Virtual trip not found", "VIRTUAL_TRIP_NOT_FOUND");
        if (trip.tripRevision !== input.expectedTripRevision) throw new AppError(409, "Trip changed; refresh waypoints", "STALE_TRIP_REVISION");
        const reached = trip.waypoints.filter((item) => item.status === "REACHED");
        await prisma.$transaction(async (tx) => {
            await tx.virtualTripWaypoint.deleteMany({ where: { virtualTripId: tripId, status: "PENDING" } });
            await tx.virtualTripWaypoint.createMany({ data: input.waypoints.map((item, index) => ({ virtualTripId: tripId, sequence: reached.length + index, originalPoint: json(item), clientId: item.clientId ?? null })) });
            await tx.virtualTrip.update({ where: { virtualTripId: tripId }, data: { tripRevision: { increment: 1 }, commandVersion: { increment: 1 } } });
            await createEvent(tx, { scenarioId: trip.scenarioId, virtualTripId: tripId, actorId: actorId ?? null, eventType: "WAYPOINTS_REPLACED", payload: { count: input.waypoints.length } });
        });
        const settings = await ensureSettings(trip.vehicleId);
        if (settings.autoFollowEnabled && trip.state === "DRIVING") await this.rerouteFromCurrentPosition(trip.vehicleId);
        return this.getTrip(tripId);
    },

    async replaceDestination(tripId: bigint, input: DestinationBody, actorId?: bigint) {
        const trip = await prisma.virtualTrip.findUnique({ where: { virtualTripId: tripId }, include: { stateRecord: true } });
        if (!trip || !trip.stateRecord) throw new AppError(404, "Virtual trip not found", "VIRTUAL_TRIP_NOT_FOUND");
        if (!["COMPLETED", "CANCELLED"].includes(trip.state) && trip.tripRevision !== input.expectedTripRevision) {
            throw new AppError(409, "Trip changed; refresh the destination", "STALE_TRIP_REVISION");
        }
        if (["COMPLETED", "CANCELLED"].includes(trip.state)) throw new AppError(409, "Virtual trip is terminal", "TRIP_TERMINAL");
        const state = await activeVehicleState(trip.vehicleId);
        if (!state || state.virtualTripId !== tripId) throw new AppError(409, "Virtual trip is no longer active", "TRIP_NOT_ACTIVE");
        const route = await this.rerouteFromCurrentPosition(trip.vehicleId, state, {
            destination: input.destination,
            expectedTripRevision: input.expectedTripRevision,
            reason: "DESTINATION_CHANGED",
            ...(actorId === undefined ? {} : { actorId }),
        });
        if (!route) throw new AppError(409, "Trip changed while recalculating the destination", "STALE_TRIP_REVISION");
        return this.getTrip(tripId);
    },

    async previewRestriction(scenarioId: bigint, input: RestrictionBody) {
        const scenario = await getScenario(scenarioId);
        const restrictionInput = input.penaltyFactor === undefined ? { geometry: input.geometry } : { geometry: input.geometry, penaltyFactor: input.penaltyFactor };
        const resolved = await routingInternalClient.resolveRestriction(restrictionInput);
        const states = await prisma.virtualVehicleState.findMany({ where: { scenarioId }, select: { vehicleId: true, currentEdgeId: true, currentPhysicalSegmentId: true } });
        const occupied = occupiedVehicleIds(states, resolved);
        return { ...resolved, scenarioId, restrictionRevision: scenario.restrictionRevision, kind: input.kind, canActivate: input.kind !== "BLOCKED" || occupied.length === 0, occupyingVirtualVehicleIds: occupied };
    },

    async createRestriction(scenarioId: bigint, input: RestrictionBody, actorId?: bigint) {
        const scenario = await getScenario(scenarioId);
        if (input.expectedRestrictionRevision !== undefined && input.expectedRestrictionRevision !== scenario.restrictionRevision) throw new AppError(409, "Scenario restrictions changed", "STALE_REVISION");
        const restrictionInput = input.penaltyFactor === undefined ? { geometry: input.geometry } : { geometry: input.geometry, penaltyFactor: input.penaltyFactor };
        const resolved = await routingInternalClient.resolveRestriction(restrictionInput);
        const states = await prisma.virtualVehicleState.findMany({ where: { scenarioId }, select: { vehicleId: true, currentEdgeId: true, currentPhysicalSegmentId: true } });
        const occupied = occupiedVehicleIds(states, resolved);
        if (input.kind === "BLOCKED" && occupied.length) throw new AppError(409, `Blocked road is occupied by virtual vehicles: ${occupied.join(", ")}`, "ROAD_OCCUPIED");
        const revision = scenario.restrictionRevision + 1;
        const restriction = await prisma.$transaction(async (tx) => {
            const restriction = await tx.virtualRoadRestriction.create({ data: { scenarioId, kind: input.kind, geometry: json(input.geometry), affectedDirectedEdgeIds: json(resolved.affectedDirectedEdgeIds), affectedPhysicalSegmentIds: json(resolved.affectedPhysicalSegmentIds), graphVersion: resolved.graphVersion, penaltyFactor: input.penaltyFactor ?? null, revision, reason: input.reason ?? null, createdBy: actorId ?? null } });
            await tx.virtualScenario.update({ where: { scenarioId }, data: { restrictionRevision: revision } });
            await createEvent(tx, { scenarioId, actorId: actorId ?? null, eventType: "ROAD_RESTRICTION_ACTIVATED", payload: { restrictionId: restriction.restrictionId.toString(), kind: input.kind, revision } });
            return restriction;
        });
        await this.refreshFollowingTrips(scenarioId);
        return restriction;
    },

    async updateRestriction(restrictionId: bigint, input: RestrictionUpdateBody, actorId?: bigint) {
        const existing = await prisma.virtualRoadRestriction.findUnique({ where: { restrictionId } });
        if (!existing) throw new AppError(404, "Road restriction not found", "RESTRICTION_NOT_FOUND");
        const scenario = await getScenario(existing.scenarioId);
        if (input.expectedRestrictionRevision !== undefined && input.expectedRestrictionRevision !== scenario.restrictionRevision) throw new AppError(409, "Scenario restrictions changed", "STALE_REVISION");
        if (input.isActive === false && input.geometry === undefined && input.kind === undefined) {
            const deactivated = await prisma.$transaction(async (tx) => {
                const result = await tx.virtualRoadRestriction.update({ where: { restrictionId }, data: { isActive: false, updatedAt: new Date() } });
                await tx.virtualScenario.update({ where: { scenarioId: existing.scenarioId }, data: { restrictionRevision: { increment: 1 } } });
                await createEvent(tx, { scenarioId: existing.scenarioId, actorId: actorId ?? null, eventType: "ROAD_RESTRICTION_DEACTIVATED", payload: { restrictionId: restrictionId.toString() } });
                return result;
            });
            // Reopening a region must never turn an already moving trip into
            // NO_ROUTE just because the optional refresh solve timed out or
            // temporarily failed.  The simulation worker still guards every
            // step against the remaining active BLOCKED edges, so retaining
            // the last valid route is safe while a later road-state change or
            // operator action retries the calculation.
            await this.refreshFollowingTrips(existing.scenarioId, { preserveMotionOnFailure: true });
            return deactivated;
        }
        const kind = input.kind ?? existing.kind;
        const geometry = input.geometry ?? existing.geometry;
        const penaltyFactor = input.penaltyFactor === undefined ? existing.penaltyFactor : input.penaltyFactor;
        if (kind === "BLOCKED" && penaltyFactor !== null) throw new AppError(400, "Blocked restrictions cannot have a penalty factor", "INVALID_RESTRICTION");
        if (kind === "HEAVY_PENALTY" && (penaltyFactor === null || penaltyFactor <= 1)) throw new AppError(400, "Heavy penalty requires a factor greater than one", "INVALID_RESTRICTION");
        const resolved = await routingInternalClient.resolveRestriction(penaltyFactor === null ? { geometry } : { geometry, penaltyFactor });
        const states = await prisma.virtualVehicleState.findMany({ where: { scenarioId: existing.scenarioId }, select: { vehicleId: true, currentEdgeId: true, currentPhysicalSegmentId: true } });
        const occupied = occupiedVehicleIds(states, resolved);
        if (kind === "BLOCKED" && occupied.length) throw new AppError(409, `Blocked road is occupied by virtual vehicles: ${occupied.join(", ")}`, "ROAD_OCCUPIED");
        const revision = scenario.restrictionRevision + 1;
        const updated = await prisma.$transaction(async (tx) => {
            const result = await tx.virtualRoadRestriction.update({ where: { restrictionId }, data: { kind, geometry: json(geometry), affectedDirectedEdgeIds: json(resolved.affectedDirectedEdgeIds), affectedPhysicalSegmentIds: json(resolved.affectedPhysicalSegmentIds), graphVersion: resolved.graphVersion, penaltyFactor, revision, isActive: input.isActive ?? true, reason: input.reason === undefined ? existing.reason : input.reason, updatedAt: new Date() } });
            await tx.virtualScenario.update({ where: { scenarioId: existing.scenarioId }, data: { restrictionRevision: revision } });
            await createEvent(tx, { scenarioId: existing.scenarioId, actorId: actorId ?? null, eventType: "ROAD_RESTRICTION_UPDATED", payload: { restrictionId: restrictionId.toString(), kind, revision } });
            return result;
        });
        await this.refreshFollowingTrips(existing.scenarioId);
        return updated;
    },

    async refreshFollowingTrips(scenarioId: bigint, options: { preserveMotionOnFailure?: boolean } = {}) {
        const states = await prisma.virtualVehicleState.findMany({ where: { scenarioId, simStatus: { in: ["DRIVING", "BLOCKED_AWAITING_OPERATOR", "NO_ROUTE"] } }, include: { trip: { include: { routes: { where: { isCurrent: true } }, waypoints: { orderBy: { sequence: "asc" } } } } } });
        const settings = await prisma.virtualVehicleSettings.findMany({ where: { vehicleId: { in: states.map((state) => state.vehicleId) }, autoFollowEnabled: true } });
        const following = new Set(settings.map((item) => item.vehicleId.toString()));
        const eligibleStates = states.filter((state) => following.has(state.vehicleId.toString()) && state.trip.state !== "PAUSED");
        if (eligibleStates.length === 0) return;
        // Fetch the restriction overlay once and share it across all vehicle
        // reroutes - all vehicles in the same scenario see the same restrictions,
        // so N per-vehicle DB queries for identical data is pure waste.
        const preloadedOverlay = await restrictionOverlay(scenarioId);
        // A road-state change affects vehicles independently. Solving them
        // serially made the response time grow linearly with fleet size, but
        // firing an unbounded number of CPU-heavy A* requests would overload
        // the routing service. Four in-flight solves keep updates close to
        // real time while preserving a bounded resource footprint.
        // VIRTUAL_REROUTE_CONCURRENCY overrides the default for larger fleets.
        const concurrency = Math.min(
            Math.max(1, parseInt(process.env["VIRTUAL_REROUTE_CONCURRENCY"] ?? "4", 10) || 4),
            16,
        );
        let nextStateIndex = 0;
        const processState = async (state: typeof states[number]) => {
            try {
                let currentState = state;
                // The 250 ms simulation tick can checkpoint or stop on the
                // newly blocked edge while the solver is running.  A stale
                // command-version CAS is expected in that race; resnapshot
                // once and solve from the newest authoritative position.
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const activated = await this.rerouteFromCurrentPosition(state.vehicleId, currentState, { preloadedOverlay });
                    if (activated) return;
                    const latest = await activeVehicleState(state.vehicleId);
                    if (!latest || ["COMPLETED", "CANCELLED"].includes(latest.trip.state)) return;
                    currentState = latest;
                }
                // Another command won the CAS.  Its route/state is already
                // authoritative, so do not overwrite it with NO_ROUTE.
                return;
            } catch (error) {
                const latest = await activeVehicleState(state.vehicleId);
                if (!latest || ["COMPLETED", "CANCELLED"].includes(latest.trip.state)) return;
                if (options.preserveMotionOnFailure) {
                    // Deactivation can only make the road overlay less
                    // restrictive. Keep the current motion/hold state if the
                    // best-effort refresh cannot complete; the worker's
                    // closure guard continues to prevent entry into any
                    // other active blocked region.
                    return;
                }
                const noViablePath = error instanceof AppError && error.code === "ROUTE_NOT_FOUND";
                await prisma.$transaction([
                    prisma.virtualVehicleState.updateMany({ where: { vehicleId: state.vehicleId, simStatus: { in: ["DRIVING", "BLOCKED_AWAITING_OPERATOR", "NO_ROUTE"] } }, data: { simStatus: "NO_ROUTE", blockedReason: noViablePath ? "No viable path after road restriction" : "Routing failed after road-state change" } }),
                    prisma.virtualTrip.updateMany({ where: { virtualTripId: latest.virtualTripId, state: { in: ACTIVE_TRIP_STATES } }, data: { state: "NO_ROUTE", commandVersion: { increment: 1 } } }),
                ]);
            }
        };
        const workerCount = Math.min(concurrency, eligibleStates.length);
        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (true) {
                const index = nextStateIndex++;
                if (index >= eligibleStates.length) return;
                await processState(eligibleStates[index]!);
            }
        }));
    },

    async listEvents(scenarioId: bigint, after?: bigint) {
        await getScenario(scenarioId);
        return prisma.virtualOperatorEvent.findMany({ where: { scenarioId, ...(after ? { eventId: { gt: after } } : {}) }, orderBy: { eventId: "asc" }, take: 500 });
    },
};
