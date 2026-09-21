import type { Request, Response } from "express";
import { trackingService } from "./tracking.service.ts";
import type { TelemetryMode } from "./tracking.client.ts";

export const trackingController = {
    async getVehicles(_req: Request, res: Response) { res.json({ data: await trackingService.getVehicles() }); },
    async getVehicle(req: Request, res: Response) { res.json({ data: await trackingService.getVehicle(BigInt(req.params.vehicleId as string)) }); },
    async getTelemetryMode(_req: Request, res: Response) { res.json({ data: await trackingService.getTelemetryMode() }); },
    async setTelemetryMode(req: Request, res: Response) { res.json({ data: await trackingService.setTelemetryMode((req.body as { mode: TelemetryMode }).mode) }); },
    async getRoute(req: Request, res: Response) { res.json({ data: await trackingService.getPlannedRoute(BigInt(req.params.tripId as string)) }); },
};
