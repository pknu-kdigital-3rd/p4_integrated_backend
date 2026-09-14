import { env } from "../../config/env.ts";
import type { Bootstrap } from "./bootstrap.schema.ts";

export const bootstrapService = {
    getBootstrap(): Bootstrap {
        return {
            services: {
                vision: {
                    baseUrl: env.VISION_PUBLIC_BASE_URL,
                },
                routingTracking: {
                    baseUrl: env.ROUTING_TRACKING_BASE_URL,
                },
            },
            liveViewUrl: env.LIVE_VIEW_URL ?? env.VISION_PUBLIC_BASE_URL,
        };
    },
};
