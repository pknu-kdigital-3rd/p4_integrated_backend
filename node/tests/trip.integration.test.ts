import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../src/infrastructure/database/prisma.ts";
import { routingInternalClient } from "../src/modules/virtual/routing-internal.client.ts";
import { trackingClient } from "../src/modules/tracking/tracking.client.ts";
import { replayPreviewSchema, replayPreviewService } from "../src/modules/trip/trip.preview.ts";
import { createTripSchema } from "../src/modules/trip/trip.schema.ts";
import { tripService } from "../src/modules/trip/trip.service.ts";
import { resetDatabase } from "./helpers/reset-database.ts";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);

function preview(fingerprint: string, endLatitude = 35.02) {
    return replayPreviewSchema.parse({
        fingerprint,
        datasetName: `dataset-${fingerprint[0]}`,
        points: [["1000", 129.0, 35.0, 0], ["2000", 129.0, 35.01, 1112], ["3000", 129.0, endLatitude, 2224]],
        totalDistanceM: 2224,
    });
}

function mockRoute() {
    return vi.spyOn(routingInternalClient, "route").mockResolvedValue({
        graphVersion: "test",
        routeGeojson: { type: "LineString", coordinates: [[129.1, 35.1], [129.2, 35.2]] },
        directedItinerary: [], snappedStops: [], distanceM: 1500, durationSec: 300, warnings: [],
    });
}

async function vehicle() {
    return (await prisma.vehicle.create({ data: { vehicleCode: `CAR-${Math.random()}`, vehicleStatus: "READY" } })).vehicleId;
}

function dualInput(vehicleId: bigint) {
    return createTripSchema.parse({
        vehicleId: String(vehicleId), routeMode: "DUAL", destinationName: "Depot",
        destinationLatitude: 35.2, destinationLongitude: 129.2, originLatitude: 35.1, originLongitude: 129.1,
    });
}

async function replayOnlyTrip(vehicleId: bigint, fingerprint = fingerprintA) {
    const saved = await replayPreviewService.upload(vehicleId, preview(fingerprint));
    return tripService.createTrip(createTripSchema.parse({
        vehicleId: String(vehicleId), routeMode: "REPLAY_ONLY", replayPreviewId: String(saved.replayPreviewId),
        destinationName: "ignored", destinationLatitude: 36, destinationLongitude: 128,
    }));
}

describe("trip assignment route modes", () => {
    beforeEach(async () => { await resetDatabase(); });
    afterEach(() => { vi.restoreAllMocks(); });
    afterAll(async () => { await prisma.$disconnect(); });

    it("creates a dual-mode trip with an optimal route to the operator destination", async () => {
        const route = mockRoute();
        const vehicleId = await vehicle();
        const trip = await tripService.createTrip(dualInput(vehicleId));
        expect(trip?.routeMode).toBe("DUAL");
        expect(trip?.tripStatus).toBe("READY");
        expect(route).toHaveBeenCalledWith(expect.objectContaining({ destination: { lat: 35.2, lon: 129.2 } }));
        const display = await tripService.display(String(trip!.tripId));
        expect(display.plannedRoute?.routeGeojson).toEqual({ type: "LineString", coordinates: [[129.1, 35.1], [129.2, 35.2]] });
        expect(display.replayPreview).toBeNull();
    });

    it("lets dual mode follow the latest Android preview without changing the destination", async () => {
        mockRoute();
        const vehicleId = await vehicle();
        const trip = await tripService.createTrip(dualInput(vehicleId));
        await replayPreviewService.upload(vehicleId, preview(fingerprintA));
        await replayPreviewService.upload(vehicleId, preview(fingerprintB, 35.03));
        const display = await tripService.display(String(trip!.tripId));
        expect(display.replayPreview?.fingerprint).toBe(fingerprintB);
        expect(display.destinationName).toBe("Depot");
    });

    it("uses the fix a phone is streaming for the vehicle as the dual-mode origin", async () => {
        const route = mockRoute();
        const vehicleId = await vehicle();
        const lookup = vi.spyOn(trackingClient, "vehicle").mockImplementation(async externalId => {
            if (externalId !== `device:${vehicleId}`) throw new Error("not found");
            return { external_id: externalId, latitude: 35.15, longitude: 129.05, telemetry_source: "RECORDED_GPS",
                // A replayed fix keeps its original recording date; freshness comes from receipt.
                observed_at_utc: "2025-01-01T00:00:00.000Z",
                source_metadata: { vehicleId: String(vehicleId), receivedAt: new Date().toISOString() } } as never;
        });
        const { originLatitude: _lat, originLongitude: _lon, ...input } = dualInput(vehicleId);
        await tripService.createTrip(input);
        expect(lookup).toHaveBeenCalledWith(`device:${vehicleId}`);
        expect(route).toHaveBeenCalledWith(expect.objectContaining({ origin: { lat: 35.15, lon: 129.05 } }));
    });

    it("requires an origin when the phone's last fix is stale", async () => {
        mockRoute();
        const vehicleId = await vehicle();
        vi.spyOn(trackingClient, "vehicle").mockResolvedValue({ external_id: `device:${vehicleId}`, latitude: 35.15, longitude: 129.05,
            telemetry_source: "RECORDED_GPS", source_metadata: { receivedAt: new Date(Date.now() - 120_000).toISOString() } } as never);
        const { originLatitude: _lat, originLongitude: _lon, ...input } = dualInput(vehicleId);
        await expect(tripService.createTrip(input)).rejects.toMatchObject({ code: "TRIP_ORIGIN_REQUIRED" });
    });

    it("rejects a routing failure without creating a trip", async () => {
        vi.spyOn(routingInternalClient, "route").mockRejectedValue(Object.assign(new Error("no route"), { statusCode: 422 }));
        const vehicleId = await vehicle();
        await expect(tripService.createTrip(dualInput(vehicleId))).rejects.toThrow("no route");
        expect(await prisma.trip.count({ where: { vehicleId } })).toBe(0);
    });

    it("derives the replay-only destination from the final GPS record and draws no optimal route", async () => {
        const route = mockRoute();
        const vehicleId = await vehicle();
        const trip = await replayOnlyTrip(vehicleId);
        expect(route).not.toHaveBeenCalled();
        expect(trip?.destinationName).toContain("dataset-a");
        const [location] = await prisma.$queryRaw<Array<{ lat: number; lon: number }>>`
            SELECT ST_Y(destination_location::geometry) AS lat, ST_X(destination_location::geometry) AS lon
            FROM trip WHERE trip_id = ${trip!.tripId}`;
        expect(location).toEqual({ lat: 35.02, lon: 129.0 });
        const display = await tripService.display(String(trip!.tripId));
        expect(display.plannedRoute).toBeNull();
        // A later dataset selection affects only later trips, never the pinned path.
        await replayPreviewService.upload(vehicleId, preview(fingerprintB, 35.03));
        expect((await tripService.display(String(trip!.tripId))).replayPreview?.fingerprint).toBe(fingerprintA);
    });

    it("rejects a preview that belongs to another vehicle", async () => {
        const vehicleId = await vehicle();
        const foreign = await replayPreviewService.upload(await vehicle(), preview(fingerprintA));
        await expect(tripService.createTrip(createTripSchema.parse({
            vehicleId: String(vehicleId), routeMode: "REPLAY_ONLY", replayPreviewId: String(foreign.replayPreviewId),
        }))).rejects.toMatchObject({ code: "REPLAY_PREVIEW_NOT_FOUND" });
    });

    it("rejects a second active assignment for the same vehicle until the first is cancelled", async () => {
        mockRoute();
        const vehicleId = await vehicle();
        const first = await tripService.createTrip(dualInput(vehicleId));
        await expect(tripService.createTrip(dualInput(vehicleId))).rejects.toMatchObject({ code: "VEHICLE_TRIP_CONFLICT" });
        expect((await tripService.cancel(String(first!.tripId)))?.tripStatus).toBe("CANCELLED");
        await expect(tripService.cancel(String(first!.tripId))).rejects.toMatchObject({ code: "TRIP_STATE_CONFLICT" });
        expect(await tripService.current(String(vehicleId))).toBeNull();
        expect((await tripService.createTrip(dualInput(vehicleId)))?.tripStatus).toBe("READY");
    });

    it("cancels a running trip so Android sees no assignment", async () => {
        mockRoute();
        const vehicleId = await vehicle();
        const trip = await tripService.createTrip(dualInput(vehicleId));
        await tripService.changeState(String(vehicleId), String(trip!.tripId), "start");
        expect((await tripService.cancel(String(trip!.tripId)))?.endedAt).not.toBeNull();
        expect(await tripService.current(String(vehicleId))).toBeNull();
    });

    it("blocks replay-only start when the device selected a different dataset", async () => {
        const vehicleId = await vehicle();
        const trip = await replayOnlyTrip(vehicleId);
        const ids = [String(vehicleId), String(trip!.tripId)] as const;
        await expect(tripService.changeState(...ids, "start", fingerprintB)).rejects.toMatchObject({ code: "REPLAY_DATASET_MISMATCH" });
        await expect(tripService.changeState(...ids, "start")).rejects.toMatchObject({ code: "REPLAY_DATASET_MISMATCH" });
        expect((await tripService.changeState(...ids, "start", fingerprintA))?.tripStatus).toBe("IN_PROGRESS");
        const current = await tripService.current(String(vehicleId));
        expect(current?.replayPreview).toEqual({ fingerprint: fingerprintA, datasetName: "dataset-a" });
    });

    it("moves a device trip through READY, IN_PROGRESS and COMPLETED idempotently", async () => {
        mockRoute();
        const vehicleId = await vehicle();
        const trip = await tripService.createTrip(dualInput(vehicleId));
        const ids = [String(vehicleId), String(trip!.tripId)] as const;
        await expect(tripService.changeState(...ids, "complete")).rejects.toMatchObject({ code: "TRIP_STATE_CONFLICT" });
        expect((await tripService.changeState(...ids, "start"))?.startedAt).not.toBeNull();
        expect((await tripService.changeState(...ids, "start"))?.tripStatus).toBe("IN_PROGRESS");
        const completed = await tripService.changeState(...ids, "complete");
        expect(completed?.tripStatus).toBe("COMPLETED");
        expect(completed?.endedAt).not.toBeNull();
        expect(await tripService.current(String(vehicleId))).toBeNull();
        await expect(tripService.changeState(String(await vehicle()), ids[1], "start")).rejects.toMatchObject({ code: "TRIP_NOT_FOUND" });
    });
});
