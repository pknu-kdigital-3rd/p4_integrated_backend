import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import {
    playbackUrlResponseSchema,
    recordingContextSchema,
    recordingDeleteResponseSchema,
    recordingDetailResponseSchema,
    recordingListResponseSchema,
    replayDetectionBatchSchema,
    replayDetectionResponseSchema,
    recordingSegmentSchema,
    recordingSummarySchema,
    registeredSegmentResponseSchema,
    tripVideoReplayParamsSchema,
} from "./recording.schema.ts";

registry.registerComponent("securitySchemes", "internalServiceToken", {
    type: "apiKey",
    in: "header",
    name: "X-Internal-Service-Token",
});

registry.registerPath({
    method: "post",
    path: "/internal/recordings/validate",
    tags: ["Internal Recording"],
    summary: "Validate a recording trip and publisher identity",
    security: [{ internalServiceToken: [] }],
    request: { body: { content: { "application/json": { schema: recordingContextSchema } } } },
    responses: {
        200: { description: "Validated recording context", content: { "application/json": { schema: recordingContextSchema } } },
        401: { description: "Invalid internal service token", content: { "application/json": { schema: apiErrorSchema } } },
        409: { description: "Trip is not active for the vehicle", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "post",
    path: "/internal/recordings/segments",
    tags: ["Internal Recording"],
    summary: "Idempotently register a finalized recording segment",
    security: [{ internalServiceToken: [] }],
    request: { body: { content: { "application/json": { schema: recordingSegmentSchema } } } },
    responses: {
        200: { description: "The segment was already registered", content: { "application/json": { schema: registeredSegmentResponseSchema } } },
        201: { description: "The segment was registered", content: { "application/json": { schema: registeredSegmentResponseSchema } } },
        401: { description: "Invalid internal service token", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "post",
    path: "/internal/recordings/detections",
    tags: ["Internal Recording"],
    summary: "Idempotently store replay detection samples",
    security: [{ internalServiceToken: [] }],
    request: { body: { content: { "application/json": { schema: replayDetectionBatchSchema } } } },
    responses: {
        200: { description: "Detection samples accepted", content: { "application/json": { schema: { type: "object" } } } },
        401: { description: "Invalid internal service token", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/trips/{tripId}/videos",
    tags: ["Recording"],
    summary: "List finalized video segments for a trip",
    security: [{ bearerAuth: [] }],
    request: { params: recordingContextSchema.pick({ tripId: true }) },
    responses: {
        200: { description: "Trip video segments", content: { "application/json": { schema: recordingListResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/trip-videos/{tripVideoId}",
    tags: ["Recording"],
    summary: "Get recording segment metadata",
    security: [{ bearerAuth: [] }],
    request: { params: recordingSummarySchema.pick({ tripVideoId: true }) },
    responses: {
        200: { description: "Recording metadata", content: { "application/json": { schema: recordingDetailResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
        404: { description: "Recording not found", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "get",
    path: "/api/v1/trips/{tripId}/videos/{tripVideoId}/detections",
    tags: ["Recording"],
    summary: "List ordered detection samples for a trip video segment",
    security: [{ bearerAuth: [] }],
    request: { params: tripVideoReplayParamsSchema },
    responses: {
        200: { description: "Replay detections and coverage status", content: { "application/json": { schema: replayDetectionResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
        404: { description: "Recording segment not found for this trip", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "post",
    path: "/api/v1/trip-videos/{tripVideoId}/playback-url",
    tags: ["Recording"],
    summary: "Create a short-lived MinIO playback URL",
    security: [{ bearerAuth: [] }],
    request: { params: recordingSummarySchema.pick({ tripVideoId: true }) },
    responses: {
        200: { description: "Presigned video URL", content: { "application/json": { schema: playbackUrlResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
        409: { description: "Segment is not available", content: { "application/json": { schema: apiErrorSchema } } },
    },
});

registry.registerPath({
    method: "delete",
    path: "/api/v1/trip-videos/{tripVideoId}",
    tags: ["Recording"],
    summary: "Permanently delete a finalized recording segment and its replay detections",
    security: [{ bearerAuth: [] }],
    request: { params: recordingSummarySchema.pick({ tripVideoId: true }) },
    responses: {
        200: { description: "Recording segment deleted", content: { "application/json": { schema: recordingDeleteResponseSchema } } },
        401: { description: "Authentication required", content: { "application/json": { schema: apiErrorSchema } } },
        403: { description: "Admin or operator role required", content: { "application/json": { schema: apiErrorSchema } } },
        404: { description: "Recording segment not found", content: { "application/json": { schema: apiErrorSchema } } },
        409: { description: "Recording segment cannot be deleted", content: { "application/json": { schema: apiErrorSchema } } },
        503: { description: "Recording object storage is unavailable", content: { "application/json": { schema: apiErrorSchema } } },
    },
});
