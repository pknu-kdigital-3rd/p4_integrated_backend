import { Router } from "express";
import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { trackingController } from "./tracking.controller.ts";
import { telemetryModeSchema } from "./tracking.schema.ts";

export const trackingRouter = Router();
trackingRouter.use(authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"));
trackingRouter.get("/vehicles", trackingController.getVehicles);
trackingRouter.get("/vehicles/:vehicleId", trackingController.getVehicle);
trackingRouter.get("/telemetry-mode", trackingController.getTelemetryMode);
trackingRouter.put("/telemetry-mode", requireRole("ADMIN", "OPERATOR"), validateBody(telemetryModeSchema), trackingController.setTelemetryMode);
trackingRouter.get("/trips/:tripId/route", trackingController.getRoute);
