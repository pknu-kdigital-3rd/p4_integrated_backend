import { describe, expect, it, vi } from "vitest";

import { createLiveMapFollower, FLEET_MARKER_STYLE } from "../operator-web/live-map.js";

describe("live map follower", () => {
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

    it("ignores missing or malformed GPS positions", () => {
        const map = { getZoom: () => 12, setView: vi.fn(), panTo: vi.fn() };
        const follower = createLiveMapFollower({ map, markers: new Map(), createEntry: vi.fn() });
        follower.begin({ markerKey: "device:3" });
        expect(follower.update(null)).toBeNull();
        expect(follower.update([35.1, Number.NaN])).toBeNull();
        expect(map.setView).not.toHaveBeenCalled();
    });
});
