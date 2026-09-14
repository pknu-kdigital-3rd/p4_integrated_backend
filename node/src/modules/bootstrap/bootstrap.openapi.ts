import { registry } from "../../docs/registry.ts";
import { apiErrorSchema } from "../../common/schema/api.schema.ts";
import { bootstrapResponseSchema } from "./bootstrap.schema.ts";

registry.registerPath({
    method: "get",
    path: "/api/v1/bootstrap",

    tags: ["Bootstrap"],

    summary: "Get runtime service discovery information",

    security: [
        {
            bearerAuth: [],
        },
    ],

    responses: {
        200: {
            description: "Bootstrap information",
            content: {
                "application/json": {
                    schema: bootstrapResponseSchema,
                },
            },
        },

        401: {
            description: "Authentication required",
            content: {
                "application/json": {
                    schema: apiErrorSchema,
                },
            },
        },
    },
});