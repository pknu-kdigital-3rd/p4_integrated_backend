import type { RequestHandler } from "express";
import type { ZodType } from "zod";

export function validateBody<T>(
    schema: ZodType<T>,
): RequestHandler {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);

        if (!result.success) {
            res.status(400).json({
                error: {
                    code: "VALIDATION_ERROR",
                    message: "Invalid request body",
                    issues: result.error.issues.map((issue) => ({
                        path: issue.path.join("."),
                        message: issue.message,
                    })),
                },
            });
            return;
        }
        req.body = result.data;
        next();
    };
}