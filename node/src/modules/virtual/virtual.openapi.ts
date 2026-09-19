import { z } from "zod";
import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import {
    commandSchema,
    createScenarioSchema,
    createVirtualVehicleSchema,
    dispatchRequestSchema,
    followingSchema,
    requestIdParamSchema,
    routePreviewSchema,
    scenarioIdParamSchema,
    virtualTripIdParamSchema,
    virtualVehicleIdParamSchema,
    virtualVehicleLifecycleSchema,
} from "./virtual.schema.ts";

const dataResponse = z.object({ data: z.unknown() });
const bearer = [{ bearerAuth: [] }];

registry.registerPath({
    method: "post",
    path: "/api/v1/virtual/scenarios",
    tags: ["Virtual Dispatch"],
    summary: "Create a virtual routing scenario",
    security: bearer,
    request: { body: { content: { "application/json": { schema: createScenarioSchema } } } },
    responses: { 201: { description: "Scenario created", content: { "application/json": { schema: dataResponse } } }, 401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } } },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/virtual/scenarios/{scenarioId}",
    tags: ["Virtual Dispatch"],
    summary: "Get a scenario snapshot and pending requests",
    security: bearer,
    request: { params: scenarioIdParamSchema },
    responses: { 200: { description: "Scenario snapshot", content: { "application/json": { schema: dataResponse } } }, 404: { description: "Scenario not found", content: { "application/json": { schema: apiErrorSchema } } } },
});

registry.registerPath({
    method: "delete",
    path: "/api/v1/virtual/scenarios/{scenarioId}",
    tags: ["Virtual Dispatch"],
    summary: "Archive a virtual routing scenario",
    security: bearer,
    request: { params: scenarioIdParamSchema },
    responses: {
        200: { description: "Scenario archived", content: { "application/json": { schema: dataResponse } } },
        404: { description: "Scenario not found", content: { "application/json": { schema: apiErrorSchema } } },
        409: { description: "Scenario has an active virtual trip", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/virtual/scenarios/{scenarioId}/routes/preview",
    tags: ["Virtual Dispatch"],
    summary: "Preview a selected vehicle's optimal route",
    security: bearer,
    request: { params: scenarioIdParamSchema, body: { content: { "application/json": { schema: routePreviewSchema } } } },
    responses: { 201: { description: "Route draft", content: { "application/json": { schema: dataResponse } } }, 409: { description: "Stale revision or busy vehicle", content: { "application/json": { schema: apiErrorSchema } } } },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/virtual/scenarios/{scenarioId}/dispatch-requests",
    tags: ["Virtual Dispatch"],
    summary: "Generate a simulated driver request for the selected vehicle",
    security: bearer,
    request: { params: scenarioIdParamSchema, body: { content: { "application/json": { schema: dispatchRequestSchema } } } },
    responses: { 201: { description: "Dispatch request", content: { "application/json": { schema: dataResponse } } }, 409: { description: "Stale draft or busy vehicle", content: { "application/json": { schema: apiErrorSchema } } } },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/virtual/dispatch-requests/{requestId}/accept",
    tags: ["Virtual Dispatch"],
    summary: "Accept a request and start the virtual trip immediately",
    security: bearer,
    request: { params: requestIdParamSchema },
    responses: { 200: { description: "Accepted trip", content: { "application/json": { schema: dataResponse } } }, 409: { description: "Request or vehicle conflict", content: { "application/json": { schema: apiErrorSchema } } } },
});

registry.registerPath({
    method: "put",
    path: "/api/v1/virtual/vehicles/{vehicleId}/following",
    tags: ["Virtual Dispatch"],
    summary: "Set one virtual vehicle's persistent follow policy",
    security: bearer,
    request: { params: virtualVehicleIdParamSchema, body: { content: { "application/json": { schema: followingSchema } } } },
    responses: { 200: { description: "Updated policy and state", content: { "application/json": { schema: dataResponse } } }, 409: { description: "Stale policy version", content: { "application/json": { schema: apiErrorSchema } } } },
});

registry.registerPath({
    method: "patch",
    path: "/api/v1/virtual/vehicles/{vehicleId}",
    tags: ["Virtual Dispatch"],
    summary: "Archive or restore a virtual vehicle",
    security: bearer,
    request: { params: virtualVehicleIdParamSchema, body: { content: { "application/json": { schema: virtualVehicleLifecycleSchema } } } },
    responses: {
        200: { description: "Virtual vehicle lifecycle updated", content: { "application/json": { schema: dataResponse } } },
        404: { description: "Virtual vehicle not found", content: { "application/json": { schema: apiErrorSchema } } },
        409: { description: "Vehicle has an active trip or pending request", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/virtual/trips/{tripId}/commands",
    tags: ["Virtual Dispatch"],
    summary: "Pause, resume, cancel, or change speed",
    security: bearer,
    request: { params: virtualTripIdParamSchema, body: { content: { "application/json": { schema: commandSchema } } } },
    responses: { 200: { description: "Command result", content: { "application/json": { schema: dataResponse } } }, 409: { description: "Invalid trip transition", content: { "application/json": { schema: apiErrorSchema } } } },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/virtual/scenarios/{scenarioId}/vehicles",
    tags: ["Virtual Dispatch"],
    summary: "Create inventory for a virtual vehicle",
    security: bearer,
    request: { params: scenarioIdParamSchema, body: { content: { "application/json": { schema: createVirtualVehicleSchema } } } },
    responses: { 201: { description: "Virtual vehicle", content: { "application/json": { schema: dataResponse } } } },
});
