import { describe, expect, it } from "vitest";

import {
    LIVE_OVERRIDE_STALE_MS,
    acceptLiveTelemetry,
    applyLiveTelemetry,
    createLiveView,
    describeLiveTelemetry,
    isLiveOverride,
} from "../operator-web/live-telemetry.js";

const origin = "https://vision.example:39002";
const frameWindow = { name: "vision-iframe" };
const selected = {
    vehicleId: "3",
    tripId: "102",
    telemetry: { external_id: "device:3", source_metadata: { recordingSessionId: "S1" } },
};

function message(overrides: Record<string, unknown> = {}, recording: Record<string, unknown> = {}) {
    return {
        origin,
        source: frameWindow,
        data: {
            type: "live-vehicle-telemetry",
            epoch: 2,
            seq: 981,
            sourceTimestampNs: "1445245922681115",
            recording: { tripId: "102", vehicleId: "3", recordingSessionId: "S1", ...recording },
            telemetry: { status: "ok", gps: { latitude: 35.1, longitude: 129.1, speed_kmh: 2.5, bearing_deg: 90, accuracy_quality: "normal" }, match: { gps: "interpolated" } },
        },
        ...overrides,
    };
}

describe("operator live telemetry", () => {
    it("accepts presented-frame telemetry for the selected vehicle and updates the marker", () => {
        const liveView = createLiveView(selected, origin);
        const accepted = acceptLiveTelemetry(liveView, message(), frameWindow);
        expect(accepted).not.toBeNull();
        expect(applyLiveTelemetry(liveView, accepted, 1000)).toEqual([35.1, 129.1]);
        expect(isLiveOverride(liveView, "device:3", 1500)).toBe(true);
        expect(isLiveOverride(liveView, "bims-1", 1500)).toBe(false);
    });

    it("rejects a wrong origin, a different window, and other message types", () => {
        const liveView = createLiveView(selected, origin);
        expect(acceptLiveTelemetry(liveView, message({ origin: "https://evil.example" }), frameWindow)).toBeNull();
        expect(acceptLiveTelemetry(liveView, message({ source: {} }), frameWindow)).toBeNull();
        const other = message();
        other.data.type = "something-else";
        expect(acceptLiveTelemetry(liveView, other, frameWindow)).toBeNull();
    });

    it("rejects another vehicle, trip, or recording session", () => {
        const liveView = createLiveView(selected, origin);
        expect(acceptLiveTelemetry(liveView, message({}, { vehicleId: "4" }), frameWindow)).toBeNull();
        expect(acceptLiveTelemetry(liveView, message({}, { tripId: "7" }), frameWindow)).toBeNull();
        expect(acceptLiveTelemetry(liveView, message({}, { recordingSessionId: "S2" }), frameWindow)).toBeNull();
    });

    it("locks onto the first session when the snapshot did not name one", () => {
        const liveView = createLiveView({ ...selected, telemetry: { external_id: "device:3", source_metadata: null } }, origin);
        const first = acceptLiveTelemetry(liveView, message(), frameWindow)!;
        applyLiveTelemetry(liveView, first, 0);
        expect(liveView.recordingSessionId).toBe("S1");
        expect(acceptLiveTelemetry(liveView, message({}, { recordingSessionId: "S2" }), frameWindow)).toBeNull();
    });

    it("releases the override when telemetry goes stale so fleet polling resumes", () => {
        const liveView = createLiveView(selected, origin);
        applyLiveTelemetry(liveView, acceptLiveTelemetry(liveView, message(), frameWindow)!, 1000);
        expect(isLiveOverride(liveView, "device:3", 1000 + LIVE_OVERRIDE_STALE_MS + 1)).toBe(false);
        expect(describeLiveTelemetry(liveView, null, 1000 + LIVE_OVERRIDE_STALE_MS + 1).level).toBe("warn");
    });

    it("keeps GPS-stale frames from moving the marker and shows the state", () => {
        const liveView = createLiveView(selected, origin);
        const stale = message();
        stale.data.telemetry = { status: "gps_stale", gps: null, match: { gps: "stale" } } as never;
        const accepted = acceptLiveTelemetry(liveView, stale, frameWindow)!;
        expect(applyLiveTelemetry(liveView, accepted, 1000)).toBeNull();
        expect(isLiveOverride(liveView, "device:3", 1000)).toBe(false);
        expect(describeLiveTelemetry(liveView, accepted, 1000).text).toContain("GPS stale");
    });

    it("closing live view removes the override", () => {
        expect(isLiveOverride(null, "device:3", 0)).toBe(false);
        expect(describeLiveTelemetry(null, null, 0).text).toBe("Live telemetry: closed");
    });
});
