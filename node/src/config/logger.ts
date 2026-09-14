import pino, { type LoggerOptions } from "pino";

import { env } from "./env.ts";

const options: LoggerOptions = {
    level: env.NODE_ENV === "test"
        ? "silent"
        : env.NODE_ENV === "production"
            ? "info"
            : "debug",
    redact: {
        paths: [
            "req.headers.authorization",
            "req.headers.cookie",
        ],
        censor: "[REDACTED]",
    },
}

if (env.NODE_ENV === "development") {
    options.transport = {
        target: "pino-pretty",
        options: {
            translateTime: "SYS:standard",
            ignore: "pid,hostname"
        },
    };
}

export const logger = pino(options)