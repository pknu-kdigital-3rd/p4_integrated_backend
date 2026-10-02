import { describe, expect, it } from "vitest";

import { cancelGlide, createLiveMapFollower, glideMarker } from "../operator-web/live-map.js";
import { acceptLiveTelemetry, applyLiveTelemetry, createLiveView, isSupersededFrame, resetLiveFrameOrder } from "../operator-web/live-telemetry.js";

// Fake animation clock: callbacks run only when the test advances time.
function fakeFrames() {
    let nextId = 1;
    const queued = new Map<number, (time: number) => void>();
    return {
        schedule: (callback: (time: number) => void) => { const id = nextId++; queued.set(id, callback); return id; },
        cancel: (id: number | null | undefined) => { if (id != null) queued.delete(id); },
        // Runs every callback queued before this call at `time`.
        run(time: number) {
            const due = [...queued.entries()];
            queued.clear();
            for (const [, callback] of due) callback(time);
        },
        // Runs callbacks even if they were cancelled, like a frame that was
        // already dispatched when the cancel happened.
        pending: () => [...queued.values()],
    };
}

function fakeMarker(start: [number, number]) {
    let position = start;
    return {
        getLatLng: () => ({ lat: position[0], lng: position[1] }),
        setLatLng: (next: [number, number]) => { position = [...next] as [number, number]; },
        position: () => position,
        glideFrame: null as number | null,
        glideToken: 0,
    };
}

const env = (frames: ReturnType<typeof fakeFrames>) => ({ schedule: frames.schedule, cancel: frames.cancel, now: () => 0, hidden: () => false });

describe("live marker ownership", () => {
    it("a fleet glide never overwrites a live-frame position", () => {
        globalThis.cancelAnimationFrame = undefined as never;
        const frames = fakeFrames();
        const marker = fakeMarker([35.0, 129.0]);
        // A 3-second fleet glide over ~330 m, then the first frame at 500 ms.
        glideMarker(marker, [35.003, 129.0], 3000, env(frames));
        frames.run(250);
        expect(marker.position()[0]).toBeCloseTo(35.00025, 6);
        const stale = frames.pending();
        const markers = new Map([["device:2", { marker, item: {} }]]);
        const follower = createLiveMapFollower({
            map: { getZoom: () => 16, setView: () => {}, panTo: () => {}, on: () => {}, options: {} },
            markers, createEntry: () => { throw new Error("entry exists"); },
        });
        follower.begin({ markerKey: "device:2", item: { telemetry: {} } });
        follower.update([35.001, 129.0]);
        // The glide callback that was already queued fires afterwards.
        for (const callback of stale) callback(500);
        frames.run(1000);
        expect(marker.position()).toEqual([35.001, 129.0]);
        expect(marker.glideFrame).toBeNull();
    });

    it("cancelGlide invalidates the token as well as the queued frame", () => {
        const frames = fakeFrames();
        const marker = fakeMarker([35.0, 129.0]);
        glideMarker(marker, [35.001, 129.0], 1000, env(frames));
        const stale = frames.pending();
        cancelGlide(marker, frames.cancel);
        marker.setLatLng([36, 128]);
        for (const callback of stale) callback(500);
        expect(marker.position()).toEqual([36, 128]);
    });

    it("glides to the target and jumps for far moves", () => {
        const frames = fakeFrames();
        const marker = fakeMarker([35.0, 129.0]);
        glideMarker(marker, [35.001, 129.0], 1000, env(frames));
        frames.run(500);
        expect(marker.position()[0]).toBeCloseTo(35.0005, 6);
        frames.run(1000);
        expect(marker.position()).toEqual([35.001, 129.0]);
        glideMarker(marker, [35.1, 129.0], 1000, env(frames));
        expect(marker.position()).toEqual([35.1, 129.0]);
    });
});

describe("live frame ordering", () => {
    const frameWindow = {};
    function view() {
        return createLiveView({ vehicleId: 2, telemetry: { external_id: "device:2", source_metadata: { recordingSessionId: "s1" } } }, "https://vision");
    }
    function event(epoch: number | undefined, seq: number | undefined, latitude = 35.1) {
        return {
            origin: "https://vision", source: frameWindow,
            data: { type: "live-vehicle-telemetry", epoch, seq, recording: { vehicleId: 2, recordingSessionId: "s1" }, telemetry: { status: "ok", gps: { latitude, longitude: 129.1 } } },
        };
    }
    function deliver(liveView: ReturnType<typeof view>, epoch: number | undefined, seq: number | undefined, now: number) {
        const message = acceptLiveTelemetry(liveView, event(epoch, seq), frameWindow, now);
        if (message) applyLiveTelemetry(liveView, message, now);
        return Boolean(message);
    }

    it("rejects late and repeated frames within an epoch", () => {
        const liveView = view();
        expect(deliver(liveView, 3, 10, 1000)).toBe(true);
        expect(deliver(liveView, 3, 9, 1010)).toBe(false);
        expect(deliver(liveView, 3, 10, 1020)).toBe(false);
        expect(deliver(liveView, 3, 11, 1030)).toBe(true);
    });

    it("accepts a jump-to-live epoch whose sequence restarts and rejects the old epoch", () => {
        const liveView = view();
        expect(deliver(liveView, 3, 500, 1000)).toBe(true);
        expect(deliver(liveView, 4, 0, 1100)).toBe(true);
        expect(deliver(liveView, 3, 501, 1150)).toBe(false);
        expect(deliver(liveView, 4, 1, 1200)).toBe(true);
    });

    it("accepts an older epoch after frames stopped, and after a session reset", () => {
        const liveView = view();
        expect(deliver(liveView, 5, 1, 1000)).toBe(true);
        expect(deliver(liveView, 0, 0, 2000)).toBe(false);
        expect(deliver(liveView, 0, 0, 1000 + 3001)).toBe(true);
        expect(deliver(liveView, 7, 0, 5000)).toBe(true);
        resetLiveFrameOrder(liveView);
        expect(deliver(liveView, 1, 0, 5100)).toBe(true);
    });

    it("does not order messages without epoch and sequence", () => {
        const liveView = view();
        expect(deliver(liveView, undefined, undefined, 1000)).toBe(true);
        expect(deliver(liveView, undefined, undefined, 1001)).toBe(true);
        expect(isSupersededFrame(liveView, { epoch: 1, seq: 0 }, 1002)).toBe(false);
    });
});
