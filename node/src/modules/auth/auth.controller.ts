import type {
    Request,
    Response,
} from "express";

import { authService } from "./auth.service.ts";
import type { LoginBody } from "./auth.schema.ts"
import { AppError } from "../../common/errors/app-error.ts";

export const authController = {
    async login(
        req: Request<{}, {}, LoginBody>,
        res: Response,
    ) {
        const result = await authService.login(
            req.body,
        );

        res.status(200).json({
            data: result,
        });
    },

    async me(
        req: Request,
        res: Response,
    ) {
        if (!req.auth) {
            throw new AppError(
                401,
                "Authentication required",
                "AUTHENTICATION_REQUIRED",
            );
        }

        res.status(200).json({
            data: req.auth,
        });
    },
};