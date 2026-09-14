import { z } from "zod";

export const bootstrapResponseSchema = z.object({
    services: z.object({
        vision: z.object({
            baseUrl: z.url(),
        }),
        routingTracking: z.object({ baseUrl: z.url() }),
    }),
    liveViewUrl: z.url(),
});

export const bootstrapSchema = z.object({
    services: z.object({
        vision: z.object({
            baseUrl: z.string().url(),
        }),
        routingTracking: z.object({ baseUrl: z.string().url() }),
    }),
    liveViewUrl: z.string().url(),
});

export type BootstrapResponse = z.infer<
    typeof bootstrapResponseSchema
>;

export type Bootstrap = z.infer<
    typeof bootstrapSchema
>;
