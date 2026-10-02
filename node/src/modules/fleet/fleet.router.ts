import { Router } from "express";

import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";
import { fleetController } from "./fleet.controller.ts";

export const fleetRouter = Router();

fleetRouter.get("/summary", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), fleetController.summary);
