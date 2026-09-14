import { Router } from "express";
import { loginBodySchema } from "./auth.schema.ts";
import { authController } from "./auth.controller.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { authenticate } from "../../common/auth/authenticate.ts";

export const authRouter = Router();

authRouter.post(
    "/login",
    validateBody(loginBodySchema),
    authController.login,
);

authRouter.get(
    "/me",
    authenticate,
    authController.me,
);