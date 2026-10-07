import { z } from "zod";

export const bootstrapResponseSchema = z.object({
    services: z.object({
        vision: z.object({
            baseUrl: z.url(),
        }),
        routingTracking: z.object({ baseUrl: z.url() }),
    }),
    liveViewUrl: z.url(),
    videoSource: z.object({ mode: z.enum(["server", "relay"]), vehicleId: z.string() }).optional(),
});

export const bootstrapSchema = z.object({
    services: z.object({
        vision: z.object({
            baseUrl: z.string().url(),
        }),
        routingTracking: z.object({ baseUrl: z.string().url() }),
    }),
    liveViewUrl: z.string().url(),
    videoSource: z.object({ mode: z.enum(["server", "relay"]), vehicleId: z.string() }).optional(),
});

export type BootstrapResponse = z.infer<
    typeof bootstrapResponseSchema
>;

export type Bootstrap = z.infer<
    typeof bootstrapSchema
>;
