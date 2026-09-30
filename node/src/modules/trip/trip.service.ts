import { AppError } from "../../common/errors/app-error.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import { trackingClient } from "../tracking/tracking.client.ts";
import { routingInternalClient } from "../virtual/routing-internal.client.ts";
import { previewPoints } from "./trip.preview.ts";
import { matchReplayPreview } from "./trip-road-match.ts";
import { tripRepository, tripSelect, type ResolvedTripInput } from "./trip.repository.ts";
import type { CreateTripBody } from "./trip.schema.ts";

const activeStatuses = ["READY", "IN_PROGRESS", "PAUSED"];

function profile(vehicle: Awaited<ReturnType<typeof tripRepository.findVehicle>>): string {
    if (vehicle?.vehicleSource === "BIMS") return "semi";
    if (Number(vehicle?.widthM ?? 0) >= 2.3 || Number(vehicle?.heightM ?? 0) >= 3.5) return "semi";
    return "car";
}
const originMaxAgeMs = 60_000;
function fresh(timestamp: unknown): boolean {
    const age = Date.now() - new Date(typeof timestamp === "string" ? timestamp : "").getTime();
    return Number.isFinite(age) && age >= 0 && age <= originMaxAgeMs;
}
/**
 * The vehicle's current map position, used as a dual-mode origin when the
 * operator picks none: a live BIMS fix, or the fix an Android phone is
 * streaming for this vehicle. A phone's fix is aged by when the relay received
 * it, since a replayed fix keeps its original recording date. The origin only
 * seeds the initial optimal route; replay GPS never counts as trip progress.
 */
async function liveOrigin(vehicle: NonNullable<Awaited<ReturnType<typeof tripRepository.findVehicle>>>) {
    try {
        if (vehicle.externalId) {
            const fix = await trackingClient.vehicle(vehicle.externalId);
            if (fix.telemetry_source === "BIMS_LIVE" && fix.source_metadata?.state === "live" && fresh(fix.observed_at_utc)) {
                return { lat: fix.latitude, lon: fix.longitude };
            }
        }
    } catch { /* fall through to the device fix */ }
    try {
        const fix = await trackingClient.vehicle(`device:${vehicle.vehicleId}`);
        if ((fix.telemetry_source === "DEVICE_GPS" || fix.telemetry_source === "RECORDED_GPS") && fresh(fix.source_metadata?.receivedAt)) {
            return { lat: fix.latitude, lon: fix.longitude };
        }
    } catch { /* no phone streaming for this vehicle */ }
    return null;
}
function positiveId(value: string, label: string): bigint {
    if (!/^[1-9]\d*$/.test(value)) throw new AppError(400, `${label} must be a positive integer`, "INVALID_ID");
    return BigInt(value);
}

export const tripService = {
    getTrips() { return tripRepository.findRecent(); },
    async createTrip(input: CreateTripBody) {
        const vehicleId = positiveId(input.vehicleId, "vehicleId");
        const vehicle = await tripRepository.findVehicle(vehicleId);
        if (!vehicle) throw new AppError(404, "Vehicle not found", "VEHICLE_NOT_FOUND");
        if (!vehicle.isActive) throw new AppError(409, "Cannot assign a trip to an inactive vehicle", "VEHICLE_INACTIVE");
        let resolved: ResolvedTripInput;
        let route = null;
        if (input.routeMode === "REPLAY_ONLY") {
            const preview = await prisma.replayPreview.findUnique({ where: { replayPreviewId: positiveId(input.replayPreviewId!, "replayPreviewId") } });
            if (!preview || preview.vehicleId !== vehicleId) throw new AppError(404, "Replay preview not found for vehicle", "REPLAY_PREVIEW_NOT_FOUND");
            const points = previewPoints(preview.points);
            const first = points[0]!, last = points.at(-1)!;
            resolved = { ...input, originName: input.originName ?? "GPS replay start",
                originLongitude: first[1], originLatitude: first[2],
                destinationName: `GPS replay endpoint · ${preview.datasetName}`.slice(0, 150),
                destinationLongitude: last[1], destinationLatitude: last[2] };
        } else {
            const origin = input.originLatitude === undefined ? await liveOrigin(vehicle)
                : { lat: input.originLatitude, lon: input.originLongitude! };
            if (!origin) throw new AppError(422, "Select an origin on the map; no recent live or Android GPS fix is available", "TRIP_ORIGIN_REQUIRED");
            resolved = { ...input, replayPreviewId: undefined, originLatitude: origin.lat, originLongitude: origin.lon,
                destinationName: input.destinationName!, destinationLatitude: input.destinationLatitude!,
                destinationLongitude: input.destinationLongitude! };
            route = await routingInternalClient.route({ origin, destination: {
                lat: resolved.destinationLatitude, lon: resolved.destinationLongitude,
            }, waypoints: [], vehicleProfile: profile(vehicle) });
        }
        const trip = await tripRepository.create(resolved, route);
        if (!trip) throw new AppError(500, "Created trip could not be loaded", "TRIP_CREATE_FAILED");
        return trip;
    },
    async current(vehicleIdValue: string) {
        const vehicleId = positiveId(vehicleIdValue, "vehicleId");
        return prisma.trip.findFirst({ where: { vehicleId, tripStatus: { in: activeStatuses } },
            orderBy: [{ createdAt: "desc" }, { tripId: "desc" }],
            select: { tripId: true, vehicleId: true, destinationName: true, tripStatus: true,
                routeMode: true, replayPreview: { select: { fingerprint: true, datasetName: true } } } });
    },
    async changeState(vehicleIdValue: string, tripIdValue: string, action: "start" | "complete", fingerprint?: string) {
        const vehicleId = positiveId(vehicleIdValue, "vehicleId");
        const tripId = positiveId(tripIdValue, "tripId");
        const trip = await prisma.trip.findFirst({ where: { vehicleId, tripId },
            include: { replayPreview: { select: { fingerprint: true } } } });
        if (!trip) throw new AppError(404, "Trip not found for vehicle", "TRIP_NOT_FOUND");
        const target = action === "start" ? "IN_PROGRESS" : "COMPLETED";
        if (trip.tripStatus === target) return prisma.trip.findUnique({ where: { tripId }, select: tripSelect });
        const source = action === "start" ? "READY" : "IN_PROGRESS";
        if (trip.tripStatus !== source) throw new AppError(409, `Trip must be ${source}`, "TRIP_STATE_CONFLICT");
        if (action === "start" && trip.routeMode === "REPLAY_ONLY" && trip.replayPreview?.fingerprint !== fingerprint) {
            throw new AppError(409, "Select the GPS dataset assigned to this trip", "REPLAY_DATASET_MISMATCH");
        }
        const changed = await prisma.trip.updateMany({ where: { tripId, vehicleId, tripStatus: source },
            data: { tripStatus: target, ...(action === "start" ? { startedAt: new Date() } : { endedAt: new Date() }) } });
        if (!changed.count) throw new AppError(409, "Trip state changed; refresh", "TRIP_STATE_CONFLICT");
        return prisma.trip.findUnique({ where: { tripId }, select: tripSelect });
    },
    async cancel(tripIdValue: string) {
        const tripId = positiveId(tripIdValue, "tripId");
        const changed = await prisma.trip.updateMany({ where: { tripId, tripStatus: { in: activeStatuses } },
            data: { tripStatus: "CANCELLED", endedAt: new Date() } });
        if (!changed.count) throw new AppError(409, "Trip is not active", "TRIP_STATE_CONFLICT");
        return prisma.trip.findUnique({ where: { tripId }, select: tripSelect });
    },
    async display(tripIdValue: string) {
        const tripId = positiveId(tripIdValue, "tripId");
        const trip = await prisma.trip.findUnique({ where: { tripId }, include: {
            routes: { where: { isCurrent: true }, take: 1, orderBy: { routeVersion: "desc" },
                select: { routeId: true, routeGeojson: true, distanceM: true, durationSec: true } },
            replayPreview: true,
        } });
        if (!trip) throw new AppError(404, "Trip not found", "TRIP_NOT_FOUND");
        const preview = trip.routeMode === "DUAL" ? await prisma.replayPreview.findFirst({
            where: { vehicleId: trip.vehicleId }, orderBy: [{ createdAt: "desc" }, { replayPreviewId: "desc" }],
        }) : trip.replayPreview;
        const latestReplay = await prisma.$queryRaw<Array<{ sourceTimestampNs: bigint; recordingSessionId: string }>>`
            SELECT source_timestamp_ns AS "sourceTimestampNs", recording_session_id AS "recordingSessionId"
            FROM vehicle_position WHERE trip_id = ${tripId} AND telemetry_source = 'RECORDED_GPS'
            ORDER BY received_at DESC, position_id DESC LIMIT 1`;
        const roadMatch = preview ? await matchReplayPreview(preview) : null;
        return { tripId: trip.tripId, vehicleId: trip.vehicleId, tripStatus: trip.tripStatus,
            routeMode: trip.routeMode, originName: trip.originName, destinationName: trip.destinationName,
            plannedStartAt: trip.plannedStartAt, startedAt: trip.startedAt, endedAt: trip.endedAt,
            plannedRoute: trip.routes[0] ?? null,
            replayPreview: preview && { replayPreviewId: preview.replayPreviewId,
                fingerprint: preview.fingerprint, datasetName: preview.datasetName,
                points: preview.points, totalDistanceM: preview.totalDistanceM, roadMatch },
            replayPosition: latestReplay[0] ?? null };
    },
};
