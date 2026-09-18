import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

import { env } from "../../config/env.ts";
import { AppError } from "../errors/app-error.ts";

/**
 * Authenticates same-host service calls (Go relay, Vision) to /internal/*.
 * Internal APIs exist only while a feature that needs them is enabled, so the
 * token is rejected outright when neither recording nor Android telemetry is on.
 */
export const requireInternalServiceToken: RequestHandler = (req, _res, next) => {
    const expected = env.NODE_INTERNAL_SERVICE_TOKEN;
    if (!(env.RECORDING_ENABLED || env.ANDROID_TELEMETRY_ENABLED) || !expected) {
        throw new AppError(503, "Internal services are disabled", "INTERNAL_SERVICES_DISABLED");
    }
    const supplied = req.header("X-Internal-Service-Token");
    if (!supplied) {
        throw new AppError(401, "Internal service authentication required", "INTERNAL_AUTHENTICATION_REQUIRED");
    }
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
        throw new AppError(401, "Invalid internal service token", "INVALID_INTERNAL_SERVICE_TOKEN");
    }
    next();
};

export function requireFeatureEnabled(enabled: () => boolean, message: string, code: string): RequestHandler {
    return (_req, _res, next) => {
        if (!enabled()) {
            throw new AppError(503, message, code);
        }
        next();
    };
}
