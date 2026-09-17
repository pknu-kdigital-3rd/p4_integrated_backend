import { Router } from "express";

import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { validateParams } from "../../common/middleware/validate-params.ts";
import { recordingController } from "./recording.controller.ts";
import { requireInternalServiceToken } from "./internal-auth.ts";
import {
    recordingContextSchema,
    recordingIdParamSchema,
    recordingSegmentSchema,
    replayDetectionBatchSchema,
    tripIdParamSchema,
    tripVideoReplayParamsSchema,
} from "./recording.schema.ts";

export const internalRecordingRouter = Router();
internalRecordingRouter.use(requireInternalServiceToken);
internalRecordingRouter.post("/validate", validateBody(recordingContextSchema), recordingController.validateContext);
internalRecordingRouter.post("/segments", validateBody(recordingSegmentSchema), recordingController.registerSegment);
internalRecordingRouter.post("/detections", validateBody(replayDetectionBatchSchema), recordingController.registerDetectionSamples);

export const recordingRouter = Router();
recordingRouter.get("/trips/:tripId/videos", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), validateParams(tripIdParamSchema), recordingController.listTripVideos);
recordingRouter.get("/trip-videos/:tripVideoId", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), validateParams(recordingIdParamSchema), recordingController.getTripVideo);
recordingRouter.get("/trips/:tripId/videos/:tripVideoId/detections", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), validateParams(tripVideoReplayParamsSchema), recordingController.listTripVideoDetections);
recordingRouter.post("/trip-videos/:tripVideoId/playback-url", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), validateParams(recordingIdParamSchema), recordingController.createPlaybackUrl);
recordingRouter.delete("/trip-videos/:tripVideoId", authenticate, requireRole("ADMIN", "OPERATOR"), validateParams(recordingIdParamSchema), recordingController.deleteTripVideo);
