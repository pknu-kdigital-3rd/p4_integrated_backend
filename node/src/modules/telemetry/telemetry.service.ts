import { AppError } from "../../common/errors/app-error.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import { insertDeviceGpsPositions, sessionBoundElsewhere, type DeviceGpsRow } from "./telemetry.persistence.ts";
import type { DeviceGpsBatchBody, TelemetryMode, VehicleStreamContextBody } from "./telemetry.schema.ts";

// The relay stamps receivedAt; allow small clock skew between same-host services.
const maxReceivedAtSkewMs = 5 * 60 * 1000;

export function telemetrySourceForMode(mode: TelemetryMode): "RECORDED_GPS" | "DEVICE_GPS" {
    return mode === "LIVE" ? "DEVICE_GPS" : "RECORDED_GPS";
}

async function requireActiveVehicle(vehicleId: bigint) {
    const vehicle = await prisma.vehicle.findUnique({ where: { vehicleId }, select: { isActive: true } });
    if (!vehicle?.isActive) throw new AppError(404, "Active vehicle not found", "VEHICLE_NOT_FOUND");
}

export const telemetryService = {
    /** The relay's identity check for a stream that names a vehicle but no trip. */
    async validateVehicleContext(context: VehicleStreamContextBody) {
        await requireActiveVehicle(BigInt(context.vehicleId));
        return context;
    },

    /**
     * Persists authoritative GPS fixes forwarded by the relay. Identity is
     * checked against the database, never trusted: the trip must exist and
     * belong to the vehicle, and a recording session may only ever belong to one
     * trip/vehicle. A batch without a trip is stored with trip_id NULL, so the
     * vehicle's position history continues while no trip is running. Vehicles
     * are never created from telemetry.
     */
    async ingestDeviceGps(batch: DeviceGpsBatchBody) {
        const tripId = batch.tripId === undefined ? null : BigInt(batch.tripId);
        const vehicleId = BigInt(batch.vehicleId);
        const receivedAt = new Date(batch.receivedAt);
        if (receivedAt.getTime() - Date.now() > maxReceivedAtSkewMs) {
            throw new AppError(400, "receivedAt is in the future", "INVALID_TELEMETRY_RECEIVED_AT");
        }

        if (tripId === null) {
            await requireActiveVehicle(vehicleId);
        } else {
            const trip = await prisma.trip.findUnique({ where: { tripId }, select: { vehicleId: true } });
            if (!trip || trip.vehicleId !== vehicleId) {
                throw new AppError(409, "Trip does not belong to this vehicle", "TELEMETRY_TRIP_MISMATCH");
            }
        }
        if (await sessionBoundElsewhere(batch.recordingSessionId, tripId, vehicleId)) {
            throw new AppError(409, "Recording session belongs to a different trip or vehicle", "TELEMETRY_SESSION_MISMATCH");
        }

        const telemetrySource = telemetrySourceForMode(batch.mode);
        const rows: DeviceGpsRow[] = batch.samples.map(sample => ({
            vehicleId,
            tripId,
            longitude: sample.longitude,
            latitude: sample.latitude,
            speedKmh: sample.speedMps == null ? null : Math.round(sample.speedMps * 3.6 * 100) / 100,
            headingDeg: sample.bearingDeg ?? null,
            // recorded_at is the source UTC observation time. For REPLAY this is
            // the original recording's date, deliberately distinct from receivedAt.
            recordedAt: sample.utcEpochMs == null ? receivedAt : new Date(Number(BigInt(sample.utcEpochMs))),
            telemetrySource,
            recordingSessionId: batch.recordingSessionId,
            sourceTimestampNs: BigInt(sample.sourceTimestampNs),
            altitudeM: sample.altitudeM ?? null,
            horizontalAccuracyM: sample.horizontalAccuracyM ?? null,
            receivedAt,
        }));
        const inserted = await insertDeviceGpsPositions(rows);
        return {
            accepted: rows.length,
            inserted,
            duplicates: rows.length - inserted,
            telemetrySource,
        };
    },
};
