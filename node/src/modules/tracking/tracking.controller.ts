import type { Request, Response } from "express";
import { trackingService } from "./tracking.service.ts";

export const trackingController = {
    async getVehicles(_req: Request, res: Response) { res.json({ data: await trackingService.getVehicles() }); },
    async getVehicle(req: Request, res: Response) { res.json({ data: await trackingService.getVehicle(BigInt(req.params.vehicleId as string)) }); },
    async getRoute(req: Request, res: Response) { res.json({ data: await trackingService.getPlannedRoute(BigInt(req.params.tripId as string)) }); },
};
