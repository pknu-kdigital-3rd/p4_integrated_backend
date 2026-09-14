import { Router } from "express";

import { authenticate } from "../../common/auth/authenticate.ts";
import { bootstrapController } from "./bootstrap.controller.ts";

export const bootstrapRouter = Router();

bootstrapRouter.get(
    "/",
    authenticate,
    bootstrapController.getBootstrap,
);