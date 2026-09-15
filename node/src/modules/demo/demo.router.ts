import { Router } from "express";
import { env } from "../../config/env.ts";
import { loginBodySchema } from "../auth/auth.schema.ts";
import { authController } from "../auth/auth.controller.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { bootstrapService } from "../bootstrap/bootstrap.service.ts";
import { trackingService } from "../tracking/tracking.service.ts";

/** Temporary read-only operator demo surface. Authenticated production routes are unchanged. */
export const demoRouter = Router();

demoRouter.use((_req, res, next) => {
    if (!env.OPERATOR_DEMO_PUBLIC) {
        res.status(404).json({ error: { code: "DEMO_MODE_DISABLED", message: "Public demo mode is disabled" } });
        return;
    }
    next();
});

demoRouter.get("/bootstrap", (_req, res) => {
    res.json({ data: bootstrapService.getBootstrap() });
});

// Compatibility endpoint for older dashboard bundles. New bundles use the
// regular auth endpoint when demo bootstrap is unavailable.
demoRouter.post("/auth/login", validateBody(loginBodySchema), authController.login);

demoRouter.get("/tracking/vehicles", async (_req, res) => {
    res.json({ data: await trackingService.getVehicles() });
});
