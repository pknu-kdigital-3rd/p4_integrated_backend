import { createTrip } from "../../generated/prisma/sql/createTrip.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import { AppError } from "../../common/errors/app-error.ts";
import type { InternalRoute } from "../virtual/routing-internal.client.ts";
import type { CreateTripBody } from "./trip.schema.ts";

export const tripSelect = {
    tripId: true, vehicleId: true, originName: true, destinationName: true,
    tripStatus: true, routeMode: true, replayPreviewId: true,
    plannedStartAt: true, startedAt: true, endedAt: true, createdAt: true,
    vehicle: { select: { vehicleId: true, vehicleCode: true, vehicleName: true, vehicleStatus: true } },
} as const;

export type ResolvedTripInput = CreateTripBody & {
    originLatitude: number; originLongitude: number;
    destinationName: string; destinationLatitude: number; destinationLongitude: number;
};

export const tripRepository = {
    findRecent() {
        return prisma.trip.findMany({ take: 50, orderBy: [{ createdAt: "desc" }, { tripId: "desc" }], select: tripSelect });
    },
    findVehicle(vehicleId: bigint) {
        return prisma.vehicle.findUnique({ where: { vehicleId }, select: {
            vehicleId: true, isActive: true, vehicleSource: true, externalId: true,
            widthM: true, heightM: true,
        } });
    },
    async create(input: ResolvedTripInput, route: InternalRoute | null) {
        const vehicleId = BigInt(input.vehicleId);
        return prisma.$transaction(async tx => {
            await tx.$queryRaw`SELECT vehicle_id FROM vehicle WHERE vehicle_id = ${vehicleId} FOR UPDATE`;
            const occupied = await tx.trip.findFirst({
                where: { vehicleId, tripStatus: { in: ["READY", "IN_PROGRESS", "PAUSED"] } },
                select: { tripId: true },
            });
            if (occupied) throw new AppError(409, `Vehicle already has active Trip ID ${occupied.tripId}`, "VEHICLE_TRIP_CONFLICT");
            const rows = await tx.$queryRawTyped(createTrip(
                vehicleId, null, input.originName ?? null, input.originAddress ?? null,
                input.originLongitude, input.originLatitude, input.destinationName,
                input.destinationAddress ?? null, input.destinationLongitude, input.destinationLatitude,
                input.plannedStartAt ? new Date(input.plannedStartAt) : null,
                input.tripStatus, input.tripStatus === "IN_PROGRESS" ? new Date() : null,
            ));
            const created = rows[0];
            if (!created) throw new AppError(500, "Trip could not be created", "TRIP_CREATE_FAILED");
            await tx.trip.update({ where: { tripId: created.tripId }, data: {
                routeMode: input.routeMode,
                replayPreviewId: input.replayPreviewId ? BigInt(input.replayPreviewId) : null,
            } });
            if (route) {
                const geojson = JSON.stringify(route.routeGeojson);
                await tx.$executeRaw(Prisma.sql`
                    INSERT INTO route (trip_id, route_version, route_type, route_source,
                        source_metadata, distance_m, duration_sec, route_geojson, route_line, is_current)
                    VALUES (${created.tripId}, 1, 'INITIAL', 'OPTIMAL_PATH',
                        ${JSON.stringify({ graphVersion: route.graphVersion, warnings: route.warnings })}::jsonb,
                        ${Math.round(route.distanceM)}, ${Math.round(route.durationSec)},
                        ${geojson}::jsonb, ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)::geography, TRUE)
                `);
            }
            return tx.trip.findUnique({ where: { tripId: created.tripId }, select: tripSelect });
        });
    },
};
