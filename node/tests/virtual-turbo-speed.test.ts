import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TURBO_FACTOR, TURBO_ROUTE_SECONDS, turboSpeedKmh } from "../src/modules/virtual/virtual-turbo-speed.ts";

const mocks = vi.hoisted(() => ({ states: vi.fn(), checkpoint: vi.fn() }));
vi.mock("../src/config/logger.ts", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("../src/infrastructure/database/prisma.ts", () => ({ prisma: {
    virtualDispatchRequest: { findMany: vi.fn(async () => []) },
    virtualVehicleState: { findMany: mocks.states, updateMany: mocks.checkpoint },
    virtualRoadRestriction: { findMany: vi.fn(async () => []) },
} }));
vi.mock("../src/modules/virtual/virtual.service.ts", () => ({ virtualService: { acceptRequest: vi.fn() } }));
import { startVirtualSimulationWorker } from "../src/modules/virtual/virtual-simulation.worker.ts";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-05T00:00:00Z")); mocks.checkpoint.mockReset(); });
afterEach(() => vi.useRealTimers());

describe("route-length turbo speed", () => {
    it("scales every route to 5 seconds without capping long-route speed", () => {
        for (const distance of [10, 100, 1000, 10000, 100000, 1000000]) {
            const effectiveMps = turboSpeedKmh(distance) / 3.6 * TURBO_FACTOR;
            expect(distance / effectiveMps).toBeCloseTo(5);
        }
        expect(turboSpeedKmh(100)).toBeLessThan(turboSpeedKmh(1000));
        expect(turboSpeedKmh(100000)).toBe(3600);
        expect(turboSpeedKmh(1000000)).toBe(36000);
    });

    for (const distance of [100, 1000, 10000, 1000000]) {
        it(`advances a ${distance} m turbo route by a small fraction per tick, including existing turbo states`, async () => {
            const durationSec = distance / 10;
            mocks.states.mockResolvedValue([{
                vehicleId: 1n, virtualTripId: 2n, scenarioId: 3n, activeRouteId: 4n,
                commandVersion: 1, speedKmh: 200, speedFactor: 20, simElapsedMs: 0n,
                lastCheckpointAt: new Date(Date.now() - 250),
                activeRoute: { distanceM: distance, durationSec, routeGeojson: { coordinates: [[129, 35], [129.01, 35]] }, directedItinerary: [] },
                trip: { state: "DRIVING", waypoints: [] },
            }]);
            const stop = startVirtualSimulationWorker();
            await vi.advanceTimersByTimeAsync(0);
            stop();
            expect(mocks.checkpoint).toHaveBeenCalledOnce();
            const data = mocks.checkpoint.mock.calls[0]![0].data;
            expect(data.speedKmh).toBeCloseTo(turboSpeedKmh(distance));
            expect(Number(data.simElapsedMs) / (durationSec * 1000)).toBeCloseTo(0.25 / TURBO_ROUTE_SECONDS, 3);
        });
    }

    it("keeps ordinary speed settings unchanged", async () => {
        mocks.states.mockResolvedValue([{
            vehicleId: 1n, virtualTripId: 2n, scenarioId: 3n, activeRouteId: 4n,
            commandVersion: 1, speedKmh: 60, speedFactor: 1, simElapsedMs: 0n,
            lastCheckpointAt: new Date(Date.now() - 250),
            activeRoute: { distanceM: 1000, durationSec: 100, routeGeojson: { coordinates: [[129, 35], [129.01, 35]] }, directedItinerary: [] },
            trip: { state: "DRIVING", waypoints: [] },
        }]);
        const stop = startVirtualSimulationWorker();
        await vi.advanceTimersByTimeAsync(0);
        stop();
        const data = mocks.checkpoint.mock.calls[0]![0].data;
        expect(data.speedKmh).toBe(60);
        expect(Number(data.simElapsedMs)).toBeCloseTo(417, 0);
    });
});
