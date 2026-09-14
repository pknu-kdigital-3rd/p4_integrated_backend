import { z } from "zod";

import {
    bigintIdSchema,
    dateTimeSchema,
    decimalSchema,
} from "../../common/schema/api.schema.ts";

import {
    vehicleStatusSchema,
    vehicleSourceSchema,
} from "./vehicle.schema.ts";

export const vehicleResponseSchema = z.object({
    vehicleId: bigintIdSchema,

    vehicleCode: z.string(),
    plateNumber: z.string().nullable(),
    vehicleName: z.string().nullable(),
    vehicleSource: vehicleSourceSchema,
    externalId: z.string().nullable(),

    vehicleStatus: vehicleStatusSchema,

    streamUrl: z.string().nullable(),

    isActive: z.boolean(),

    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,

    maxLoadKg: decimalSchema.nullable(),

    heightM: decimalSchema.nullable(),
    widthM: decimalSchema.nullable(),
    lengthM: decimalSchema.nullable(),

    cameraHeightM: decimalSchema.nullable(),
    cameraPitchDeg: decimalSchema.nullable(),
    cameraRollDeg: decimalSchema.nullable(),
    cameraYawDeg: decimalSchema.nullable(),

    focalLengthMm: decimalSchema.nullable(),
    sensorWidthMm: decimalSchema.nullable(),
});

export const vehicleDataResponseSchema = z.object({
    data: vehicleResponseSchema,
});

export const vehicleListResponseSchema = z.object({
    data: z.array(vehicleResponseSchema),
});
