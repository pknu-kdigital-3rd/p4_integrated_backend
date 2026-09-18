import { describe, expect, it, vi } from "vitest";

import { createAndroidMarkerRevealer, createLiveMapFollower, FLEET_MARKER_STYLE } from "../operator-web/live-map.js";

describe("live map follower", () => {
    it("reveals the first Android GPS marker at a useful zoom", () => {
        const map = { getZoom: () => 12, setView: vi.fn(), panTo: vi.fn() };
        const reveal = createAndroidMarkerRevealer({ map });

        expect(reveal({ telemetry: { telemetry_source: "BIMS_LIVE" } }, [35.1, 129.1])).toBe(false);
        expect(reveal({ telemetry: { telemetry_source: "DEVICE_GPS" } }, [35.1, 129.1])).toBe(true);
        expect(map.setView).toHaveBeenCalledWith([35.1, 129.1], 15, { animate: false });
        expect(reveal({ telemetry: { telemetry_source: "RECORDED_GPS" } }, [36.2, 128.2])).toBe(false);

        const laterMap = { getZoom: () => 16, setView: vi.fn(), panTo: vi.fn() };
        const revealLater = createAndroidMarkerRevealer({ map: laterMap });
        expect(revealLater({ telemetry: { telemetry_source: "DEVICE_GPS" } }, [35.1, 129.1])).toBe(true);
        expect(laterMap.setView).toHaveBeenCalledWith([35.1, 129.1], 16, { animate: false });
    });

    it("reveals an existing Android marker again for a restarted stream session", () => {
        const map = { getZoom: () => 12, setView: vi.fn(), panTo: vi.fn() };
        const reveal = createAndroidMarkerRevealer({ map });
        const item = (recordingSessionId: string) => ({
            telemetry: {
                external_id: "device:2",
                telemetry_source: "RECORDED_GPS",
                source_metadata: { recordingSessionId },
            },
        });

        expect(reveal(item("stream-1"), [35.1, 129.1])).toBe(true);
        expect(reveal(item("stream-1"), [35.2, 129.2])).toBe(false);
        expect(reveal(item("stream-2"), [35.3, 129.3])).toBe(true);
        expect(map.setView).toHaveBeenCalledTimes(2);
        expect(map.setView).toHaveBeenLastCalledWith([35.3, 129.3], 15, { animate: false });
    });

    it("creates a marker without a fleet poll and follows live positions", () => {
        let timestamp = 1000;
        const marker = { setLatLng: vi.fn(), setStyle: vi.fn() };
        const map = { getZoom: () => 12, setView: vi.fn(), panTo: vi.fn() };
        const markers = new Map();
        const createEntry = vi.fn(() => ({ marker, item: { vehicleId: "3" }, liveOnly: false }));
        const following = vi.fn();
        const follower = createLiveMapFollower({ map, markers, createEntry, onFollowingChange: following, now: () => timestamp });
        follower.begin({ markerKey: "device:3", item: { vehicleId: "3" } });

        const first = [35.1, 129.1], second = [35.1001, 129.1001];
        const entry = follower.update(first);
        expect(entry?.liveOnly).toBe(true);
        expect(markers.get("device:3")).toBe(entry);
        expect(createEntry).toHaveBeenCalledWith({ vehicleId: "3" }, first);
        expect(map.setView).toHaveBeenCalledWith(first, 12, { animate: false });

        timestamp += 250;
        follower.update(second);
        expect(map.panTo).toHaveBeenCalledWith(second, { animate: true, duration: 0.25 });
        expect(marker.setLatLng).toHaveBeenLastCalledWith(second);
        expect(following).toHaveBeenLastCalledWith(true);
    });

    it("keeps the followed vehicle as the zoom center", () => {
        let zoomEnd: (() => void) | undefined;
        const map = {
            options: { scrollWheelZoom: true },
            getZoom: () => 14,
            setView: vi.fn(),
            panTo: vi.fn(),
            on: vi.fn((event: string, handler: () => void) => {
                if (event === "zoomend") zoomEnd = handler;
            }),
        };
        const marker = { setLatLng: vi.fn(), setStyle: vi.fn() };
        const follower = createLiveMapFollower({
            map,
            markers: new Map([["device:3", { marker, item: {}, liveOnly: false }]]),
            createEntry: vi.fn(),
        });
        follower.begin({
            markerKey: "device:3",
            item: { telemetry: { latitude: 35.1, longitude: 129.1 } },
        });
        follower.update([35.2, 129.2]);

        expect(map.options.scrollWheelZoom).toBe("center");
        zoomEnd?.();
        expect(map.setView).toHaveBeenLastCalledWith([35.2, 129.2], 14, { animate: false });

        follower.pause();
        expect(map.options.scrollWheelZoom).toBe(true);
    });

    it("pauses on manual pan, recenters on request, and restores a polled marker on close", () => {
        let timestamp = 1000;
        const marker = { setLatLng: vi.fn(), setStyle: vi.fn() };
        const entry = { marker, item: {}, liveOnly: false };
        const map = { getZoom: () => 12, setView: vi.fn(), panTo: vi.fn() };
        const follower = createLiveMapFollower({ map, markers: new Map([["device:3", entry]]), createEntry: vi.fn(), now: () => timestamp });
        follower.begin({ markerKey: "device:3" });
        follower.update([35.1, 129.1]);
        follower.pause();
        timestamp += 500;
        follower.update([35.2, 129.2]);
        expect(follower.isFollowing()).toBe(false);
        expect(map.panTo).not.toHaveBeenCalled();

        follower.recenter();
        expect(follower.isFollowing()).toBe(true);
        expect(map.setView).toHaveBeenLastCalledWith([35.2, 129.2], 12, { animate: true });
        const ended = follower.end();
        expect(ended).toMatchObject({ markerKey: "device:3", liveOnly: false, position: [35.2, 129.2] });
        expect(marker.setStyle).toHaveBeenLastCalledWith(FLEET_MARKER_STYLE);
    });

    it("follows the newly selected vehicle after switching markers", () => {
        const firstMarker = { setLatLng: vi.fn(), setStyle: vi.fn() };
        const secondMarker = { setLatLng: vi.fn(), setStyle: vi.fn() };
        const markers = new Map([
            ["device:3", { marker: firstMarker, item: {}, liveOnly: false }],
            ["device:4", { marker: secondMarker, item: {}, liveOnly: false }],
        ]);
        const map = { getZoom: () => 12, setView: vi.fn(), panTo: vi.fn() };
        const follower = createLiveMapFollower({ map, markers, createEntry: vi.fn() });

        follower.begin({ markerKey: "device:3" });
        follower.update([35.1, 129.1]);
        follower.end();
        follower.begin({ markerKey: "device:4" });
        follower.update([36.2, 128.2]);

        expect(firstMarker.setLatLng).toHaveBeenLastCalledWith([35.1, 129.1]);
        expect(secondMarker.setLatLng).toHaveBeenLastCalledWith([36.2, 128.2]);
        expect(map.setView).toHaveBeenLastCalledWith([36.2, 128.2], 12, { animate: false });
    });

    it("ignores missing or malformed GPS positions", () => {
        const map = { getZoom: () => 12, setView: vi.fn(), panTo: vi.fn() };
        const follower = createLiveMapFollower({ map, markers: new Map(), createEntry: vi.fn() });
        follower.begin({ markerKey: "device:3" });
        expect(follower.update(null)).toBeNull();
        expect(follower.update([35.1, Number.NaN])).toBeNull();
        expect(map.setView).not.toHaveBeenCalled();
    });
});
