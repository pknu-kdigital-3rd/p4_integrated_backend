import { prisma } from "../../infrastructure/database/prisma.ts";
import { AppError } from "../../common/errors/app-error.ts";
import { trackingClient, type TelemetryMode, type TrackingSnapshot } from "./tracking.client.ts";
import { persistAuthoritativeObservations } from "./tracking.persistence.ts";

type Observation = TrackingSnapshot["vehicles"][number];

const deviceTelemetrySources = new Set<Observation["telemetry_source"]>(["DEVICE_GPS", "RECORDED_GPS"]);
const positiveId = /^[1-9][0-9]{0,18}$/;

const routeSelect = {
    where: { isCurrent: true }, take: 1, orderBy: { routeVersion: "desc" as const },
    select: { routeId: true, routeSource: true, routeGeojson: true, sourceMetadata: true },
};
const vehicleSelect = {
    vehicleId: true, externalId: true, vehicleCode: true, vehicleName: true, vehicleSource: true, vehicleStatus: true,
};

export function isDeviceObservation(observation: Observation): boolean {
    return deviceTelemetrySources.has(observation.telemetry_source);
}

function metadataId(observation: Observation, key: "vehicleId" | "tripId"): bigint | null {
    const value = observation.source_metadata?.[key];
    return typeof value === "string" && positiveId.test(value) ? BigInt(value) : null;
}

/**
 * Android/device observations name an existing project vehicle and the exact
 * trip it is driving. They are resolved to that Vehicle row - never upserted as
 * a BIMS identity - and the explicit trip selects the planned route instead of
 * guessing the most recent active trip.
 */
async function resolveDeviceObservation(observation: Observation) {
    const vehicleId = metadataId(observation, "vehicleId");
    const tripId = metadataId(observation, "tripId");
    if (vehicleId === null || tripId === null) {
        return { warning: { code: "DEVICE_IDENTITY_MISSING", externalId: observation.external_id } };
    }
    const vehicle = await prisma.vehicle.findUnique({
        where: { vehicleId },
        select: { ...vehicleSelect, trips: { where: { tripId }, take: 1, select: { tripId: true, routes: routeSelect } } },
    });
    const trip = vehicle?.trips[0];
    if (!vehicle || !trip) {
        return { warning: { code: "DEVICE_IDENTITY_UNRESOLVED", externalId: observation.external_id, vehicleId: String(vehicleId), tripId: String(tripId) } };
    }
    return { vehicle: { ...vehicle, trips: undefined, tripId: trip.tripId, plannedRoute: trip.routes[0] ?? null, telemetry: observation } };
}

export const trackingService = {
    async getVehicles() {
        const snapshot = await trackingClient.snapshot();
        const bimsObservations = snapshot.vehicles.filter(item => !isDeviceObservation(item));
        const deviceObservations = snapshot.vehicles.filter(isDeviceObservation);
        const identities = await Promise.all(bimsObservations.map(item => prisma.vehicle.upsert({
            where: { vehicleSource_externalId: { vehicleSource: "BIMS", externalId: item.external_id } },
            update: { vehicleStatus: "DRIVING" },
            create: {
                vehicleCode: `BIMS-${item.external_id}`.slice(0, 50),
                vehicleName: `BIMS Vehicle ${item.external_id}`,
                vehicleSource: "BIMS",
                externalId: item.external_id,
                vehicleStatus: "DRIVING",
            },
            select: {
                ...vehicleSelect,
                trips: {
                    where: { tripStatus: { in: ["READY", "IN_PROGRESS", "PAUSED"] } }, take: 1, orderBy: { createdAt: "desc" },
                    select: { tripId: true, routes: routeSelect },
                },
            },
        })));
        const byExternalId = new Map(identities.map(item => [item.externalId, item]));
        // BIMS history is still persisted as a side effect of this read (to be
        // moved to an ingest path later). Device GPS is never persisted here: the
        // relay already writes every fix through POST /internal/telemetry/gps,
        // independent of whether anyone polls this endpoint.
        persistAuthoritativeObservations(identities, { ...snapshot, vehicles: bimsObservations });
        const bimsVehicles = bimsObservations.map(telemetry => {
            const identity = byExternalId.get(telemetry.external_id);
            const trip = identity?.trips[0];
            return { ...identity, trips: undefined, tripId: trip?.tripId, plannedRoute: trip?.routes[0] ?? null, telemetry };
        });
        const resolved = await Promise.all(deviceObservations.map(resolveDeviceObservation));
        const deviceVehicles = resolved.flatMap(item => item.vehicle ? [item.vehicle] : []);
        const deviceWarnings = resolved.flatMap(item => item.warning ? [item.warning] : []);
        return {
            ...snapshot,
            vehicles: [...bimsVehicles, ...deviceVehicles],
            warnings: [...snapshot.warnings, ...deviceWarnings],
        };
    },

    async getVehicle(vehicleId: bigint) {
        const vehicle = await prisma.vehicle.findUnique({ where: { vehicleId } });
        if (!vehicle) throw new AppError(404, "Vehicle not found", "VEHICLE_NOT_FOUND");
        if (!vehicle.externalId) return { vehicle, telemetry: null };
        return { vehicle, telemetry: await trackingClient.vehicle(vehicle.externalId) };
    },

    async getTelemetryMode() {
        return trackingClient.telemetryMode();
    },

    async setTelemetryMode(mode: TelemetryMode) {
        return trackingClient.setTelemetryMode(mode);
    },

    async getPlannedRoute(tripId: bigint) {
        const route = await prisma.route.findFirst({
            where: { tripId, isCurrent: true },
            orderBy: { routeVersion: "desc" },
            select: { routeId: true, tripId: true, routeSource: true, sourceMetadata: true, routeGeojson: true, distanceM: true, durationSec: true },
        });
        if (!route) throw new AppError(404, "Planned route not found", "ROUTE_NOT_FOUND");
        return route;
    },
};
