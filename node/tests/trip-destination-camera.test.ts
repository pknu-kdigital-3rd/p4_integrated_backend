import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createLiveMapFollower } from "../../operator-web/live-map.js";

// Exercise the actual progress-card handlers with a moving live vehicle.
const source = readFileSync(new URL("../../operator-web/app.js", import.meta.url), "utf8");
const cameraHandlers = source.slice(source.indexOf("// The progress card's red end flag"), source.indexOf("for(const [id,action]"));

function setup(withLiveView = true) {
    let zoom = 14;
    let position = { lat: 35.1, lng: 129.1 };
    const events: Record<string, () => void> = {};
    const map = {
        options: { scrollWheelZoom: true },
        getZoom: () => zoom,
        setView: vi.fn((_position, nextZoom) => { zoom = nextZoom; }),
        panTo: vi.fn(),
        fitBounds: vi.fn(() => { zoom = 10; }),
        stop: vi.fn(),
        removeLayer: vi.fn(),
        on: (event: string, handler: () => void) => { events[event] = handler; },
        getContainer: () => ({ getBoundingClientRect: () => ({ width: 1000, height: 800 }) }),
    };
    const marker = {
        getLatLng: () => position,
        setLatLng: (point: number[]) => { position = { lat: point[0], lng: point[1] }; },
    };
    const item = { vehicleId: "7", telemetry: { external_id: "device:7", latitude: 35.1, longitude: 129.1 } };
    const liveView = withLiveView ? { vehicleId: "7", markerKey: "device:7", item } : null;
    const markers = new Map([["device:7", { marker, item }]]);
    const follower = createLiveMapFollower({ map, markers, createEntry: vi.fn() });
    if (liveView) follower.begin(liveView);
    const context = {
        map, markers, liveView, selected: item, liveMapFollower: follower, destinationMarker: null,
        currentTripDisplay: { vehicleId: "7", destinationName: "Destination", plannedRoute: { routeGeojson: { coordinates: [[129.1, 35.1], [129.8, 35.8]] } } },
        document: { querySelectorAll: () => [] },
        L: {
            latLngBounds: (points: unknown[]) => points,
            divIcon: (options: unknown) => options,
            marker: () => ({ addTo() { return this; }, bindTooltip() { return this; } }),
        },
    };
    runInNewContext(`${cameraHandlers}\nglobalThis.handlers={showTripDestination,returnToVehicle,clearDestinationPeek};`, context);
    const handlers = (context as typeof context & { handlers: { showTripDestination(): void; returnToVehicle(): void; clearDestinationPeek(): void } }).handlers;
    return { map, follower, events, handlers, setZoom: (value: number) => { zoom = value; } };
}

describe("destination camera", () => {
    it("frames once and leaves manual pan and zoom alone while telemetry continues", () => {
        const { map, follower, events, handlers, setZoom } = setup();
        handlers.showTripDestination();
        expect(map.fitBounds).toHaveBeenCalledOnce();
        expect(follower.isFollowing()).toBe(false);
        expect(map.options.scrollWheelZoom).toBe(true);
        map.setView.mockClear();
        setZoom(12);
        events.zoomend();
        follower.update([35.4, 129.4]);
        follower.update([35.5, 129.5]);
        expect(map.setView).not.toHaveBeenCalled();
        expect(map.panTo).not.toHaveBeenCalled();
        expect(map.fitBounds).toHaveBeenCalledOnce();
        handlers.returnToVehicle();
        expect(map.getZoom()).toBe(14);
        expect(map.setView).toHaveBeenCalledWith({ lat: 35.5, lng: 129.5 }, 14, { animate: false });
        expect(follower.isFollowing()).toBe(true);
    });

    it("preserves the original zoom across repeated destination clicks", () => {
        const { map, handlers, setZoom } = setup();
        handlers.showTripDestination();
        setZoom(8);
        handlers.showTripDestination();
        setZoom(11);
        handlers.returnToVehicle();
        expect(map.getZoom()).toBe(14);
        setZoom(16);
        handlers.showTripDestination();
        handlers.returnToVehicle();
        expect(map.getZoom()).toBe(16);
    });

    it("restores the previous zoom without an open Live View", () => {
        const { map, handlers, setZoom } = setup(false);
        handlers.showTripDestination();
        setZoom(9);
        handlers.returnToVehicle();
        expect(map.getZoom()).toBe(14);
    });

    it("discards the saved zoom when the trip view is cleared", () => {
        const { map, handlers, setZoom } = setup(false);
        handlers.showTripDestination();
        handlers.clearDestinationPeek();
        setZoom(17);
        handlers.showTripDestination();
        handlers.returnToVehicle();
        expect(map.getZoom()).toBe(17);
    });
});
