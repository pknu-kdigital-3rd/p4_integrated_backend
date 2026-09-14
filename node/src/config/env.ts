import "dotenv/config"
import { z } from "zod"

const envBoolean = z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true");

const envSchema = z.object({
    NODE_ENV: z
        .enum(["development", "test", "production"])
        .default("development"),

    PORT: z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .default(3000),

    HOST: z.string().min(1).default("127.0.0.1"),

    DATABASE_URL: z.string().min(1),

    JWT_PRIVATE_KEY_PATH: z.string().min(1),
    JWT_PUBLIC_KEY_PATH: z.string().min(1),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    JWT_ACCESS_TOKEN_TTL: z.string().min(1),
    JWT_KEY_ID: z.string().min(1),

    PUBLIC_OPERATOR_URL: z.url().optional(),
    VISION_PUBLIC_BASE_URL: z.url().default("https://127.0.0.1:39001"),
    LIVE_VIEW_URL: z.url().optional(),
    ROUTING_TRACKING_BASE_URL: z.url().default("http://127.0.0.1:8000"),
    OPERATOR_DEMO_PUBLIC: envBoolean,
    TRUST_PROXY: envBoolean,
}).superRefine((value, context) => {
    if (value.NODE_ENV !== "production") return;

    if (!value.PUBLIC_OPERATOR_URL) {
        context.addIssue({ code: "custom", path: ["PUBLIC_OPERATOR_URL"], message: "PUBLIC_OPERATOR_URL is required in production" });
    }

    for (const [name, configuredUrl] of [
        ["PUBLIC_OPERATOR_URL", value.PUBLIC_OPERATOR_URL],
        ["VISION_PUBLIC_BASE_URL", value.VISION_PUBLIC_BASE_URL],
        ["LIVE_VIEW_URL", value.LIVE_VIEW_URL ?? value.VISION_PUBLIC_BASE_URL],
    ] as const) {
        if (configuredUrl && new URL(configuredUrl).protocol !== "https:") {
            context.addIssue({ code: "custom", path: [name], message: `${name} must use HTTPS in production` });
        }
    }
});

export const env = envSchema.parse(process.env)
