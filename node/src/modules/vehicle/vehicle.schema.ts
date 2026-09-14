import { z } from "zod";
import {
    decimalSchema,
} from "../../common/schema/api.schema.ts";

export const vehicleIdParamSchema = z.object({
    vehicleId: z
        .string()
        .regex(/^[1-9]\d*$/, "vehicleId must be a positive integer"),
});

export type VehicleIdParam = z.infer<
    typeof vehicleIdParamSchema
>;

export const vehicleStatusSchema = z.enum([
    "READY",
    "DRIVING",
    "STOPPED",
    "MAINTENANCE",
    "OFFLINE",
]);

export const vehicleSourceSchema = z.enum(["CUSTOM", "BIMS"]);

export const createVehicleSchema = z.object({
    vehicleCode: z.string().trim().min(1).max(50),

    plateNumber: z.string().trim().max(30).optional(),

    vehicleName: z.string().trim().max(100).optional(),
    vehicleSource: vehicleSourceSchema.default("CUSTOM"),
    externalId: z.string().trim().min(1).max(100).optional(),

    maxLoadKg: decimalSchema.optional(),

    heightM: decimalSchema.optional(),
    widthM: decimalSchema.optional(),
    lengthM: decimalSchema.optional(),

    vehicleStatus: vehicleStatusSchema,

    // NOTE: If `grcp://host:port` doesn't work, use z.string().min(1) as schema
    streamUrl: z.url().optional(),

    cameraHeightM: decimalSchema.optional(),
    cameraPitchDeg: decimalSchema.optional(),
    cameraRollDeg: decimalSchema.optional(),
    cameraYawDeg: decimalSchema.optional(),

    focalLengthMm: decimalSchema.optional(),
    sensorWidthMm: decimalSchema.optional(),

    isActive: z.boolean().optional(),
});

export type CreateVehicleBody = z.infer<
    typeof createVehicleSchema
>;

export const updateVehicleSchema = createVehicleSchema
    .partial()
    .refine(
        (data) => Object.keys(data).length > 0,
        {
            message: "At least one field must be provided",
        },
    );

export type UpdateVehicleBody = z.infer<
    typeof updateVehicleSchema
>;

