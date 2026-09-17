import type { Request, Response } from "express";

import type { RecordingContextBody, RecordingSegmentBody, ReplayDetectionSampleBody } from "./recording.schema.ts";
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

    async registerDetectionSamples(req: Request<{}, {}, { samples: ReplayDetectionSampleBody[] }>, res: Response) {
        const result = await recordingService.registerDetectionSamples(req.body.samples);
        res.status(200).json({ data: result });
    },

    async listTripVideos(req: Request, res: Response) {
        const videos = await recordingService.listTripVideos(req.params.tripId as string);
        res.status(200).json({ data: videos });
    },

    async getTripVideo(req: Request, res: Response) {
        const video = await recordingService.getTripVideo(req.params.tripVideoId as string);
        res.status(200).json({ data: video });
    },

    async listTripVideoDetections(req: Request, res: Response) {
        const result = await recordingService.listTripVideoDetections(
            req.params.tripId as string,
            req.params.tripVideoId as string,
        );
        res.status(200).json({ data: result });
    },

    async createPlaybackUrl(req: Request, res: Response) {
        const result = await recordingService.createPlaybackUrl(req.params.tripVideoId as string);
        res.status(200).json({ data: result });
    },

    async deleteTripVideo(req: Request, res: Response) {
        const result = await recordingService.deleteTripVideo(req.params.tripVideoId as string);
        res.status(200).json({ data: result });
    },
};
