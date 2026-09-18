import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const internalToken = vi.hoisted(() => {
    const token = "telemetry-test-token-0123456789abcdef";
    process.env.ANDROID_TELEMETRY_ENABLED = "true";
    process.env.NODE_INTERNAL_SERVICE_TOKEN = token;
    return token;
});

import { createApp } from "../src/app.ts";
import { prisma } from "../src/infrastructure/database/prisma.ts";
import { resetDatabase } from "./helpers/reset-database.ts";

const app = createApp();

async function createVehicle(code: string) {
    return prisma.vehicle.create({ data: { vehicleCode: code, vehicleStatus: "READY" } });
}

async function createTrip(vehicleId: bigint): Promise<bigint> {
    const rows = await prisma.$queryRaw<Array<{ tripId: bigint }>>`
        INSERT INTO trip (vehicle_id, destination_name, destination_location, trip_status)
        VALUES (${vehicleId}, 'Depot', ST_SetSRID(ST_MakePoint(129.1, 35.1), 4326)::geography, 'IN_PROGRESS')
        RETURNING trip_id AS "tripId"`;
    return rows[0]!.tripId;
}

function batch(overrides: Record<string, unknown> = {}, sample: Record<string, unknown> = {}) {
    return {
        mode: "REPLAY",
        tripId: "0",
        vehicleId: "0",
        recordingSessionId: "session-A",
        receivedAt: "2026-09-18T02:40:15.123Z",
        samples: [{
            sourceTimestampNs: "1445245922681115",
            utcEpochMs: "1787803384795",
            latitude: 35.1329082,
            longitude: 129.1070557,
            altitudeM: 47.3,
            speedMps: 0.7153028,
            bearingDeg: 89.954605,
            horizontalAccuracyM: 2.8,
            ...sample,
        }],
        ...overrides,
    };
}

function post(body: unknown, token: string | null = internalToken) {
    const call = request(app).post("/internal/telemetry/gps");
    if (token !== null) call.set("X-Internal-Service-Token", token);
    return call.send(body as object);
}

type PositionRow = {
    vehicleId: bigint; tripId: bigint; lat: number; lng: number; speedKmh: string; headingDeg: string;
    recordedAt: Date; receivedAt: Date; telemetrySource: string; recordingSessionId: string;
    sourceTimestampNs: bigint; altitudeM: string; horizontalAccuracyM: string;
};

async function positions(): Promise<PositionRow[]> {
    return prisma.$queryRaw<PositionRow[]>`
        SELECT vehicle_id AS "vehicleId", trip_id AS "tripId",
               ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
               speed_kmh::text AS "speedKmh", heading_deg::text AS "headingDeg",
               recorded_at AS "recordedAt", received_at AS "receivedAt", telemetry_source AS "telemetrySource",
               recording_session_id AS "recordingSessionId", source_timestamp_ns AS "sourceTimestampNs",
               altitude_m::text AS "altitudeM", horizontal_accuracy_m::text AS "horizontalAccuracyM"
        FROM vehicle_position ORDER BY position_id`;
}

describe("POST /internal/telemetry/gps", () => {
    let vehicleId: bigint;
    let tripId: bigint;

    beforeAll(async () => {
        await prisma.$queryRaw`SELECT 1`;
    });

    beforeEach(async () => {
        await resetDatabase();
        vehicleId = (await createVehicle("TRUCK-1")).vehicleId;
        tripId = await createTrip(vehicleId);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    const valid = () => batch({ tripId: String(tripId), vehicleId: String(vehicleId) });

    it("requires the internal service token", async () => {
        await post(valid(), null).expect(401);
        await post(valid(), "wrong-token-wrong-token-wrong-token").expect(401);
        expect(await positions()).toHaveLength(0);
    });

    it("persists a REPLAY fix as RECORDED_GPS with source and receive times kept separate", async () => {
        const response = await post(valid()).expect(200);
        expect(response.body.data).toEqual({ accepted: 1, inserted: 1, duplicates: 0, telemetrySource: "RECORDED_GPS" });

        const [row] = await positions();
        expect(row!.vehicleId).toBe(vehicleId);
        expect(row!.tripId).toBe(tripId);
        expect(row!.telemetrySource).toBe("RECORDED_GPS");
        expect(row!.recordingSessionId).toBe("session-A");
        // Exceeds Number.MAX_SAFE_INTEGER precision only if mishandled as a JS number.
        expect(row!.sourceTimestampNs).toBe(1445245922681115n);
        expect(row!.lat).toBeCloseTo(35.1329082, 7);
        expect(row!.lng).toBeCloseTo(129.1070557, 7);
        expect(row!.speedKmh).toBe("2.58");
        expect(row!.headingDeg).toBe("89.95");
        expect(row!.altitudeM).toBe("47.300");
        expect(row!.horizontalAccuracyM).toBe("2.800");
        expect(row!.recordedAt.toISOString()).toBe(new Date(1787803384795).toISOString());
        expect(row!.receivedAt.toISOString()).toBe("2026-09-18T02:40:15.123Z");
    });

    it("persists a LIVE fix as DEVICE_GPS", async () => {
        const response = await post(batch({ mode: "LIVE", tripId: String(tripId), vehicleId: String(vehicleId) })).expect(200);
        expect(response.body.data.telemetrySource).toBe("DEVICE_GPS");
        expect((await positions())[0]!.telemetrySource).toBe("DEVICE_GPS");
    });

    it("is idempotent for a retried source timestamp", async () => {
        await post(valid()).expect(200);
        const retry = await post(valid()).expect(200);
        expect(retry.body.data).toMatchObject({ inserted: 0, duplicates: 1 });
        expect(await positions()).toHaveLength(1);
    });

    it("keeps sessions with overlapping source timestamps separate", async () => {
        const otherTrip = await createTrip(vehicleId);
        await post(valid()).expect(200);
        await post(batch({ tripId: String(otherTrip), vehicleId: String(vehicleId), recordingSessionId: "session-B" })).expect(200);
        const rows = await positions();
        expect(rows.map(row => [row.recordingSessionId, row.tripId])).toEqual([["session-A", tripId], ["session-B", otherTrip]]);
    });

    it("rejects a trip that belongs to another vehicle without creating vehicles", async () => {
        const other = await createVehicle("TRUCK-2");
        const response = await post(batch({ tripId: String(tripId), vehicleId: String(other.vehicleId) })).expect(409);
        expect(response.body.error.code).toBe("TELEMETRY_TRIP_MISMATCH");
        await post(batch({ tripId: "999999", vehicleId: String(vehicleId) })).expect(409);
        expect(await positions()).toHaveLength(0);
        expect(await prisma.vehicle.count()).toBe(2);
    });

    it("rejects reusing a recording session for a different trip", async () => {
        const otherTrip = await createTrip(vehicleId);
        await post(valid()).expect(200);
        const response = await post(batch({ tripId: String(otherTrip), vehicleId: String(vehicleId) }, { sourceTimestampNs: "1445245923681115" })).expect(409);
        expect(response.body.error.code).toBe("TELEMETRY_SESSION_MISMATCH");
    });

    it("validates coordinates, values, and 64-bit strings", async () => {
        const base = { tripId: String(tripId), vehicleId: String(vehicleId) };
        await post(batch(base, { latitude: 91 })).expect(400);
        await post(batch(base, { longitude: -181 })).expect(400);
        await post(batch(base, { speedMps: -1 })).expect(400);
        await post(batch(base, { bearingDeg: 360 })).expect(400);
        await post(batch(base, { sourceTimestampNs: 1445245922681115 })).expect(400);
        await post(batch(base, { sourceTimestampNs: "9223372036854775808" })).expect(400);
        await post(batch({ ...base, mode: "SIM" })).expect(400);
        await post(batch({ ...base, recordingSessionId: "../escape" })).expect(400);
        expect(await positions()).toHaveLength(0);
    });

    it("keeps a poor-accuracy fix", async () => {
        await post(batch({ tripId: String(tripId), vehicleId: String(vehicleId) }, { horizontalAccuracyM: 45 })).expect(200);
        expect((await positions())[0]!.horizontalAccuracyM).toBe("45.000");
    });

    it("uses receivedAt as recordedAt when the fix has no source UTC", async () => {
        await post(batch({ tripId: String(tripId), vehicleId: String(vehicleId) }, { utcEpochMs: null })).expect(200);
        const [row] = await positions();
        expect(row!.recordedAt.toISOString()).toBe("2026-09-18T02:40:15.123Z");
    });
});
