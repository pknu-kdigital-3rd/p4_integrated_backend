import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";

export type DeviceGpsRow = {
    vehicleId: bigint;
    tripId: bigint;
    longitude: number;
    latitude: number;
    speedKmh: number | null;
    headingDeg: number | null;
    recordedAt: Date;
    telemetrySource: "RECORDED_GPS" | "DEVICE_GPS";
    recordingSessionId: string;
    sourceTimestampNs: bigint;
    altitudeM: number | null;
    horizontalAccuracyM: number | null;
    receivedAt: Date;
};

/**
 * Multi-row form of prisma/sql/insertDeviceGpsPosition.sql. One source fix is
 * one row; duplicates of (recording_session_id, source_timestamp_ns) from relay
 * retries are skipped. Returns the number of rows actually inserted.
 */
export async function insertDeviceGpsPositions(rows: DeviceGpsRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const values = rows.map(row => Prisma.sql`(
        ${row.vehicleId}, ${row.tripId},
        ST_SetSRID(ST_MakePoint(${row.longitude}, ${row.latitude}), 4326)::geography,
        ${row.speedKmh}, ${row.headingDeg}, ${row.recordedAt}, ${row.telemetrySource},
        ${row.recordingSessionId}, ${row.sourceTimestampNs}, ${row.altitudeM}, ${row.horizontalAccuracyM}, ${row.receivedAt}
    )`);
    const inserted = await prisma.$queryRaw<Array<{ positionId: bigint }>>(Prisma.sql`
        INSERT INTO vehicle_position (
            vehicle_id, trip_id, location, speed_kmh, heading_deg, recorded_at, telemetry_source,
            recording_session_id, source_timestamp_ns, altitude_m, horizontal_accuracy_m, received_at
        )
        VALUES ${Prisma.join(values)}
        ON CONFLICT (recording_session_id, source_timestamp_ns) DO NOTHING
        RETURNING position_id AS "positionId"
    `);
    return inserted.length;
}

/** True when this recording session was already bound to a different trip or vehicle. */
export async function sessionBoundElsewhere(recordingSessionId: string, tripId: bigint, vehicleId: bigint): Promise<boolean> {
    const [position, video] = await Promise.all([
        prisma.$queryRaw<Array<{ found: number }>>(Prisma.sql`
            SELECT 1 AS found FROM vehicle_position
            WHERE recording_session_id = ${recordingSessionId}
              AND (trip_id IS DISTINCT FROM ${tripId} OR vehicle_id <> ${vehicleId})
            LIMIT 1
        `),
        prisma.tripVideo.findFirst({
            where: { recordingSessionId, NOT: { tripId } },
            select: { tripVideoId: true },
        }),
    ]);
    return position.length > 0 || video !== null;
}
