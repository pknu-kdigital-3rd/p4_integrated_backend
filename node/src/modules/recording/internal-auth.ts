import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

import { env } from "../../config/env.ts";
import { AppError } from "../../common/errors/app-error.ts";

export const requireInternalServiceToken: RequestHandler = (req, _res, next) => {
    const expected = env.NODE_INTERNAL_SERVICE_TOKEN;
    if (!env.RECORDING_ENABLED || !expected) {
        throw new AppError(503, "Recording service is disabled", "RECORDING_DISABLED");
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
