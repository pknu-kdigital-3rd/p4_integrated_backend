import type { Request, Response } from "express";

import type { RecordingContextBody, RecordingSegmentBody } from "./recording.schema.ts";
import { recordingService } from "./recording.service.ts";

export const recordingController = {
    async validateContext(req: Request<{}, {}, RecordingContextBody>, res: Response) {
        const context = await recordingService.validateContext(req.body);
        res.status(200).json(context);
    },

    async registerSegment(req: Request<{}, {}, RecordingSegmentBody>, res: Response) {
        const result = await recordingService.registerSegment(req.body);
        res.status(result.created ? 201 : 200).json({ data: { tripVideoId: result.tripVideoId } });
    },

    async listTripVideos(req: Request, res: Response) {
        const videos = await recordingService.listTripVideos(req.params.tripId as string);
        res.status(200).json({ data: videos });
    },

    async getTripVideo(req: Request, res: Response) {
        const video = await recordingService.getTripVideo(req.params.tripVideoId as string);
        res.status(200).json({ data: video });
    },

    async createPlaybackUrl(req: Request, res: Response) {
        const result = await recordingService.createPlaybackUrl(req.params.tripVideoId as string);
        res.status(200).json({ data: result });
    },
};
