import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.ts", () => ({ env: {
    VISION_SOURCE: "server", SERVER_VEHICLE_ID: "42",
    VISION_PUBLIC_BASE_URL: "https://example.com/vision",
    ROUTING_TRACKING_BASE_URL: "http://routing:8000",
} }));

import { bootstrapService } from "../src/modules/bootstrap/bootstrap.service.ts";
import { bootstrapResponseSchema } from "../src/modules/bootstrap/bootstrap.schema.ts";

describe("server playback discovery", () => {
    it("exposes the configured source and vehicle without Android stream metadata", () => {
        const response = bootstrapResponseSchema.parse(bootstrapService.getBootstrap());
        expect(response.videoSource).toEqual({ mode: "server", vehicleId: "42" });
        expect(response.liveViewUrl).toBe("https://example.com/vision");
    });
});
