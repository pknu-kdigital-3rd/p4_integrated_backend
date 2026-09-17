import type { Request, Response } from "express";
import type { CreateTripBody } from "./trip.schema.ts";
import { tripService } from "./trip.service.ts";

export const tripController = {
    async getAll(_req: Request, res: Response) {
        res.status(200).json({ data: await tripService.getTrips() });
    },

    async create(req: Request<{}, {}, CreateTripBody>, res: Response) {
        const trip = await tripService.createTrip(req.body);
        res.status(201).json({ data: trip });
    },
};
