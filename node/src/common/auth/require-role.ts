import type { NextFunction, Request, Response } from "express";
import { UserRole } from "./jwt.schema.ts";
import { AppError } from "../errors/app-error.ts";

export function requireRole(
    ...allowedRoles: UserRole[]
) {
    return function (
        req: Request,
        _res: Response,
        next: NextFunction,
    ) {
        if (!req.auth) {
            throw new AppError(
                401,
                "Authentication required",
                "AUTHENTICATION_REQUIRED",
            );
        }

        if (!allowedRoles.includes(req.auth.role)) {
            throw new AppError(
                403,
                "Insufficient permissions",
                "FORBIDDEN",
            );
        }

        next();
    };
}