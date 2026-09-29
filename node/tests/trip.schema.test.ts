import { describe, expect, it } from "vitest";

import { replayPreviewSchema } from "../src/modules/trip/trip.preview.ts";
import { createTripSchema } from "../src/modules/trip/trip.schema.ts";

const fingerprint = "a".repeat(64);
const points = [["1000", 129.0, 35.0, 0], ["2000", 129.0, 35.01, 1112]];

describe("trip route mode schema", () => {
    it("defaults to dual mode and requires an operator destination", () => {
        expect(createTripSchema.parse({ vehicleId: "1", destinationName: "Depot", destinationLatitude: 35, destinationLongitude: 129 }).routeMode).toBe("DUAL");
        expect(createTripSchema.safeParse({ vehicleId: "1" }).success).toBe(false);
    });

    it("requires a preview for replay-only assignment and ignores the destination", () => {
        expect(createTripSchema.safeParse({ vehicleId: "1", routeMode: "REPLAY_ONLY" }).success).toBe(false);
        expect(createTripSchema.safeParse({ vehicleId: "1", routeMode: "REPLAY_ONLY", replayPreviewId: "7" }).success).toBe(true);
    });

    it("keeps replay-only trips READY until Android starts them with the pinned dataset", () => {
        expect(createTripSchema.safeParse({ vehicleId: "1", routeMode: "REPLAY_ONLY", replayPreviewId: "7", tripStatus: "IN_PROGRESS" }).success).toBe(false);
    });
});

describe("replay preview schema", () => {
    it("accepts a bounded, monotonic preview whose total matches the final point", () => {
        expect(replayPreviewSchema.safeParse({ fingerprint, datasetName: "run", points, totalDistanceM: 1112 }).success).toBe(true);
    });

    it("rejects previews that go back in time or misstate their distance", () => {
        expect(replayPreviewSchema.safeParse({ fingerprint, datasetName: "run", points: [points[1], points[0]], totalDistanceM: 0 }).success).toBe(false);
        expect(replayPreviewSchema.safeParse({ fingerprint, datasetName: "run", points, totalDistanceM: 5000 }).success).toBe(false);
        expect(replayPreviewSchema.safeParse({ fingerprint, datasetName: "run", points: [points[0]], totalDistanceM: 0 }).success).toBe(false);
    });
});
