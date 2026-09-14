import { Router } from "express";

import { vehicleController } from "./vehicle.controller.ts";
import { vehicleIdParamSchema, createVehicleSchema, updateVehicleSchema } from "./vehicle.schema.ts";
import { validateParams } from "../../common/middleware/validate-params.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";


export const vehicleRouter = Router();

vehicleRouter.get(
    "/",
    authenticate,
    requireRole("ADMIN", "OPERATOR", "VIEWER"),
    vehicleController.getAll
);

vehicleRouter.get(
    "/:vehicleId",
    authenticate,
    requireRole("ADMIN", "OPERATOR", "VIEWER"),
    validateParams(vehicleIdParamSchema),
    vehicleController.getById
)

vehicleRouter.delete(
    "/:vehicleId",
    authenticate,
    requireRole("ADMIN"),
    validateParams(vehicleIdParamSchema),
    vehicleController.remove
)

vehicleRouter.post(
    "/",
    authenticate,
    requireRole("ADMIN"),
    validateBody(createVehicleSchema),
    vehicleController.create
)

vehicleRouter.patch(
    "/:vehicleId",
    authenticate,
    requireRole("ADMIN", "OPERATOR"),
    validateParams(vehicleIdParamSchema),
    validateBody(updateVehicleSchema),
    vehicleController.update
)