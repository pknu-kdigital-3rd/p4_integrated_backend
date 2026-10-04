import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import { createTripSchema, tripIdParamSchema } from "./trip.schema.ts";
import { tripDataResponseSchema, tripListResponseSchema } from "./trip.response.ts";
import { replayPreviewSchema } from "./trip.preview.ts";
import { z } from "zod";

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

const tripIdParameter = z.object({ tripId: z.string().regex(/^[1-9]\d*$/) });
registry.registerPath({
    method: "delete", path: "/api/v1/trips/{tripId}", tags: ["Trip"],
    summary: "Permanently remove a completed or cancelled trip after its recordings are deleted",
    security: [{ bearerAuth: [] }], request: { params: tripIdParamSchema },
    responses: {
        200: { description: "Trip, routes, deviations, related alerts and replay samples removed; GPS and object detection history retained without trip links", content: { "application/json": { schema: z.object({ data: z.object({ tripId: z.string(), deleted: z.literal(true) }) }) } } },
        403: { description: "Admin or operator required", content: { "application/json": { schema: apiErrorSchema } } },
        404: { description: "Trip not found", content: { "application/json": { schema: apiErrorSchema } } },
        409: { description: "Trip is active or has remaining recording metadata", content: { "application/json": { schema: apiErrorSchema } } },
    },
});
const vehicleIdParameter = z.object({ vehicleId: z.string().regex(/^[1-9]\d*$/) });
const deviceTripParameter = vehicleIdParameter.extend({ tripId: z.string().regex(/^[1-9]\d*$/) });
registry.registerPath({
    method: "get", path: "/api/v1/trips/{tripId}/display", tags: ["Trip"],
    summary: "Get the saved route mode, optimal route, replay preview and latest replay position",
    security: [{ bearerAuth: [] }], request: { params: tripIdParameter },
    responses: { 200: { description: "Trip display data", content: { "application/json": { schema: z.object({ data: z.unknown() }) } } } },
});
registry.registerPath({
    method: "post", path: "/api/v1/trips/{tripId}/cancel", tags: ["Trip"],
    summary: "Cancel a ready or running assignment", security: [{ bearerAuth: [] }],
    request: { params: tripIdParameter },
    responses: { 200: { description: "Cancelled trip", content: { "application/json": { schema: tripDataResponseSchema } } } },
});
registry.registerPath({
    method: "get", path: "/api/v1/trips/vehicles/{vehicleId}/replay-preview", tags: ["Trip"],
    summary: "Get the latest Android GPS preview for an assignment", security: [{ bearerAuth: [] }],
    request: { params: vehicleIdParameter },
    responses: { 200: { description: "Latest preview or null", content: { "application/json": { schema: z.object({ data: z.unknown().nullable() }) } } } },
});
registry.registerPath({
    method: "put", path: "/api/v1/device/vehicles/{vehicleId}/replay-preview", tags: ["Device Trip"],
    summary: "Publish an Android GPS path preview before trip assignment; Vehicle ID is the only device identity",
    request: { params: vehicleIdParameter, body: { content: { "application/json": { schema: replayPreviewSchema } } } },
    responses: { 200: { description: "Saved preview identity", content: { "application/json": { schema: z.object({ data: z.unknown() }) } } } },
});
registry.registerPath({
    method: "get", path: "/api/v1/device/vehicles/{vehicleId}/trip", tags: ["Device Trip"],
    summary: "Get the vehicle's ready or running trip", request: { params: vehicleIdParameter },
    responses: { 200: { description: "Current trip or null", content: { "application/json": { schema: z.object({ data: z.unknown().nullable() }) } } } },
});
for (const action of ["start", "complete"] as const) registry.registerPath({
    method: "post", path: `/api/v1/device/vehicles/{vehicleId}/trips/{tripId}/${action}`, tags: ["Device Trip"],
    summary: action === "start" ? "Start the ready trip (dataset fingerprint required in replay-only mode)" : "Complete the running trip",
    request: { params: deviceTripParameter },
    responses: { 200: { description: "Updated trip", content: { "application/json": { schema: tripDataResponseSchema } } },
        409: { description: "Trip state or dataset conflict", content: { "application/json": { schema: apiErrorSchema } } } },
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
