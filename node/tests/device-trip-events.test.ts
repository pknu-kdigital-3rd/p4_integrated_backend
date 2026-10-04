import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ current: vi.fn(), change: vi.fn() }));
vi.mock("../src/modules/trip/trip.service.ts", () => ({ tripService: { current: mocks.current, changeState: mocks.change } }));
vi.mock("../src/modules/trip/trip.preview.ts", () => ({ parseVehicleId: (value: string) => BigInt(value), replayPreviewSchema: {}, replayPreviewService: {} }));
vi.mock("../src/modules/trip/trip-road-match.ts", () => ({ matchReplayPreview: vi.fn() }));
import { deviceTripRouter } from "../src/modules/trip/device-trip.router.ts";
import { notifyTripChange, subscribeTripChanges } from "../src/modules/trip/trip-events.ts";
let server: Server | undefined;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
afterEach(async () => {
    await reader?.cancel(); reader = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
    vi.clearAllMocks();
});
async function connect() {
    const app = express(); app.use(deviceTripRouter);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/vehicles/2/trip/events`);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    reader = response.body!.getReader();
}
async function nextEvent() {
    const { value } = await reader!.read();
    return new TextDecoder().decode(value);
}
describe("device trip push", () => {
    it("sends initial state, cancellation, and a new assignment without recurring queries", async () => {
        mocks.current.mockResolvedValue({ tripId: 1n, vehicleId: 2n, tripStatus: "IN_PROGRESS" });
        await connect();
        expect(await nextEvent()).toContain('"tripStatus":"IN_PROGRESS"');
        expect(mocks.current).toHaveBeenCalledWith("2", true);
        notifyTripChange(3n); // Another vehicle cannot trigger work for this connection.
        expect(mocks.current).toHaveBeenCalledTimes(1);
        mocks.current.mockResolvedValue({ tripId: 1n, vehicleId: 2n, tripStatus: "CANCELLED" });
        notifyTripChange(2n);
        expect(await nextEvent()).toContain('"tripStatus":"CANCELLED"');
        mocks.current.mockResolvedValue({ tripId: 4n, vehicleId: 2n, tripStatus: "READY" });
        notifyTripChange(2n);
        expect(await nextEvent()).toContain('"tripId":"4"');
        expect(mocks.current).toHaveBeenCalledTimes(3);
    });
    it("reconciles completion on reconnect", async () => {
        mocks.current.mockResolvedValue({ tripId: 1n, vehicleId: 2n, tripStatus: "COMPLETED" });
        await connect();
        expect(await nextEvent()).toContain('"tripStatus":"COMPLETED"');
    });
    it("unsubscribes independently and isolates vehicle listeners", () => {
        const a = vi.fn(), b = vi.fn();
        const stopA = subscribeTripChanges(8n, a), stopB = subscribeTripChanges(9n, b);
        notifyTripChange(8n); stopA(); notifyTripChange(8n); notifyTripChange(9n); stopB();
        expect(a).toHaveBeenCalledOnce(); expect(b).toHaveBeenCalledOnce();
    });
});
