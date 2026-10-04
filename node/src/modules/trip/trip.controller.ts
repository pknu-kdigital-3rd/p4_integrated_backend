import type { Request, Response } from "express";
import type { CreateTripBody } from "./trip.schema.ts";
import { tripService } from "./trip.service.ts";
import { parseVehicleId, previewPoints, replayPreviewService } from "./trip.preview.ts";
import { cleanReplayPreviewPoints } from "./trip-preview-clean.ts";
import { matchReplayPreview } from "./trip-road-match.ts";

export const tripController = {
    async delete(req: Request, res: Response) {
        res.json({ data: await tripService.deleteTrip(String(req.params.tripId)) });
    },
    async getAll(_req: Request, res: Response) {
        res.status(200).json({ data: await tripService.getTrips() });
    },

    async create(req: Request<{}, {}, CreateTripBody>, res: Response) {
        const trip = await tripService.createTrip(req.body);
        res.status(201).json({ data: trip });
    },
    async display(req: Request, res: Response) {
        res.json({ data: await tripService.display(String(req.params.tripId)) });
    },
    async cancel(req: Request, res: Response) {
        res.json({ data: await tripService.cancel(String(req.params.tripId)) });
    },
    async latestPreview(req: Request, res: Response) {
        const preview = await replayPreviewService.latest(parseVehicleId(String(req.params.vehicleId)));
        // Points cleaned as for a trip's display, so the road match's timing (built
        // from the cleaned points) and these points describe the same recording.
        res.json({ data: preview ? { ...preview, points: cleanReplayPreviewPoints(previewPoints(preview.points)),
            roadMatch: await matchReplayPreview(preview) } : null });
    },
};
