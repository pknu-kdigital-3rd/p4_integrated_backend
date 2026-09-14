import { prisma } from "../../infrastructure/database/prisma.ts";
import { AppError } from "../../common/errors/app-error.ts";
import { trackingClient } from "./tracking.client.ts";
import { persistAuthoritativeObservations } from "./tracking.persistence.ts";

export const trackingService = {
    async getVehicles() {
        const snapshot = await trackingClient.snapshot();
        const identities = await Promise.all(snapshot.vehicles.map(item => prisma.vehicle.upsert({
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
                vehicleId: true, externalId: true, vehicleCode: true, vehicleName: true, vehicleSource: true, vehicleStatus: true,
                trips: {
                    where: { tripStatus: { in: ["READY", "IN_PROGRESS", "PAUSED"] } }, take: 1, orderBy: { createdAt: "desc" },
                    select: { tripId: true, routes: { where: { isCurrent: true }, take: 1, orderBy: { routeVersion: "desc" }, select: { routeId: true, routeSource: true, routeGeojson: true, sourceMetadata: true } } },
                },
            },
        })));
        const byExternalId = new Map(identities.map(item => [item.externalId, item]));
        persistAuthoritativeObservations(identities, snapshot);
        return {
            ...snapshot,
            vehicles: snapshot.vehicles.map(telemetry => {
                const identity = byExternalId.get(telemetry.external_id);
                const trip = identity?.trips[0];
                return { ...identity, trips: undefined, tripId: trip?.tripId, plannedRoute: trip?.routes[0] ?? null, telemetry };
            }),
        };
    },

    async getVehicle(vehicleId: bigint) {
        const vehicle = await prisma.vehicle.findUnique({ where: { vehicleId } });
        if (!vehicle) throw new AppError(404, "Vehicle not found", "VEHICLE_NOT_FOUND");
        if (!vehicle.externalId) return { vehicle, telemetry: null };
        return { vehicle, telemetry: await trackingClient.vehicle(vehicle.externalId) };
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
