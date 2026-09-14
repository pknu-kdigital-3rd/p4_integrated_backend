import type {
    ErrorRequestHandler,
    RequestHandler,
} from "express";

import { AppError } from "./app-error.ts";

import { logger } from "../../config/logger.ts";
import { Prisma } from "../../generated/prisma/client.ts";

export const notFoundHandler: RequestHandler = (req, res) => {
    res.status(404).json({
        error: {
            code: "ROUTE_NOT_FOUND",
            message: `Route not found: ${req.method} ${req.originalUrl}`,
        },
    });
};

export const errorHandler: ErrorRequestHandler = (
    err, _req, res, _next,
) => {
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            error: {
                code: err.code ?? "APPLICATION_ERROR",
                message: err.message,
            },
        });
        return;
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === "P2002") {
            res.status(409).json({
                error: {
                    code: "RESOURCE_ALREADY_EXISTS",
                    message: "Resource already exists",
                },
            });
            return;
        }
    }

    if (err.code === "P2025") {
        res.status(404).json({
            error: {
                code: "RESOURCE_NOT_FOUND",
                message: "Resource not found",
            },
        });
        return;
    }

    logger.error({ err }, "Unhandled application error");

    res.status(500).json({
        error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal server error",
        },
    });
};