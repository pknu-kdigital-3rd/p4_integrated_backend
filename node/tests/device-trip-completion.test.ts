import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() }));
vi.mock("../src/infrastructure/database/prisma.ts", () => ({ prisma: { trip: mocks } }));
import { tripService } from "../src/modules/trip/trip.service.ts";
import { subscribeTripChanges } from "../src/modules/trip/trip-events.ts";
beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ tripId: 1n, vehicleId: 2n, tripStatus: "IN_PROGRESS", routeMode: "REPLAY_ONLY" });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue({ tripId: 1n, vehicleId: 2n, tripStatus: "COMPLETED" });
});
describe("Android GPS end report", () => {
    it("commits completion before pushing state to Android", async () => {
        const onChange = vi.fn(() => { expect(mocks.updateMany).toHaveBeenCalledOnce(); });
        const stop = subscribeTripChanges(2n, onChange);
        try {
            expect(await tripService.changeState("2", "1", "complete")).toMatchObject({ tripStatus: "COMPLETED" });
            expect(mocks.updateMany).toHaveBeenCalledWith({ where: { tripId: 1n, vehicleId: 2n, tripStatus: "IN_PROGRESS" }, data: { tripStatus: "COMPLETED", endedAt: expect.any(Date) } });
            expect(onChange).toHaveBeenCalledOnce();
        } finally { stop(); }
    });
    it("allows a retry without completing or notifying twice", async () => {
        mocks.findFirst.mockResolvedValue({ tripId: 1n, vehicleId: 2n, tripStatus: "COMPLETED" });
        const onChange = vi.fn(), stop = subscribeTripChanges(2n, onChange);
        try {
            await tripService.changeState("2", "1", "complete");
            expect(mocks.updateMany).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
        } finally { stop(); }
    });
    it("never overwrites cancellation or another concurrent transition", async () => {
        mocks.findFirst.mockResolvedValueOnce({ tripStatus: "CANCELLED" });
        await expect(tripService.changeState("2", "1", "complete")).rejects.toMatchObject({ code: "TRIP_STATE_CONFLICT" });
        expect(mocks.updateMany).not.toHaveBeenCalled();
        mocks.updateMany.mockResolvedValueOnce({ count: 0 });
        await expect(tripService.changeState("2", "1", "complete")).rejects.toMatchObject({ code: "TRIP_STATE_CONFLICT" });
    });
});
