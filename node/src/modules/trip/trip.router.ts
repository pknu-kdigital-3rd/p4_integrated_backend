import { Router } from "express";
import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { tripController } from "./trip.controller.ts";
import { createTripSchema, tripIdParamSchema } from "./trip.schema.ts";
import { validateParams } from "../../common/middleware/validate-params.ts";

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
tripRouter.get("/:tripId/display", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), tripController.display);
tripRouter.post("/:tripId/cancel", authenticate, requireRole("ADMIN", "OPERATOR"), tripController.cancel);
tripRouter.delete("/:tripId", authenticate, requireRole("ADMIN", "OPERATOR"), validateParams(tripIdParamSchema), tripController.delete);
tripRouter.get("/vehicles/:vehicleId/replay-preview", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), tripController.latestPreview);
