import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import { telemetryModeResponseSchema, telemetryModeSchema, trackingResponseSchema } from "./tracking.schema.ts";

registry.registerPath({
    method: "get", path: "/api/v1/tracking/vehicles", tags: ["Tracking"], summary: "Get normalized current vehicle telemetry",
    security: [{ bearerAuth: [] }],
    responses: {
        200: { description: "Current tracking snapshot", content: { "application/json": { schema: trackingResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
        503: { description: "Tracking service unavailable", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "get", path: "/api/v1/tracking/telemetry-mode", tags: ["Tracking"], summary: "Get the active BIMS telemetry source",
    security: [{ bearerAuth: [] }],
    responses: {
        200: { description: "Active telemetry source", content: { "application/json": { schema: telemetryModeResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
        503: { description: "Tracking service unavailable", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "put", path: "/api/v1/tracking/telemetry-mode", tags: ["Tracking"], summary: "Switch the active BIMS telemetry source",
    security: [{ bearerAuth: [] }],
    request: { body: { required: true, content: { "application/json": { schema: telemetryModeSchema } } } },
    responses: {
        200: { description: "Telemetry source changed", content: { "application/json": { schema: telemetryModeResponseSchema } } },
        400: { description: "Invalid mode", content: { "application/json": { schema: apiErrorSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
        403: { description: "Operator or admin role required", content: { "application/json": { schema: apiErrorSchema } } },
        503: { description: "Tracking service unavailable", content: { "application/json": { schema: apiErrorSchema } } },
    },
});
