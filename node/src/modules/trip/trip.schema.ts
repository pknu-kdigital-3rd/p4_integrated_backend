import { z } from "zod";
import { routeModeSchema } from "./trip.preview.ts";

const optionalText = z.string().trim().max(150).optional();
const optionalAddress = z.string().trim().max(2000).optional();

export const tripIdParamSchema = z.object({
    tripId: z.string().regex(/^[1-9][0-9]{0,18}$/)
        .refine(value => BigInt(value) <= 9_223_372_036_854_775_807n, "Trip ID exceeds database range"),
});

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
    routeMode: routeModeSchema.default("DUAL"),
    replayPreviewId: z.string().regex(/^[1-9]\d*$/).optional(),
    destinationName: z.string().trim().min(1).max(150).optional(),
    destinationAddress: optionalAddress,
    destinationLatitude: z.number().finite().min(-90).max(90).optional(),
    destinationLongitude: z.number().finite().min(-180).max(180).optional(),
    tripStatus: z.enum(["READY", "IN_PROGRESS"]).default("READY"),
    plannedStartAt: z.iso.datetime({ offset: true }).optional(),
}).superRefine((input, context) => {
    if (input.routeMode === "DUAL" && (input.destinationName === undefined || input.destinationLatitude === undefined || input.destinationLongitude === undefined)) {
        context.addIssue({ code: "custom", path: ["destinationLatitude"], message: "Dual mode requires a destination name and coordinates" });
    }
    if (input.routeMode === "REPLAY_ONLY" && !input.replayPreviewId) {
        context.addIssue({ code: "custom", path: ["replayPreviewId"], message: "Replay-only mode requires an Android GPS preview" });
    }
    // Android's start transition is where the selected dataset is checked against the pin.
    if (input.routeMode === "REPLAY_ONLY" && input.tripStatus === "IN_PROGRESS") {
        context.addIssue({ code: "custom", path: ["tripStatus"], message: "Replay-only trips start from Android" });
    }
    if ((input.originLatitude === undefined) !== (input.originLongitude === undefined)) {
        context.addIssue({
            code: "custom",
            path: [input.originLatitude === undefined ? "originLatitude" : "originLongitude"],
            message: "Set both origin coordinates or leave both empty",
        });
    }
});

export type CreateTripBody = z.infer<typeof createTripSchema>;
