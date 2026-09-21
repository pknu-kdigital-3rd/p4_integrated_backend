import "dotenv/config"
import { z } from "zod"

const envBoolean = z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true");

const envBooleanDefaultTrue = z
    .enum(["true", "false"])
    .default("true")
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
    VISION_PUBLIC_BASE_URL: z.url().default("https://127.0.0.1:39002"),
    LIVE_VIEW_URL: z.url().optional(),
    ROUTING_TRACKING_BASE_URL: z.url().default("http://127.0.0.1:8000"),
    OPERATOR_DEMO_PUBLIC: envBoolean,
    TRUST_PROXY: envBoolean,
    RECORDING_ENABLED: envBoolean,
    RECORDING_VALIDATE_TRIP_CONTEXT: envBooleanDefaultTrue,
    NODE_INTERNAL_SERVICE_TOKEN: z.string().optional(),
    MINIO_RECORDING_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).refine(value => !value.includes("..")).default("p4-trip-recordings"),
    MINIO_ENDPOINT: z.string().min(1).default("127.0.0.1:9000"),
    MINIO_USE_SSL: envBoolean,
    MINIO_NODE_ACCESS_KEY: z.string().optional(),
    MINIO_NODE_SECRET_KEY: z.string().optional(),
    MINIO_PUBLIC_ENDPOINT: z.url().optional(),
    RECORDING_PLAYBACK_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(604800).default(300),
    // Enables POST /internal/telemetry/gps (Go relay -> authoritative GPS persistence).
    ANDROID_TELEMETRY_ENABLED: envBoolean,
}).superRefine((value, context) => {
    if (value.RECORDING_ENABLED || value.ANDROID_TELEMETRY_ENABLED) {
        if (!value.NODE_INTERNAL_SERVICE_TOKEN || value.NODE_INTERNAL_SERVICE_TOKEN.length < 32) {
            context.addIssue({ code: "custom", path: ["NODE_INTERNAL_SERVICE_TOKEN"], message: "a service token of at least 32 characters is required when recording or Android telemetry is enabled" });
        } else if (value.NODE_INTERNAL_SERVICE_TOKEN.startsWith("replace-")) {
            context.addIssue({ code: "custom", path: ["NODE_INTERNAL_SERVICE_TOKEN"], message: "replace the example service token before enabling recording or Android telemetry" });
        }
    }
    if (value.RECORDING_ENABLED) {
        if (!value.MINIO_NODE_ACCESS_KEY || !value.MINIO_NODE_SECRET_KEY) {
            context.addIssue({ code: "custom", path: ["MINIO_NODE_ACCESS_KEY"], message: "Node MinIO credentials are required when recording is enabled" });
        } else if (value.MINIO_NODE_SECRET_KEY.length < 12 || value.MINIO_NODE_SECRET_KEY.startsWith("replace-")) {
            context.addIssue({ code: "custom", path: ["MINIO_NODE_SECRET_KEY"], message: "set a non-example Node MinIO secret of at least 12 characters" });
        }
        if (!value.MINIO_PUBLIC_ENDPOINT) {
            context.addIssue({ code: "custom", path: ["MINIO_PUBLIC_ENDPOINT"], message: "MINIO_PUBLIC_ENDPOINT is required when recording is enabled" });
        } else {
            const endpoint = new URL(value.MINIO_PUBLIC_ENDPOINT);
            if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
                context.addIssue({ code: "custom", path: ["MINIO_PUBLIC_ENDPOINT"], message: "MINIO_PUBLIC_ENDPOINT must be an origin without a path, query, or fragment" });
            }
        }
    }

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

    if (value.RECORDING_ENABLED && value.MINIO_PUBLIC_ENDPOINT && new URL(value.MINIO_PUBLIC_ENDPOINT).protocol !== "https:") {
        context.addIssue({ code: "custom", path: ["MINIO_PUBLIC_ENDPOINT"], message: "MINIO_PUBLIC_ENDPOINT must use HTTPS in production" });
    }
});

export const env = envSchema.parse(process.env)
