import { z } from "zod";

const positiveIntegerString = z.string().regex(/^[1-9][0-9]{0,18}$/);
const signedIntegerString = z.string().regex(/^-?[0-9]{1,19}$/);
const recordingSessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).refine(value => !value.includes(".."));

export const recordingContextSchema = z.object({
    tripId: positiveIntegerString,
    vehicleId: positiveIntegerString,
    recordingSessionId,
});

export const recordingSegmentSchema = recordingContextSchema.extend({
    segmentIndex: z.number().int().nonnegative().max(2_147_483_647),
    storageBucket: z.string().min(1).max(100),
    objectKey: z.string().min(1).max(1024),
    contentType: z.literal("video/mp4"),
    etag: z.string().max(128).optional(),
    sizeBytes: positiveIntegerString,
    relayEpoch: z.string().regex(/^[0-9]{1,20}$/),
    startSeq: z.string().regex(/^[0-9]{1,20}$/),
    endSeq: z.string().regex(/^[0-9]{1,20}$/),
    startPts90k: signedIntegerString,
    endPts90k: signedIntegerString,
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    durationSec: z.number().int().nonnegative().max(3600),
    durationPts90k: positiveIntegerString.optional(),
});

const normalizedBoxSchema = z.tuple([
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
]).refine(([x1, y1, x2, y2]) => x1 <= x2 && y1 <= y2);

export const replayDetectionSchema = z.object({
    class: z.string().min(1).max(100),
    confidence: z.number().min(0).max(1),
    bbox: normalizedBoxSchema,
    trackId: z.number().int().nonnegative().max(2_147_483_647).optional(),
});

export const replayDetectionSampleSchema = z.object({
    tripId: positiveIntegerString,
    recordingSessionId,
    relayEpoch: z.string().regex(/^[0-9]{1,20}$/),
    frameSeq: z.string().regex(/^[0-9]{1,20}$/),
    videoPts90k: signedIntegerString,
    detections: z.array(replayDetectionSchema).max(200),
});

export const replayDetectionBatchSchema = z.object({
    samples: z.array(replayDetectionSampleSchema).min(1).max(20),
});

export const recordingIdParamSchema = z.object({
    tripVideoId: positiveIntegerString,
});

export const tripIdParamSchema = z.object({
    tripId: positiveIntegerString,
});

export const tripVideoReplayParamsSchema = tripIdParamSchema.extend({
    tripVideoId: positiveIntegerString,
});

export const recordingSummarySchema = z.object({
    tripVideoId: z.string(),
    tripId: z.string(),
    recordingSessionId,
    segmentIndex: z.number().int(),
    storageBucket: z.string(),
    objectKey: z.string(),
    contentType: z.string(),
    etag: z.string().nullable(),
    sizeBytes: z.string().nullable(),
    relayEpoch: z.string(),
    startSeq: z.string(),
    endSeq: z.string().nullable(),
    startPts90k: z.string(),
    endPts90k: z.string().nullable(),
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }).nullable(),
    durationSec: z.number().int().nullable(),
    durationPts90k: z.string().nullable(),
    uploadStatus: z.string(),
});

export const recordingListResponseSchema = z.object({
    data: z.array(recordingSummarySchema),
});

export const playbackUrlResponseSchema = z.object({
    data: z.object({
        url: z.url(),
        expiresAt: z.iso.datetime({ offset: true }),
        tripVideoId: z.string(),
        segmentIndex: z.number().int(),
    }),
});

export const recordingDetailResponseSchema = z.object({
    data: recordingSummarySchema,
});

export const registeredSegmentResponseSchema = z.object({
    data: z.object({ tripVideoId: z.string() }),
});

export const replayDetectionResponseSchema = z.object({
    data: z.object({
        coverageIncomplete: z.boolean(),
        samples: z.array(z.object({
            frameSeq: z.string(),
            videoPts90k: z.string(),
            detections: z.array(replayDetectionSchema),
        })),
    }),
});

export type RecordingContextBody = z.infer<typeof recordingContextSchema>;
export type RecordingSegmentBody = z.infer<typeof recordingSegmentSchema>;
export type ReplayDetectionSampleBody = z.infer<typeof replayDetectionSampleSchema>;
