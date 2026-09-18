import type { Request, Response } from "express";

import type { DeviceGpsBatchBody } from "./telemetry.schema.ts";
import { telemetryService } from "./telemetry.service.ts";

export const telemetryController = {
    async ingestDeviceGps(req: Request<{}, {}, DeviceGpsBatchBody>, res: Response) {
        const result = await telemetryService.ingestDeviceGps(req.body);
        res.status(200).json({ data: result });
    },
};
