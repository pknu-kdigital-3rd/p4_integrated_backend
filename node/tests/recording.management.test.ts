import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
    videoFindMany: vi.fn(), videoFindUnique: vi.fn(),
    deleteSamples: vi.fn(), deleteVideo: vi.fn(), transaction: vi.fn(), removeObject: vi.fn(), presignedGetObject: vi.fn(),
}));
vi.mock("../src/config/env.ts", () => ({ env: {
    RECORDING_ENABLED: true, MINIO_RECORDING_BUCKET: "p4-trip-recordings",
    MINIO_ENDPOINT: "localhost:9000", MINIO_PUBLIC_ENDPOINT: "https://storage.test",
    MINIO_NODE_ACCESS_KEY: "test", MINIO_NODE_SECRET_KEY: "test", RECORDING_PLAYBACK_URL_TTL_SECONDS: 300,
} }));
vi.mock("../src/config/logger.ts", () => ({ logger: { error: vi.fn() } }));
vi.mock("../src/infrastructure/database/prisma.ts", () => ({ prisma: {
    tripVideo: { findMany: mocks.videoFindMany, findUnique: mocks.videoFindUnique, delete: mocks.deleteVideo },
    tripVideoDetectionSample: { deleteMany: mocks.deleteSamples }, $transaction: mocks.transaction,
} }));
vi.mock("minio", () => ({ Client: class {
    removeObject = mocks.removeObject;
    presignedGetObject = mocks.presignedGetObject;
} }));
vi.mock("../src/common/auth/authenticate.ts", () => ({ authenticate(req: any, res: any, next: any) {
    const role = req.header("x-test-role");
    if (!role) { res.status(401).end(); return; }
    req.auth = { userId: "1", role }; next();
} }));

import { AppError } from "../src/common/errors/app-error.ts";
import { recordingService } from "../src/modules/recording/recording.service.ts";
import { recordingRouter } from "../src/modules/recording/recording.router.ts";
import { tripRecordingDeleteSchema } from "../src/modules/recording/recording.schema.ts";

const video = {
    tripVideoId: 11n, tripId: 7n, recordingSessionId: "session-a", segmentIndex: 0,
    storageBucket: "p4-trip-recordings", objectKey: "trips/7/sessions/session-a/segment-000000.mp4",
    uploadStatus: "FINALIZED", endSeq: 20n, startSeq: 10n, relayEpoch: 2n,
};
beforeEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("trip recording management", () => {
    it("rejects segments outside the trip or changed state before any deletion", async () => {
        const remove = vi.spyOn(recordingService, "deleteTripVideo");
        for (const selected of [[], [{ tripVideoId: 11n, uploadStatus: "FAILED" }]]) {
            mocks.videoFindMany.mockResolvedValue(selected);
            await expect(recordingService.deleteTripRecordings("7", ["11"])).rejects.toMatchObject({ code: "RECORDING_SELECTION_CHANGED" });
        }
        expect(remove).not.toHaveBeenCalled();
    });

    it("deletes only confirmed IDs and reports partial storage failures", async () => {
        mocks.videoFindMany.mockResolvedValue([11n, 12n].map(tripVideoId => ({ tripVideoId, uploadStatus: "FINALIZED" })));
        const remove = vi.spyOn(recordingService, "deleteTripVideo").mockResolvedValueOnce({ tripVideoId: "11", deleted: true }).mockRejectedValueOnce(new AppError(503, "Storage unavailable", "RECORDING_DELETE_FAILED"));
        expect(await recordingService.deleteTripRecordings("7", ["11", "12"])).toEqual({ tripId: "7", deletedTripVideoIds: ["11"], failures: [{ tripVideoId: "12", message: "Storage unavailable" }] });
        expect(remove.mock.calls).toEqual([["11"], ["12"]]);
        expect(mocks.videoFindMany.mock.calls[0][0].where).toEqual({ tripId: 7n, tripVideoId: { in: [11n, 12n] } });
    });

    it("removes the MP4 and only its replay detection range, retaining the trip", async () => {
        mocks.videoFindMany.mockResolvedValue([{ tripVideoId: 11n, uploadStatus: "FINALIZED" }]);
        mocks.videoFindUnique.mockResolvedValue(video);mocks.removeObject.mockResolvedValue(undefined);mocks.transaction.mockResolvedValue([]);
        const result = await recordingService.deleteTripRecordings("7", ["11"]);
        expect(result.deletedTripVideoIds).toEqual(["11"]);
        expect(mocks.removeObject).toHaveBeenCalledWith(video.storageBucket, video.objectKey);
        expect(mocks.deleteSamples).toHaveBeenCalledWith({ where: { tripId: 7n, recordingSessionId: "session-a", relayEpoch: 2n, frameSeq: { gte: 10n, lte: 20n } } });
        expect(mocks.deleteVideo).toHaveBeenCalledWith({ where: { tripVideoId: 11n } });
    });

    it("requires an explicit, bounded snapshot with no duplicate IDs", () => {
        for (const tripVideoIds of [[], ["11", "11"], ["0"], Array.from({ length: 51 }, (_, i) => String(i + 1))]) {
            expect(tripRecordingDeleteSchema.safeParse({ tripVideoIds }).success).toBe(false);
        }
    });
});

describe("recording management routes", () => {
    function app() {
        const app = express();app.use(express.json());app.set("json replacer", (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value);
        app.use("/api/v1", recordingRouter);
        app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ error: { message: error.message } }));
        return app;
    }
    it("requires authentication and forbids viewer deletion", async () => {
        const remove = vi.spyOn(recordingService, "deleteTripRecordings");
        expect((await request(app()).delete("/api/v1/trips/7/videos").send({ tripVideoIds: ["11"] })).status).toBe(401);
        expect((await request(app()).delete("/api/v1/trips/7/videos").set("x-test-role", "VIEWER").send({ tripVideoIds: ["11"] })).status).toBe(403);
        expect(remove).not.toHaveBeenCalled();
    });
    it("does not expose the removed library or download endpoints", async () => {
        expect((await request(app()).get("/api/v1/recording-trips")).status).toBe(404);
        expect((await request(app()).post("/api/v1/trip-videos/11/download-url")).status).toBe(404);
    });
    it("validates operator deletion bodies", async () => {
        expect((await request(app()).delete("/api/v1/trips/7/videos").set("x-test-role", "OPERATOR").send({})).status).toBe(400);
        const remove = vi.spyOn(recordingService, "deleteTripRecordings").mockResolvedValue({ tripId: "7", deletedTripVideoIds: ["11"], failures: [] });
        expect((await request(app()).delete("/api/v1/trips/7/videos").set("x-test-role", "OPERATOR").send({ tripVideoIds: ["11"] })).status).toBe(200);
        expect(remove).toHaveBeenCalledWith("7", ["11"]);
    });
});
