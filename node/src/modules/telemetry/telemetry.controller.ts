import type { Request, Response } from "express";

import type { DeviceGpsBatchBody, VehicleStreamContextBody } from "./telemetry.schema.ts";
import { telemetryService } from "./telemetry.service.ts";

export const telemetryController = {
    async ingestDeviceGps(req: Request<{}, {}, DeviceGpsBatchBody>, res: Response) {
        const result = await telemetryService.ingestDeviceGps(req.body);
        res.status(200).json({ data: result });
    },
    async validateVehicleContext(req: Request<{}, {}, VehicleStreamContextBody>, res: Response) {
        res.status(200).json(await telemetryService.validateVehicleContext(req.body));
    },
};
