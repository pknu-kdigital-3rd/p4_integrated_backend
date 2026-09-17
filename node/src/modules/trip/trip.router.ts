import { Router } from "express";
import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { tripController } from "./trip.controller.ts";
import { createTripSchema } from "./trip.schema.ts";

export const tripRouter = Router();

tripRouter.get(
    "/",
    authenticate,
    requireRole("ADMIN", "OPERATOR", "VIEWER"),
    tripController.getAll,
);

tripRouter.post(
    "/",
    authenticate,
    requireRole("ADMIN", "OPERATOR"),
    validateBody(createTripSchema),
    tripController.create,
);
