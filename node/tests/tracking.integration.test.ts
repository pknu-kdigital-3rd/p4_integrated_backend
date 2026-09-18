import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../src/infrastructure/database/prisma.ts";
import { trackingClient, type TrackingSnapshot } from "../src/modules/tracking/tracking.client.ts";
import { trackingService } from "../src/modules/tracking/tracking.service.ts";
import { resetDatabase } from "./helpers/reset-database.ts";

type Observation = TrackingSnapshot["vehicles"][number];

function observation(overrides: Partial<Observation>): Observation {
    return {
        external_id: "bims-1",
        latitude: 35.1,
        longitude: 129.1,
        speed_kmh: 10,
        heading_deg: 90,
        telemetry_source: "BIMS_LIVE",
        observed_at_utc: "2026-09-18T02:40:15.000Z",
        route_progress_pct: null,
        source_metadata: null,
        ...overrides,
    };
}

function deviceObservation(vehicleId: bigint, tripId: bigint, telemetrySource: Observation["telemetry_source"] = "RECORDED_GPS") {
    return observation({
        external_id: `device:${vehicleId}`,
        telemetry_source: telemetrySource,
        source_metadata: { vehicleId: String(vehicleId), tripId: String(tripId), recordingSessionId: "S1", sourceTimestampNs: "1445245922681115", mode: "REPLAY" },
    });
}

function mockSnapshot(vehicles: Observation[]) {
    vi.spyOn(trackingClient, "snapshot").mockResolvedValue({ generated_at_utc: null, vehicles, warnings: [] });
}

async function createTrip(vehicleId: bigint, status = "IN_PROGRESS"): Promise<bigint> {
    const rows = await prisma.$queryRaw<Array<{ tripId: bigint }>>`
        INSERT INTO trip (vehicle_id, destination_name, destination_location, trip_status)
        VALUES (${vehicleId}, 'Depot', ST_SetSRID(ST_MakePoint(129.1, 35.1), 4326)::geography, ${status})
        RETURNING trip_id AS "tripId"`;
    return rows[0]!.tripId;
}

describe("trackingService.getVehicles", () => {
    beforeEach(async () => {
        await resetDatabase();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it("still resolves BIMS observations to BIMS vehicles", async () => {
        mockSnapshot([observation({ external_id: "bims-7" })]);
        const result = await trackingService.getVehicles();
        expect(result.vehicles).toHaveLength(1);
        expect(result.vehicles[0]!.vehicleSource).toBe("BIMS");
        expect(await prisma.vehicle.count({ where: { vehicleSource: "BIMS", externalId: "bims-7" } })).toBe(1);
    });

    it("resolves a device observation to the existing vehicle, its explicit trip, and that trip's route", async () => {
        const vehicle = await prisma.vehicle.create({ data: { vehicleCode: "TRUCK-1", vehicleStatus: "DRIVING" } });
        const explicitTrip = await createTrip(vehicle.vehicleId, "PAUSED");
        await createTrip(vehicle.vehicleId); // newer active trip that must not be guessed
        await prisma.route.create({
            data: { tripId: explicitTrip, routeVersion: 1, routeType: "INITIAL", routeGeojson: { type: "LineString", coordinates: [[129.1, 35.1], [129.2, 35.2]] } },
        });
        mockSnapshot([deviceObservation(vehicle.vehicleId, explicitTrip), observation({ external_id: "bims-1" })]);

        const result = await trackingService.getVehicles();
        const device = result.vehicles.find(item => item.telemetry.external_id === `device:${vehicle.vehicleId}`)!;
        expect(device.vehicleId).toBe(vehicle.vehicleId);
        expect(device.vehicleSource).toBe("CUSTOM");
        expect(device.tripId).toBe(explicitTrip);
        expect(device.plannedRoute?.routeSource).toBe("OPTIMAL_PATH");
        expect(device.telemetry.source_metadata?.recordingSessionId).toBe("S1");
        expect(await prisma.vehicle.count({ where: { externalId: `device:${vehicle.vehicleId}` } })).toBe(0);
        expect(await prisma.vehicle.count()).toBe(2);
    });

    it("drops a device observation whose trip does not belong to the vehicle", async () => {
        const vehicle = await prisma.vehicle.create({ data: { vehicleCode: "TRUCK-1", vehicleStatus: "DRIVING" } });
        const other = await prisma.vehicle.create({ data: { vehicleCode: "TRUCK-2", vehicleStatus: "DRIVING" } });
        const otherTrip = await createTrip(other.vehicleId);
        mockSnapshot([deviceObservation(vehicle.vehicleId, otherTrip, "DEVICE_GPS")]);

        const result = await trackingService.getVehicles();
        expect(result.vehicles).toHaveLength(0);
        expect(result.warnings).toEqual([expect.objectContaining({ code: "DEVICE_IDENTITY_UNRESOLVED" })]);
        expect(await prisma.vehicle.count({ where: { vehicleSource: "BIMS" } })).toBe(0);
    });

    it("never persists device GPS as a read side effect", async () => {
        const vehicle = await prisma.vehicle.create({ data: { vehicleCode: "TRUCK-1", vehicleStatus: "DRIVING" } });
        const tripId = await createTrip(vehicle.vehicleId);
        mockSnapshot([deviceObservation(vehicle.vehicleId, tripId)]);
        await trackingService.getVehicles();
        await new Promise(resolve => setTimeout(resolve, 100));
        const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM vehicle_position`;
        expect(rows[0]!.count).toBe(0n);
    });
});
