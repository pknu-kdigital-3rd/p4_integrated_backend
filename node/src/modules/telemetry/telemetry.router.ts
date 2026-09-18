import { Router } from "express";

import { requireFeatureEnabled, requireInternalServiceToken } from "../../common/auth/require-internal-service-token.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { env } from "../../config/env.ts";
import { telemetryController } from "./telemetry.controller.ts";
import { deviceGpsBatchSchema } from "./telemetry.schema.ts";

export const internalTelemetryRouter = Router();
internalTelemetryRouter.use(requireInternalServiceToken);
internalTelemetryRouter.use(requireFeatureEnabled(
    () => env.ANDROID_TELEMETRY_ENABLED,
    "Android telemetry is disabled",
    "TELEMETRY_DISABLED",
));
internalTelemetryRouter.post("/gps", validateBody(deviceGpsBatchSchema), telemetryController.ingestDeviceGps);
