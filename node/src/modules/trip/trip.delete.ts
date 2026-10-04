import { AppError } from "../../common/errors/app-error.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";

export async function deleteTrip(tripIdValue: string) {
    if (!/^[1-9][0-9]{0,18}$/.test(tripIdValue) || BigInt(tripIdValue) > 9_223_372_036_854_775_807n) {
        throw new AppError(400, "Invalid trip ID", "INVALID_ID");
    }
    const tripId = BigInt(tripIdValue);
    return prisma.$transaction(async tx => {
        // Serialize state changes and block new FK-linked recording inserts
        // while checking dependencies and removing this trip.
        const rows = await tx.$queryRaw<Array<{ tripStatus: string }>>`
            SELECT trip_status AS "tripStatus" FROM trip WHERE trip_id = ${tripId} FOR UPDATE`;
        if (!rows.length) throw new AppError(404, "Trip not found", "TRIP_NOT_FOUND");
        if (!["COMPLETED", "CANCELLED"].includes(rows[0]!.tripStatus)) {
            throw new AppError(409, "Cancel the active trip before deleting it", "TRIP_NOT_FINISHED");
        }
        // Object storage is removed through recording deletion before this
        // transaction. Never drop metadata that still owns a stored video.
        if (await tx.tripVideo.count({ where: { tripId, NOT: { storageBucket: "legacy", uploadStatus: "FAILED" } } })) {
            throw new AppError(409, "Trip recordings remain. Delete the remaining recordings before deleting the trip.", "TRIP_RECORDINGS_REMAIN");
        }
        // An alert must have exactly one cause. Removing its trip/deviation
        // cause with SET NULL would violate that CHECK, so remove those alerts.
        await tx.alert.deleteMany({ where: { OR: [{ tripId }, { routeDeviation: { tripId } }] } });
        await tx.routeDeviation.deleteMany({ where: { tripId } });
        await tx.route.deleteMany({ where: { tripId } });
        await tx.tripVideoDetectionSample.deleteMany({ where: { tripId } });
        // Migrated failed legacy rows are references, not managed MinIO objects.
        await tx.tripVideo.deleteMany({ where: { tripId, storageBucket: "legacy", uploadStatus: "FAILED" } });
        // Retain independent vehicle history and goals, clearing their trip link.
        await tx.vehiclePosition.updateMany({ where: { tripId }, data: { tripId: null } });
        await tx.detectionEvent.updateMany({ where: { tripId }, data: { tripId: null } });
        await tx.transportGoal.updateMany({ where: { assignedTripId: tripId }, data: { assignedTripId: null } });
        await tx.trip.delete({ where: { tripId } });
        return { tripId: tripIdValue, deleted: true as const };
    }, { timeout: 30_000 });
}
