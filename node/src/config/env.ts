import "dotenv/config"
import { z } from "zod"

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

    DATABASE_URL: z.string().min(1),

    JWT_PRIVATE_KEY_PATH: z.string().min(1),
    JWT_PUBLIC_KEY_PATH: z.string().min(1),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    JWT_ACCESS_TOKEN_TTL: z.string().min(1),
    JWT_KEY_ID: z.string().min(1),

    VISION_PUBLIC_BASE_URL: z.url().default("http://127.0.0.1:8001"),
    LIVE_VIEW_URL: z.url().optional(),
    ROUTING_TRACKING_BASE_URL: z.url().default("http://127.0.0.1:8000"),
});

export const env = envSchema.parse(process.env)
