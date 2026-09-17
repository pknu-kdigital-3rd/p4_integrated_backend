import {
    OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";

import { registry } from "./registry.ts";
import { env } from "../config/env.ts";

// Registration side effects
import "../modules/vehicle/vehicle.openapi.ts";
import "../modules/bootstrap/bootstrap.openapi.ts";
import "../modules/tracking/tracking.openapi.ts";
import "../modules/trip/trip.openapi.ts";
import "../modules/recording/recording.openapi.ts";

const generator = new OpenApiGeneratorV3(
    registry.definitions,
);

export const openApiDocument = generator.generateDocument({
    openapi: "3.0.0",

    info: {
        title: "Intelligent Vehicle Transportation System API",
        version: "1.0.0.",
        description: "Node/Express backend API for the vehicle platform",
    },

    servers: [
        {
            url: env.PUBLIC_OPERATOR_URL ?? `http://${env.HOST}:${env.PORT}`,
            description: env.PUBLIC_OPERATOR_URL ? "HTTPS operator ingress" : "Local development server",
        },
    ],
});
