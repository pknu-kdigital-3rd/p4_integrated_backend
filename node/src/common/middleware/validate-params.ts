import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export function validateParams<T>(
    schema: ZodType<T>,
): RequestHandler {
    return (req, res, next) => {
        const result = schema.safeParse(req.params);

        if (!result.success) {
            res.status(400).json({
                error: {
                    code: "VALIDATION_ERROR",
                    message: "Invalid path parameter",
                    issues: result.error.issues.map((issue) => ({
                        path: issue.path.join("."),
                        message: issue.message,
                    })),
                },
            });
            return;
        }
        req.params = result.data as typeof req.params;
        next();
    };
}