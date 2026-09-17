import { createTrip } from "../../generated/prisma/sql/createTrip.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import type { CreateTripBody } from "./trip.schema.ts";

const tripSelect = {
    tripId: true,
    vehicleId: true,
    originName: true,
    destinationName: true,
    tripStatus: true,
    plannedStartAt: true,
    startedAt: true,
    createdAt: true,
    vehicle: {
        select: {
            vehicleId: true,
            vehicleCode: true,
            vehicleName: true,
            vehicleStatus: true,
        },
    },
} as const;

export const tripRepository = {
    async findRecent() {
        return prisma.trip.findMany({
            take: 50,
            orderBy: [{ createdAt: "desc" }, { tripId: "desc" }],
            select: tripSelect,
        });
    },

    findVehicle(vehicleId: bigint) {
        return prisma.vehicle.findUnique({
            where: { vehicleId },
            select: { vehicleId: true, isActive: true },
        });
    },

    async create(input: CreateTripBody, startedAt: Date | null) {
        const rows = await prisma.$queryRawTyped(createTrip(
            BigInt(input.vehicleId),
            null,
            input.originName ?? null,
            input.originAddress ?? null,
            input.originLongitude ?? null,
            input.originLatitude ?? null,
            input.destinationName,
            input.destinationAddress ?? null,
            input.destinationLongitude,
            input.destinationLatitude,
            input.plannedStartAt ? new Date(input.plannedStartAt) : null,
            input.tripStatus,
            startedAt,
        ));
        const created = rows[0];
        if (!created) return null;

        return prisma.trip.findUnique({
            where: { tripId: created.tripId },
            select: tripSelect,
        });
    },
};
