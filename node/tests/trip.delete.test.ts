import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
    transaction: vi.fn(), lock: vi.fn(), countVideos: vi.fn(), deleteLegacy: vi.fn(), deleteAlerts: vi.fn(), deleteDeviations: vi.fn(),
    deleteRoutes: vi.fn(), deleteSamples: vi.fn(), unlinkGps: vi.fn(), unlinkDetections: vi.fn(), unlinkGoals: vi.fn(), deleteTrip: vi.fn(),
}));
vi.mock("../src/infrastructure/database/prisma.ts", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("../src/modules/trip/trip.service.ts", async () => {
    const { deleteTrip } = await import("../src/modules/trip/trip.delete.ts");
    return { tripService: { deleteTrip } };
});
vi.mock("../src/common/auth/authenticate.ts", () => ({ authenticate(req: any, res: any, next: any) {
    const role = req.header("x-test-role");
    if (!role) { res.status(401).end(); return; }
    req.auth = { userId: "1", role }; next();
} }));

import { deleteTrip } from "../src/modules/trip/trip.delete.ts";
import { tripRouter } from "../src/modules/trip/trip.router.ts";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.lock.mockResolvedValue([{ tripStatus: "COMPLETED" }]);mocks.countVideos.mockResolvedValue(0);
    for (const operation of [mocks.deleteLegacy, mocks.deleteAlerts, mocks.deleteDeviations, mocks.deleteRoutes, mocks.deleteSamples, mocks.unlinkGps, mocks.unlinkDetections, mocks.unlinkGoals, mocks.deleteTrip]) operation.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async operation => operation({
        $queryRaw: mocks.lock, tripVideo: { count: mocks.countVideos, deleteMany: mocks.deleteLegacy }, alert: { deleteMany: mocks.deleteAlerts },
        routeDeviation: { deleteMany: mocks.deleteDeviations }, route: { deleteMany: mocks.deleteRoutes },
        tripVideoDetectionSample: { deleteMany: mocks.deleteSamples }, vehiclePosition: { updateMany: mocks.unlinkGps },
        detectionEvent: { updateMany: mocks.unlinkDetections }, transportGoal: { updateMany: mocks.unlinkGoals }, trip: { delete: mocks.deleteTrip },
    }));
});

describe("trip deletion", () => {
    it("rejects invalid database IDs before starting a transaction", async () => {
        for (const id of ["0", "-1", "abc", "9223372036854775808"]) await expect(deleteTrip(id)).rejects.toMatchObject({ statusCode: 400 });
        expect(mocks.transaction).not.toHaveBeenCalled();
    });
    it("locks the trip and refuses to delete an active or missing trip", async () => {
        for (const tripStatus of ["READY", "IN_PROGRESS", "PAUSED"]) {
            mocks.lock.mockResolvedValue([{ tripStatus }]);
            await expect(deleteTrip("7")).rejects.toMatchObject({ code: "TRIP_NOT_FINISHED" });
        }
        mocks.lock.mockResolvedValue([]);
        await expect(deleteTrip("7")).rejects.toMatchObject({ code: "TRIP_NOT_FOUND" });
        expect(mocks.lock.mock.calls[0][0].join("")).toContain("FOR UPDATE");
        expect(mocks.lock.mock.calls[0][1]).toBe(7n);
        expect(mocks.deleteAlerts).not.toHaveBeenCalled();expect(mocks.deleteTrip).not.toHaveBeenCalled();
    });
    it("requires recording metadata to be cleared before removing any trip dependencies", async () => {
        mocks.countVideos.mockResolvedValue(1);
        await expect(deleteTrip("7")).rejects.toMatchObject({ code: "TRIP_RECORDINGS_REMAIN" });
        expect(mocks.countVideos).toHaveBeenCalledWith({ where: { tripId: 7n, NOT: { storageBucket: "legacy", uploadStatus: "FAILED" } } });
        expect(mocks.deleteAlerts).not.toHaveBeenCalled();expect(mocks.deleteTrip).not.toHaveBeenCalled();
    });
    it.each(["COMPLETED", "CANCELLED"])("removes %s trip dependencies while retaining vehicle history and goals", async tripStatus => {
        mocks.lock.mockResolvedValue([{ tripStatus }]);
        expect(await deleteTrip("7")).toEqual({ tripId: "7", deleted: true });
        expect(mocks.deleteAlerts).toHaveBeenCalledWith({ where: { OR: [{ tripId: 7n }, { routeDeviation: { tripId: 7n } }] } });
        expect(mocks.deleteDeviations).toHaveBeenCalledWith({ where: { tripId: 7n } });
        expect(mocks.deleteRoutes).toHaveBeenCalledWith({ where: { tripId: 7n } });
        expect(mocks.deleteSamples).toHaveBeenCalledWith({ where: { tripId: 7n } });
        expect(mocks.deleteLegacy).toHaveBeenCalledWith({ where: { tripId: 7n, storageBucket: "legacy", uploadStatus: "FAILED" } });
        for (const operation of [mocks.unlinkGps, mocks.unlinkDetections]) expect(operation).toHaveBeenCalledWith({ where: { tripId: 7n }, data: { tripId: null } });
        expect(mocks.unlinkGoals).toHaveBeenCalledWith({ where: { assignedTripId: 7n }, data: { assignedTripId: null } });
        expect(mocks.deleteTrip).toHaveBeenCalledWith({ where: { tripId: 7n } });
        expect(mocks.deleteAlerts.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteDeviations.mock.invocationCallOrder[0]);
        expect(mocks.deleteDeviations.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteRoutes.mock.invocationCallOrder[0]);
    });
    it("propagates transaction failures without removing the trip parent", async () => {
        mocks.deleteRoutes.mockRejectedValueOnce(new Error("Database unavailable"));
        await expect(deleteTrip("7")).rejects.toThrow("Database unavailable");
        expect(mocks.deleteTrip).not.toHaveBeenCalled();
    });
});

describe("trip deletion API", () => {
    function app() {
        const app = express();app.use("/api/v1/trips", tripRouter);
        app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ error: { code: error.code, message: error.message } }));
        return app;
    }
    it("restricts deletion to operators and admins", async () => {
        expect((await request(app()).delete("/api/v1/trips/7")).status).toBe(401);
        expect((await request(app()).delete("/api/v1/trips/7").set("x-test-role", "VIEWER")).status).toBe(403);
        expect(mocks.transaction).not.toHaveBeenCalled();
        for (const role of ["OPERATOR", "ADMIN"]) expect((await request(app()).delete("/api/v1/trips/7").set("x-test-role", role)).body).toEqual({ data: { tripId: "7", deleted: true } });
    });
    it("returns validation and lifecycle conflicts before deleting", async () => {
        expect((await request(app()).delete("/api/v1/trips/9223372036854775808").set("x-test-role", "ADMIN")).status).toBe(400);
        mocks.lock.mockResolvedValue([{ tripStatus: "IN_PROGRESS" }]);
        const response = await request(app()).delete("/api/v1/trips/7").set("x-test-role", "OPERATOR");
        expect(response.status).toBe(409);expect(response.body.error.code).toBe("TRIP_NOT_FINISHED");
    });
});
