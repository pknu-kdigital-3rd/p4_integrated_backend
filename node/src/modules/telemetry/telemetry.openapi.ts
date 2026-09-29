import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import { deviceGpsBatchSchema, deviceGpsResponseSchema, vehicleStreamContextSchema } from "./telemetry.schema.ts";

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
        "- `tripId` is omitted while the vehicle streams without an active trip; those fixes are stored with no trip and the vehicle must be active.",
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

registry.registerPath({
    method: "post",
    path: "/internal/telemetry/validate",
    tags: ["Internal Telemetry"],
    summary: "Validate a stream that names a vehicle but no trip (called by the media relay)",
    description: "The relay tracks such a stream on the operator map but never records it. Echoes the identity when the vehicle exists and is active.",
    security: [{ internalServiceToken: [] }],
    request: { body: { content: { "application/json": { schema: vehicleStreamContextSchema } } } },
    responses: {
        200: { description: "Identity accepted", content: { "application/json": { schema: vehicleStreamContextSchema } } },
        401: { description: "Invalid internal service token", content: { "application/json": { schema: apiErrorSchema } } },
        404: { description: "Vehicle missing or inactive", content: { "application/json": { schema: apiErrorSchema } } },
        503: { description: "Android telemetry is disabled", content: { "application/json": { schema: apiErrorSchema } } },
    },
});
