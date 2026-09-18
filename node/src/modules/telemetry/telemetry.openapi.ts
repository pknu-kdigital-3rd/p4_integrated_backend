import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import { deviceGpsBatchSchema, deviceGpsResponseSchema } from "./telemetry.schema.ts";

registry.registerPath({
    method: "post",
    path: "/internal/telemetry/gps",
    tags: ["Internal Telemetry"],
    summary: "Persist authoritative Android/device GPS fixes (called by the media relay)",
    description: [
        "Each source GPS fix becomes exactly one `vehicle_position` row; interpolated or predicted display positions are never sent here.",
        "",
        "- 64-bit values (`sourceTimestampNs`, `utcEpochMs`, ids) are JSON strings.",
        "- `mode` REPLAY (Android replaying a recorded dataset) is stored as `telemetry_source = RECORDED_GPS`; LIVE (real sensors) as `DEVICE_GPS`.",
        "- `recordedAt` is the source UTC observation time from `utcEpochMs` (for REPLAY, the original recording date); `receivedAt` is when the relay received the fix and orders the current position.",
        "- Idempotent on (`recordingSessionId`, `sourceTimestampNs`): retried samples are counted as `duplicates`.",
        "- The trip must belong to the vehicle and a recording session may only belong to one trip/vehicle. Vehicles are never created from telemetry.",
    ].join("\n"),
    security: [{ internalServiceToken: [] }],
    request: { body: { content: { "application/json": { schema: deviceGpsBatchSchema } } } },
    responses: {
        200: { description: "Fixes persisted (duplicates skipped)", content: { "application/json": { schema: deviceGpsResponseSchema } } },
        400: { description: "Invalid sample values", content: { "application/json": { schema: apiErrorSchema } } },
        401: { description: "Invalid internal service token", content: { "application/json": { schema: apiErrorSchema } } },
        409: { description: "Trip/vehicle/session identity mismatch", content: { "application/json": { schema: apiErrorSchema } } },
        503: { description: "Android telemetry is disabled", content: { "application/json": { schema: apiErrorSchema } } },
    },
});
