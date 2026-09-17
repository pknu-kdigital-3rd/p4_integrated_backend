import { Client as MinioClient } from "minio";

import { AppError } from "../../common/errors/app-error.ts";
import { env } from "../../config/env.ts";
import { logger } from "../../config/logger.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import type { RecordingContextBody, RecordingSegmentBody } from "./recording.schema.ts";

const maxDatabaseId = 9_223_372_036_854_775_807n;
const minDatabaseInteger = -9_223_372_036_854_775_808n;

const minioClient = (() => {
    if (!env.RECORDING_ENABLED || !env.MINIO_PUBLIC_ENDPOINT || !env.MINIO_NODE_ACCESS_KEY || !env.MINIO_NODE_SECRET_KEY) {
        return undefined;
    }
    const endpoint = new URL(env.MINIO_PUBLIC_ENDPOINT);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
    return new MinioClient({
        endPoint: hostname,
        port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80,
        useSSL: endpoint.protocol === "https:",
        accessKey: env.MINIO_NODE_ACCESS_KEY,
        secretKey: env.MINIO_NODE_SECRET_KEY,
        region: "us-east-1",
    });
})();

function parsePositiveId(value: string, name: string): bigint {
	const parsed = parseDatabaseInteger(value, name);
	if (parsed <= 0n) {
		throw new AppError(400, `${name} must be a positive integer`, "INVALID_RECORDING_ID");
	}
	return parsed;
}

function parseDatabaseInteger(value: string, name: string): bigint {
	let parsed: bigint;
	try {
		parsed = BigInt(value);
	} catch {
		throw new AppError(400, `${name} must be an integer`, "INVALID_RECORDING_METADATA");
	}
	if (parsed < minDatabaseInteger || parsed > maxDatabaseId) {
		throw new AppError(400, `${name} is outside the database integer range`, "INVALID_RECORDING_METADATA");
	}
	return parsed;
}

async function requireTripVehicle(tripId: bigint, vehicleId: bigint, requireInProgress: boolean) {
    const trip = await prisma.trip.findFirst({
        where: {
            tripId,
            vehicleId,
            ...(requireInProgress ? { tripStatus: "IN_PROGRESS" } : {}),
        },
        select: { tripId: true, vehicleId: true },
    });
    if (!trip) {
        throw new AppError(409, requireInProgress
            ? "Trip is not active for this vehicle"
            : "Trip does not belong to this vehicle", "RECORDING_TRIP_MISMATCH");
    }
    return trip;
}

function ensureSameSegment(existing: {
    tripId: bigint;
    storageBucket: string;
    objectKey: string;
    relayEpoch: bigint;
    startSeq: bigint;
    endSeq: bigint | null;
    startPts90k: bigint;
    endPts90k: bigint | null;
    contentType: string;
    etag: string | null;
    sizeBytes: bigint | null;
    startedAt: Date;
    endedAt: Date | null;
    durationSec: number | null;
}, segment: RecordingSegmentBody, tripId: bigint) {
    if (existing.tripId !== tripId
        || existing.storageBucket !== segment.storageBucket
        || existing.objectKey !== segment.objectKey
        || existing.relayEpoch !== BigInt(segment.relayEpoch)
        || existing.startSeq !== BigInt(segment.startSeq)
        || existing.endSeq !== BigInt(segment.endSeq)
        || existing.startPts90k !== BigInt(segment.startPts90k)
        || existing.endPts90k !== BigInt(segment.endPts90k)
        || existing.contentType !== segment.contentType
        || existing.etag !== (segment.etag ?? null)
        || existing.sizeBytes !== BigInt(segment.sizeBytes)
        || existing.startedAt.getTime() !== new Date(segment.startedAt).getTime()
        || existing.endedAt?.getTime() !== new Date(segment.endedAt).getTime()
        || existing.durationSec !== segment.durationSec) {
        throw new AppError(409, "Recording session segment identity conflicts with an existing object", "RECORDING_SEGMENT_CONFLICT");
    }
}

export const recordingService = {
    async validateContext(context: RecordingContextBody) {
        const tripId = parsePositiveId(context.tripId, "tripId");
        const vehicleId = parsePositiveId(context.vehicleId, "vehicleId");
        if (env.RECORDING_VALIDATE_TRIP_CONTEXT) {
            await requireTripVehicle(tripId, vehicleId, true);
        }
        return context;
    },

    async registerSegment(segment: RecordingSegmentBody) {
        const tripId = parsePositiveId(segment.tripId, "tripId");
        const vehicleId = parsePositiveId(segment.vehicleId, "vehicleId");
        const sizeBytes = parsePositiveId(segment.sizeBytes, "sizeBytes");
        const relayEpoch = parseDatabaseInteger(segment.relayEpoch, "relayEpoch");
        const startSeq = parseDatabaseInteger(segment.startSeq, "startSeq");
        const endSeq = parseDatabaseInteger(segment.endSeq, "endSeq");
        const startPts90k = parseDatabaseInteger(segment.startPts90k, "startPts90k");
        const endPts90k = parseDatabaseInteger(segment.endPts90k, "endPts90k");
        if (env.RECORDING_VALIDATE_TRIP_CONTEXT) {
            await requireTripVehicle(tripId, vehicleId, false);
        }
        if (segment.storageBucket !== env.MINIO_RECORDING_BUCKET) {
            throw new AppError(400, "Recording bucket does not match server configuration", "INVALID_RECORDING_BUCKET");
        }
        const expectedObjectKey = `trips/${segment.tripId}/sessions/${segment.recordingSessionId}/segment-${String(segment.segmentIndex).padStart(6, "0")}.mp4`;
        if (segment.objectKey !== expectedObjectKey) {
            throw new AppError(400, "Recording object key does not match its trip and segment identity", "INVALID_RECORDING_OBJECT_KEY");
        }

        const uniqueKey = {
            recordingSessionId_segmentIndex: {
                recordingSessionId: segment.recordingSessionId,
                segmentIndex: segment.segmentIndex,
            },
        };
        const existing = await prisma.tripVideo.findUnique({ where: uniqueKey });
        if (existing) {
            ensureSameSegment(existing, segment, tripId);
            return { tripVideoId: existing.tripVideoId, created: false };
        }

        const data = {
            tripId,
            recordingSessionId: segment.recordingSessionId,
            segmentIndex: segment.segmentIndex,
            storageBucket: segment.storageBucket,
            objectKey: segment.objectKey,
            videoUrl: null,
            contentType: segment.contentType,
            etag: segment.etag ?? null,
            sizeBytes,
            relayEpoch,
            startSeq,
            endSeq,
            startPts90k,
            endPts90k,
            startFrameId: null,
            endFrameId: null,
            startedAt: new Date(segment.startedAt),
            endedAt: new Date(segment.endedAt),
            durationSec: segment.durationSec,
            uploadStatus: "FINALIZED",
            failureReason: null,
        };
        try {
            const created = await prisma.tripVideo.create({ data });
            return { tripVideoId: created.tripVideoId, created: true };
        } catch (error) {
            if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
                throw error;
            }
            const concurrent = await prisma.tripVideo.findUnique({ where: uniqueKey });
            if (!concurrent) {
                throw new AppError(409, "Recording object key is already registered", "RECORDING_SEGMENT_CONFLICT");
            }
            ensureSameSegment(concurrent, segment, tripId);
            return { tripVideoId: concurrent.tripVideoId, created: false };
        }
    },

    async listTripVideos(tripIdValue: string) {
        const tripId = parsePositiveId(tripIdValue, "tripId");
        const trip = await prisma.trip.findUnique({ where: { tripId }, select: { tripId: true } });
        if (!trip) throw new AppError(404, "Trip not found", "TRIP_NOT_FOUND");
        return prisma.tripVideo.findMany({
            where: { tripId, uploadStatus: "FINALIZED" },
            orderBy: [{ startedAt: "asc" }, { segmentIndex: "asc" }],
            select: {
                tripVideoId: true, tripId: true, recordingSessionId: true, segmentIndex: true,
                storageBucket: true, objectKey: true, contentType: true, etag: true, sizeBytes: true,
                relayEpoch: true, startSeq: true, endSeq: true, startPts90k: true, endPts90k: true,
                startedAt: true, endedAt: true, durationSec: true, uploadStatus: true,
            },
        });
    },

    async getTripVideo(tripVideoIdValue: string) {
        const tripVideoId = parsePositiveId(tripVideoIdValue, "tripVideoId");
        const video = await prisma.tripVideo.findUnique({
            where: { tripVideoId },
            select: {
                tripVideoId: true, tripId: true, recordingSessionId: true, segmentIndex: true,
                storageBucket: true, objectKey: true, contentType: true, etag: true, sizeBytes: true,
                relayEpoch: true, startSeq: true, endSeq: true, startPts90k: true, endPts90k: true,
                startedAt: true, endedAt: true, durationSec: true, uploadStatus: true,
            },
        });
        if (!video) throw new AppError(404, "Trip video not found", "TRIP_VIDEO_NOT_FOUND");
        return video;
    },

    async createPlaybackUrl(tripVideoIdValue: string) {
        if (!env.RECORDING_ENABLED || !minioClient) {
            throw new AppError(503, "Recording playback is disabled", "RECORDING_DISABLED");
        }
        const video = await this.getTripVideo(tripVideoIdValue);
        if (video.uploadStatus !== "FINALIZED" || video.storageBucket === "legacy") {
            throw new AppError(409, "Recording segment is not available for playback", "RECORDING_NOT_FINALIZED");
        }
        let url: string;
        try {
            url = await minioClient.presignedGetObject(
                video.storageBucket,
                video.objectKey,
                env.RECORDING_PLAYBACK_URL_TTL_SECONDS,
            );
        } catch (error) {
            logger.error({ err: error, tripVideoId: video.tripVideoId.toString() }, "Could not create a MinIO playback URL");
            throw new AppError(503, "Could not create a playback URL", "PLAYBACK_URL_UNAVAILABLE");
        }
        return {
            url,
            expiresAt: new Date(Date.now() + env.RECORDING_PLAYBACK_URL_TTL_SECONDS * 1000),
            tripVideoId: video.tripVideoId,
            segmentIndex: video.segmentIndex,
        };
    },
};
