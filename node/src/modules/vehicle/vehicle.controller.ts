import type { Request, Response } from "express";

import { vehicleService } from "./vehicle.service.ts";
import type {
    CreateVehicleBody,
    UpdateVehicleBody,
    VehicleIdParam
} from "./vehicle.schema.ts"

export const vehicleController = {
    async getAll(_req: Request, res: Response) {
        const vehicles = await vehicleService.getVehicles();
        res.status(200).json({
            data: vehicles,
        });
    },

    async getById(req: Request<VehicleIdParam>, res: Response) {
        const vehicleId = BigInt(req.params.vehicleId)
        const vehicle = await vehicleService.getVehicle(vehicleId);
        res.status(200).json({
            data: vehicle,
        });
    },

    async remove(
        req: Request<VehicleIdParam>, res: Response
    ) {
        const vehicleId = BigInt(req.params.vehicleId);
        await vehicleService.deleteVehicle(vehicleId);
        res.status(204).send();
    },

    async create(
        req: Request<{}, {}, CreateVehicleBody>,
        res: Response,
    ) {
        const vehicle = await vehicleService.createVehicle(req.body);
        res.status(201).json({
            data: vehicle,
        });
    },

    async update(
        req: Request<VehicleIdParam, {}, UpdateVehicleBody>,
        res: Response,
    ) {
        const vehicleId = BigInt(req.params.vehicleId);
        await vehicleService.updateVehicle(vehicleId, req.body);
        res.status(204).send();
    },
};