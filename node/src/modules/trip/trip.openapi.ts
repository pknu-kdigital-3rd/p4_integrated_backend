import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import { createTripSchema } from "./trip.schema.ts";
import { tripDataResponseSchema, tripListResponseSchema } from "./trip.response.ts";

registry.registerPath({
    method: "get",
    path: "/api/v1/trips",
    tags: ["Trip"],
    summary: "List recent trips and their assigned vehicles",
    security: [{ bearerAuth: [] }],
    responses: {
        200: { description: "Recent trips", content: { "application/json": { schema: tripListResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/trips",
    tags: ["Trip"],
    summary: "Create a trip and assign it to a vehicle",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: createTripSchema } } } },
    responses: {
        201: { description: "Trip created", content: { "application/json": { schema: tripDataResponseSchema } } },
        400: { description: "Invalid trip details", content: { "application/json": { schema: apiErrorSchema } } },
        403: { description: "Admin or operator role required", content: { "application/json": { schema: apiErrorSchema } } },
        404: { description: "Vehicle not found", content: { "application/json": { schema: apiErrorSchema } } },
    },
});
