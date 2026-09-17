import { z } from "zod";
import { bigintIdSchema, dateTimeSchema } from "../../common/schema/api.schema.ts";
import { tripStatusSchema } from "./trip.schema.ts";

export const tripSummarySchema = z.object({
    tripId: bigintIdSchema,
    vehicleId: bigintIdSchema,
    originName: z.string().nullable(),
    destinationName: z.string(),
    tripStatus: tripStatusSchema,
    plannedStartAt: dateTimeSchema.nullable(),
    startedAt: dateTimeSchema.nullable(),
    createdAt: dateTimeSchema,
    vehicle: z.object({
        vehicleId: bigintIdSchema,
        vehicleCode: z.string(),
        vehicleName: z.string().nullable(),
        vehicleStatus: z.string(),
    }),
});

export const tripListResponseSchema = z.object({
    data: z.array(tripSummarySchema),
});

export const tripDataResponseSchema = z.object({
    data: tripSummarySchema,
});
