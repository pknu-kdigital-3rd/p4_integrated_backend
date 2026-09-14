import { Router } from "express";
import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";
import { trackingController } from "./tracking.controller.ts";

export const trackingRouter = Router();
trackingRouter.use(authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"));
trackingRouter.get("/vehicles", trackingController.getVehicles);
trackingRouter.get("/vehicles/:vehicleId", trackingController.getVehicle);
trackingRouter.get("/trips/:tripId/route", trackingController.getRoute);
