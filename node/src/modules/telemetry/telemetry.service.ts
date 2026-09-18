import { AppError } from "../../common/errors/app-error.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import { insertDeviceGpsPositions, sessionBoundElsewhere, type DeviceGpsRow } from "./telemetry.persistence.ts";
import type { DeviceGpsBatchBody, TelemetryMode } from "./telemetry.schema.ts";

// The relay stamps receivedAt; allow small clock skew between same-host services.
const maxReceivedAtSkewMs = 5 * 60 * 1000;

export function telemetrySourceForMode(mode: TelemetryMode): "RECORDED_GPS" | "DEVICE_GPS" {
    return mode === "LIVE" ? "DEVICE_GPS" : "RECORDED_GPS";
}

export const telemetryService = {
    /**
     * Persists authoritative GPS fixes forwarded by the relay. Identity is
     * checked against the database, never trusted: the trip must exist and
     * belong to the vehicle, and a recording session may only ever belong to one
     * trip/vehicle. Vehicles are never created from telemetry.
     */
    async ingestDeviceGps(batch: DeviceGpsBatchBody) {
        const tripId = BigInt(batch.tripId);
        const vehicleId = BigInt(batch.vehicleId);
        const receivedAt = new Date(batch.receivedAt);
        if (receivedAt.getTime() - Date.now() > maxReceivedAtSkewMs) {
            throw new AppError(400, "receivedAt is in the future", "INVALID_TELEMETRY_RECEIVED_AT");
        }

        const trip = await prisma.trip.findUnique({ where: { tripId }, select: { vehicleId: true } });
        if (!trip || trip.vehicleId !== vehicleId) {
            throw new AppError(409, "Trip does not belong to this vehicle", "TELEMETRY_TRIP_MISMATCH");
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
