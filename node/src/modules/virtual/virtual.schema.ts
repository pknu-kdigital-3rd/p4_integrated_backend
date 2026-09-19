import { z } from "zod";

const coordinate = z.object({
    lat: z.number().finite().min(-90).max(90),
    lon: z.number().finite().min(-180).max(180),
});

const waypoint = coordinate.extend({
    clientId: z.string().trim().min(1).max(80).optional(),
});

export const scenarioIdParamSchema = z.object({
    scenarioId: z.string().regex(/^[1-9]\d*$/),
});

export const requestIdParamSchema = z.object({
    requestId: z.string().regex(/^[1-9]\d*$/),
});

export const virtualVehicleIdParamSchema = z.object({
    vehicleId: z.string().regex(/^[1-9]\d*$/),
});

export const virtualTripIdParamSchema = z.object({
    tripId: z.string().regex(/^[1-9]\d*$/),
});

export const restrictionIdParamSchema = z.object({
    restrictionId: z.string().regex(/^[1-9]\d*$/),
});

export const createScenarioSchema = z.object({
    name: z.string().trim().min(1).max(120),
    autoAcceptAfterSeconds: z.number().int().min(0).max(86400).nullable().optional(),
});

export const createVirtualVehicleSchema = z.object({
    vehicleCode: z.string().trim().min(1).max(50),
    vehicleName: z.string().trim().max(100).optional(),
    heightM: z.number().positive().max(20).optional(),
    widthM: z.number().positive().max(20).optional(),
    lengthM: z.number().positive().max(100).optional(),
    maxLoadKg: z.number().nonnegative().max(1000000).optional(),
    vehicleProfile: z.enum(["small", "semi", "special", "car"]).default("small"),
    autoFollowEnabled: z.boolean().default(true),
});

export const routePreviewSchema = z.object({
    selectedVehicleId: z.string().regex(/^[1-9]\d*$/),
    origin: coordinate,
    destination: coordinate,
    waypoints: z.array(waypoint).max(32).default([]),
    expectedRestrictionRevision: z.number().int().nonnegative().optional(),
});

export const dispatchRequestSchema = z.object({
    draftId: z.string().regex(/^[1-9]\d*$/),
    selectedVehicleId: z.string().regex(/^[1-9]\d*$/),
    idempotencyKey: z.string().trim().min(8).max(120),
});

export const commandSchema = z.discriminatedUnion("command", [
    z.object({ command: z.literal("PAUSE") }),
    z.object({ command: z.literal("RESUME") }),
    z.object({ command: z.literal("CANCEL_TRIP") }),
    z.object({ command: z.literal("SET_SPEED_FACTOR"), speedFactor: z.number().positive().max(20) }),
    z.object({ command: z.literal("SET_SPEED_KMH"), speedKmh: z.union([z.literal(25), z.literal(50), z.literal(100), z.literal(200)]) }),
    z.object({ command: z.literal("APPLY_ROUTE_CANDIDATE") }),
]);

export const followingSchema = z.object({
    enabled: z.boolean(),
    expectedPolicyVersion: z.number().int().positive().optional(),
    idempotencyKey: z.string().trim().min(8).max(120),
});

export const virtualVehicleLifecycleSchema = z.object({
    isActive: z.boolean(),
});

export const waypointsSchema = z.object({
    waypoints: z.array(waypoint).max(32),
    expectedTripRevision: z.number().int().positive(),
});

export const destinationSchema = z.object({
    destination: coordinate,
    expectedTripRevision: z.number().int().positive(),
});

const polygonCoordinates = z.array(z.array(z.array(z.number().finite()))).min(1).max(1000);
export const restrictionSchema = z.object({
    kind: z.enum(["BLOCKED", "HEAVY_PENALTY"]),
    geometry: z.object({
        type: z.enum(["Polygon", "MultiPolygon"]),
        coordinates: polygonCoordinates,
    }),
    reason: z.string().trim().max(240).optional(),
    penaltyFactor: z.number().finite().gt(1).max(100).optional(),
    expectedRestrictionRevision: z.number().int().nonnegative().optional(),
}).superRefine((value, context) => {
    if (value.kind === "HEAVY_PENALTY" && value.penaltyFactor === undefined) {
        context.addIssue({ code: "custom", path: ["penaltyFactor"], message: "penaltyFactor is required for HEAVY_PENALTY" });
    }
    if (value.kind === "BLOCKED" && value.penaltyFactor !== undefined) {
        context.addIssue({ code: "custom", path: ["penaltyFactor"], message: "penaltyFactor is not allowed for BLOCKED" });
    }
});

export const restrictionUpdateSchema = z.object({
    isActive: z.boolean().optional(),
    kind: z.enum(["BLOCKED", "HEAVY_PENALTY"]).optional(),
    geometry: z.object({ type: z.enum(["Polygon", "MultiPolygon"]), coordinates: polygonCoordinates }).optional(),
    reason: z.string().trim().max(240).nullable().optional(),
    penaltyFactor: z.number().finite().gt(1).max(100).nullable().optional(),
    expectedRestrictionRevision: z.number().int().nonnegative().optional(),
}).superRefine((value, context) => {
    if (value.kind === "BLOCKED" && value.penaltyFactor !== undefined && value.penaltyFactor !== null) context.addIssue({ code: "custom", path: ["penaltyFactor"], message: "penaltyFactor is not allowed for BLOCKED" });
    if (value.kind === "HEAVY_PENALTY" && value.penaltyFactor === undefined) context.addIssue({ code: "custom", path: ["penaltyFactor"], message: "penaltyFactor is required when changing to HEAVY_PENALTY" });
});

export type Coordinate = z.infer<typeof coordinate>;
export type WaypointInput = z.infer<typeof waypoint>;
export type CreateScenarioBody = z.infer<typeof createScenarioSchema>;
export type CreateVirtualVehicleBody = z.infer<typeof createVirtualVehicleSchema>;
export type RoutePreviewBody = z.infer<typeof routePreviewSchema>;
export type DispatchRequestBody = z.infer<typeof dispatchRequestSchema>;
export type CommandBody = z.infer<typeof commandSchema>;
export type FollowingBody = z.infer<typeof followingSchema>;
export type VirtualVehicleLifecycleBody = z.infer<typeof virtualVehicleLifecycleSchema>;
export type WaypointsBody = z.infer<typeof waypointsSchema>;
export type DestinationBody = z.infer<typeof destinationSchema>;
export type RestrictionBody = z.infer<typeof restrictionSchema>;
export type RestrictionUpdateBody = z.infer<typeof restrictionUpdateSchema>;
