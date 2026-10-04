import { Client as MinioClient } from "minio";

import { AppError } from "../../common/errors/app-error.ts";
import { env } from "../../config/env.ts";
import { logger } from "../../config/logger.ts";
import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import { detectionCoverageIncomplete } from "./recording.replay.ts";
import type { RecordingContextBody, RecordingSegmentBody, ReplayDetectionSampleBody } from "./recording.schema.ts";

const maxDatabaseId = 9_223_372_036_854_775_807n;
const minDatabaseInteger = -9_223_372_036_854_775_808n;

function createMinioClient(endpoint: URL | undefined) {
    if (!env.RECORDING_ENABLED || !endpoint || !env.MINIO_NODE_ACCESS_KEY || !env.MINIO_NODE_SECRET_KEY) {
        return undefined;
    }
    return new MinioClient({
        endPoint: endpoint.hostname.replace(/^\[|\]$/g, ""),
        port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80,
        useSSL: endpoint.protocol === "https:",
        accessKey: env.MINIO_NODE_ACCESS_KEY,
        secretKey: env.MINIO_NODE_SECRET_KEY,
        region: "us-east-1",
    });
}

const playbackMinioClient = createMinioClient(
    env.MINIO_PUBLIC_ENDPOINT ? new URL(env.MINIO_PUBLIC_ENDPOINT) : undefined,
);
const storageMinioClient = createMinioClient(
    new URL(`${env.MINIO_USE_SSL ? "https" : "http"}://${env.MINIO_ENDPOINT}`),
);

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
    durationPts90k: bigint | null;
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
        || existing.durationSec !== segment.durationSec
        || (segment.durationPts90k !== undefined && existing.durationPts90k !== BigInt(segment.durationPts90k))) {
        throw new AppError(409, "Recording session segment identity conflicts with an existing object", "RECORDING_SEGMENT_CONFLICT");
    }
}

export const recordingService = {
    async listRecordingTrips(beforeTripId?: string) {
        const page = await prisma.trip.findMany({
            where: { tripVideos: { some: {} }, ...(beforeTripId ? { tripId: { lt: parsePositiveId(beforeTripId, "beforeTripId") } } : {}) },
            orderBy: { tripId: "desc" }, take: 51,
            select: { tripId: true, vehicleId: true, destinationName: true, tripStatus: true, vehicle: { select: { vehicleCode: true } } },
        });
        const trips = page.slice(0, 50);
        const groups = trips.length ? await prisma.tripVideo.groupBy({
            by: ["tripId", "uploadStatus"], where: { tripId: { in: trips.map(trip => trip.tripId) } },
            _count: { _all: true }, _sum: { sizeBytes: true, durationSec: true },
            _min: { startedAt: true }, _max: { endedAt: true },
        }) : [];
        return {
            trips: trips.map(trip => {
                const rows = groups.filter(group => group.tripId === trip.tripId);
                const starts = rows.flatMap(row => row._min.startedAt ? [row._min.startedAt] : []);
                const ends = rows.flatMap(row => row._max.endedAt ? [row._max.endedAt] : []);
                return {
                    tripId: trip.tripId, vehicleId: trip.vehicleId, vehicleCode: trip.vehicle.vehicleCode,
                    destinationName: trip.destinationName, tripStatus: trip.tripStatus,
                    segmentCount: rows.reduce((sum, row) => sum + row._count._all, 0),
                    finalizedCount: rows.find(row => row.uploadStatus === "FINALIZED")?._count._all ?? 0,
                    durationSec: rows.reduce((sum, row) => sum + (row._sum.durationSec ?? 0), 0),
                    sizeBytes: rows.reduce((sum, row) => sum + (row._sum.sizeBytes ?? 0n), 0n),
                    recordingStatuses: Object.fromEntries(rows.map(row => [row.uploadStatus, row._count._all])),
                    startedAt: starts.length ? new Date(Math.min(...starts.map(date => date.getTime()))) : null,
                    endedAt: ends.length ? new Date(Math.max(...ends.map(date => date.getTime()))) : null,
                };
            }),
            nextBeforeTripId: page.length > 50 ? trips.at(-1)!.tripId.toString() : null,
        };
    },

    async deleteTripRecordings(tripIdValue: string, ids: string[]) {
        if (!env.RECORDING_ENABLED || !storageMinioClient) {
            throw new AppError(503, "Recording deletion is disabled", "RECORDING_DISABLED");
        }
        const tripId = parsePositiveId(tripIdValue, "tripId");
        const tripVideoIds = ids.map(id => parsePositiveId(id, "tripVideoId"));
        const videos = await prisma.tripVideo.findMany({ where: { tripId, tripVideoId: { in: tripVideoIds } }, select: { tripVideoId: true, uploadStatus: true } });
        if (videos.length !== ids.length || videos.some(video => video.uploadStatus !== "FINALIZED")) {
            throw new AppError(409, "Selected recordings changed or do not belong to this trip. Refresh before deleting.", "RECORDING_SELECTION_CHANGED");
        }
        const deletedTripVideoIds: string[] = [];
        const failures: { tripVideoId: string; message: string }[] = [];
        // Storage and database deletion cannot be atomic. Keep successful
        // removals and report each failure so the remaining segments can retry.
        for (const id of ids) {
            try {
                await this.deleteTripVideo(id);
                deletedTripVideoIds.push(id);
            } catch (error) {
                if (!(error instanceof AppError)) logger.error({ err: error, tripVideoId: id }, "Could not delete selected trip recording");
                failures.push({ tripVideoId: id, message: error instanceof AppError ? error.message : "Recording deletion failed. Refresh and retry." });
            }
        }
        return { tripId: tripIdValue, deletedTripVideoIds, failures };
    },
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
            durationPts90k: segment.durationPts90k === undefined ? null : parsePositiveId(segment.durationPts90k, "durationPts90k"),
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
                startedAt: true, endedAt: true, durationSec: true, durationPts90k: true, uploadStatus: true,
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
                startedAt: true, endedAt: true, durationSec: true, durationPts90k: true, uploadStatus: true,
            },
        });
        if (!video) throw new AppError(404, "Trip video not found", "TRIP_VIDEO_NOT_FOUND");
        return video;
    },

    async registerDetectionSamples(samples: ReplayDetectionSampleBody[]) {
        const data = samples.map(sample => ({
            tripId: parsePositiveId(sample.tripId, "tripId"),
            recordingSessionId: sample.recordingSessionId,
            relayEpoch: parseDatabaseInteger(sample.relayEpoch, "relayEpoch"),
            frameSeq: parseDatabaseInteger(sample.frameSeq, "frameSeq"),
            videoPts90k: parseDatabaseInteger(sample.videoPts90k, "videoPts90k"),
            detections: sample.detections as unknown as Prisma.InputJsonValue,
        }));
        const result = await prisma.tripVideoDetectionSample.createMany({ data, skipDuplicates: true });
        return { accepted: result.count };
    },

    async listTripVideoDetections(tripIdValue: string, tripVideoIdValue: string) {
        const tripId = parsePositiveId(tripIdValue, "tripId");
        const tripVideoId = parsePositiveId(tripVideoIdValue, "tripVideoId");
        const video = await prisma.tripVideo.findFirst({
            where: { tripId, tripVideoId, uploadStatus: "FINALIZED" },
            select: {
                tripId: true, recordingSessionId: true, relayEpoch: true,
                startSeq: true, endSeq: true, startPts90k: true, endPts90k: true,
            },
        });
        if (!video || video.endSeq === null || video.endPts90k === null) {
            throw new AppError(404, "Finalized recording segment not found for this trip", "TRIP_VIDEO_NOT_FOUND");
        }
        const samples = await prisma.tripVideoDetectionSample.findMany({
            where: {
                tripId,
                recordingSessionId: video.recordingSessionId,
                relayEpoch: video.relayEpoch,
                frameSeq: { gte: video.startSeq, lte: video.endSeq },
                videoPts90k: { gte: video.startPts90k, lte: video.endPts90k },
            },
            orderBy: [{ videoPts90k: "asc" }, { frameSeq: "asc" }],
            select: { frameSeq: true, videoPts90k: true, detections: true },
        });
        const coverageIncomplete = detectionCoverageIncomplete(
            video.startPts90k,
            video.endPts90k,
            samples.map(sample => sample.videoPts90k),
        );
        return { coverageIncomplete, samples };
    },

    async createPlaybackUrl(tripVideoIdValue: string, download = false) {
        if (!env.RECORDING_ENABLED || !playbackMinioClient) {
            throw new AppError(503, "Recording playback is disabled", "RECORDING_DISABLED");
        }
        const video = await this.getTripVideo(tripVideoIdValue);
        if (video.uploadStatus !== "FINALIZED" || video.storageBucket === "legacy") {
            throw new AppError(409, "Recording segment is not available for playback", "RECORDING_NOT_FINALIZED");
        }
        let url: string;
        try {
            url = await playbackMinioClient.presignedGetObject(
                video.storageBucket,
                video.objectKey,
                env.RECORDING_PLAYBACK_URL_TTL_SECONDS,
                download ? { "response-content-disposition": `attachment; filename="trip-${video.tripId}-segment-${video.tripVideoId}.mp4"` } : {},
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

    async deleteTripVideo(tripVideoIdValue: string) {
        if (!env.RECORDING_ENABLED || !storageMinioClient) {
            throw new AppError(503, "Recording deletion is disabled", "RECORDING_DISABLED");
        }
        const video = await this.getTripVideo(tripVideoIdValue);
        if (video.uploadStatus !== "FINALIZED"
            || video.storageBucket !== env.MINIO_RECORDING_BUCKET
            || video.endSeq === null) {
            throw new AppError(409, "Only finalized recording segments can be deleted", "RECORDING_NOT_FINALIZED");
        }
        const expectedObjectKey = `trips/${video.tripId}/sessions/${video.recordingSessionId}/segment-${String(video.segmentIndex).padStart(6, "0")}.mp4`;
        if (video.objectKey !== expectedObjectKey) {
            throw new AppError(409, "Recording object key does not match its segment identity", "INVALID_RECORDING_OBJECT_KEY");
        }

        try {
            await storageMinioClient.removeObject(video.storageBucket, video.objectKey);
        } catch (error) {
            logger.error({ err: error, tripVideoId: video.tripVideoId.toString() }, "Could not delete recording segment from MinIO");
            throw new AppError(503, "Could not delete recording segment from object storage", "RECORDING_DELETE_FAILED");
        }

        try {
            await prisma.$transaction([
                prisma.tripVideoDetectionSample.deleteMany({
                    where: {
                        tripId: video.tripId,
                        recordingSessionId: video.recordingSessionId,
                        relayEpoch: video.relayEpoch,
                        frameSeq: { gte: video.startSeq, lte: video.endSeq },
                    },
                }),
                prisma.tripVideo.delete({ where: { tripVideoId: video.tripVideoId } }),
            ]);
        } catch (error) {
            logger.error({ err: error, tripVideoId: video.tripVideoId.toString() }, "MinIO object deleted but recording metadata cleanup failed");
            throw new AppError(503, "The video object was deleted, but replay metadata cleanup failed. Retry the deletion.", "RECORDING_DELETE_METADATA_FAILED");
        }

        return { tripVideoId: video.tripVideoId.toString(), deleted: true };
    },
};
