import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import { trackingResponseSchema } from "./tracking.schema.ts";

registry.registerPath({
    method: "get", path: "/api/v1/tracking/vehicles", tags: ["Tracking"], summary: "Get normalized current vehicle telemetry",
    security: [{ bearerAuth: [] }],
    responses: {
        200: { description: "Current tracking snapshot", content: { "application/json": { schema: trackingResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
        503: { description: "Tracking service unavailable", content: { "application/json": { schema: apiErrorSchema } } },
    },
});
