import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ trip: vi.fn(), update: vi.fn(), event: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/infrastructure/database/prisma.ts", () => ({ prisma: {
    virtualTrip: { findUnique: mocks.trip }, $transaction: mocks.transaction,
} }));
vi.mock("../src/modules/virtual/routing-internal.client.ts", () => ({ routingInternalClient: {} }));
import { virtualService } from "../src/modules/virtual/virtual.service.ts";
import { turboSpeedKmh } from "../src/modules/virtual/virtual-turbo-speed.ts";

beforeEach(() => {
    vi.clearAllMocks();
    mocks.trip.mockResolvedValue({ scenarioId: 3n, state: "DRIVING", stateRecord: {
        simStatus: "DRIVING", speedFactor: 1, activeRoute: { distanceM: 1000 },
    } });
    mocks.update.mockImplementation(async input => input.data);
    mocks.transaction.mockImplementation(async fn => fn({
        virtualVehicleState: { update: mocks.update }, virtualOperatorEvent: { create: mocks.event },
    }));
});
describe("turbo commands", () => {
    it("enables route-length speed while retaining the turbo flag and event", async () => {
        const result = await virtualService.command(2n, { command: "SET_TURBO_MODE", enabled: true }, 7n);
        expect(result).toMatchObject({ speedKmh: turboSpeedKmh(1000), speedFactor: 20 });
        expect(mocks.event).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
            eventType: "TURBO_MODE_CHANGED", payload: { enabled: true, speedKmh: turboSpeedKmh(1000) },
        }) }));
    });
    it("still permits exiting turbo and keeps other controls locked while it is active", async () => {
        mocks.trip.mockResolvedValue({ scenarioId: 3n, state: "DRIVING", stateRecord: {
            simStatus: "DRIVING", speedFactor: 20, activeRoute: { distanceM: 1000 },
        } });
        await expect(virtualService.command(2n, { command: "SET_SPEED_KMH", speedKmh: 50 })).rejects.toMatchObject({ code: "TURBO_PROGRESS_LOCK" });
        const result = await virtualService.command(2n, { command: "SET_TURBO_MODE", enabled: false });
        expect(result).toMatchObject({ speedKmh: 200, speedFactor: 1 });
    });
    it("rejects enabling turbo on a paused trip", async () => {
        mocks.trip.mockResolvedValue({ scenarioId: 3n, state: "PAUSED", stateRecord: { simStatus: "PAUSED", speedFactor: 1 } });
        await expect(virtualService.command(2n, { command: "SET_TURBO_MODE", enabled: true })).rejects.toMatchObject({ code: "TURBO_REQUIRES_DRIVING_TRIP" });
        expect(mocks.update).not.toHaveBeenCalled();
    });
});
