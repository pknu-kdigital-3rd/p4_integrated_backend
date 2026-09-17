import { z } from "zod";

const optionalText = z.string().trim().max(150).optional();
const optionalAddress = z.string().trim().max(2000).optional();

export const tripStatusSchema = z.enum([
    "READY",
    "IN_PROGRESS",
    "PAUSED",
    "COMPLETED",
    "CANCELLED",
]);

export const createTripSchema = z.object({
    vehicleId: z.string().regex(/^[1-9]\d*$/, "vehicleId must be a positive integer"),
    originName: optionalText,
    originAddress: optionalAddress,
    originLatitude: z.number().finite().min(-90).max(90).optional(),
    originLongitude: z.number().finite().min(-180).max(180).optional(),
    destinationName: z.string().trim().min(1).max(150),
    destinationAddress: optionalAddress,
    destinationLatitude: z.number().finite().min(-90).max(90),
    destinationLongitude: z.number().finite().min(-180).max(180),
    tripStatus: z.enum(["READY", "IN_PROGRESS"]).default("READY"),
    plannedStartAt: z.iso.datetime({ offset: true }).optional(),
}).superRefine((input, context) => {
    if ((input.originLatitude === undefined) !== (input.originLongitude === undefined)) {
        context.addIssue({
            code: "custom",
            path: [input.originLatitude === undefined ? "originLatitude" : "originLongitude"],
            message: "Set both origin coordinates or leave both empty",
        });
    }
});

export type CreateTripBody = z.infer<typeof createTripSchema>;
