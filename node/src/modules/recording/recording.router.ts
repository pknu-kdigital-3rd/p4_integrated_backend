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
    tripIdParamSchema,
} from "./recording.schema.ts";

export const internalRecordingRouter = Router();
internalRecordingRouter.use(requireInternalServiceToken);
internalRecordingRouter.post("/validate", validateBody(recordingContextSchema), recordingController.validateContext);
internalRecordingRouter.post("/segments", validateBody(recordingSegmentSchema), recordingController.registerSegment);

export const recordingRouter = Router();
recordingRouter.get("/trips/:tripId/videos", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), validateParams(tripIdParamSchema), recordingController.listTripVideos);
recordingRouter.get("/trip-videos/:tripVideoId", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), validateParams(recordingIdParamSchema), recordingController.getTripVideo);
recordingRouter.post("/trip-videos/:tripVideoId/playback-url", authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER"), validateParams(recordingIdParamSchema), recordingController.createPlaybackUrl);
