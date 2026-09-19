import { env } from "../../config/env.ts";
import { AppError } from "../../common/errors/app-error.ts";
import type { Coordinate, WaypointInput } from "./virtual.schema.ts";

export type InternalRoute = {
    graphVersion: string;
    routeGeojson: { type: "LineString"; coordinates: number[][] };
    directedItinerary: Array<Record<string, unknown>>;
    snappedStops: Array<Record<string, unknown>>;
    distanceM: number;
    durationSec: number;
    warnings: string[];
};

type RouteInput = {
    origin: Coordinate;
    destination: Coordinate;
    waypoints: WaypointInput[];
    vehicleProfile: string;
    blockedEdgeIds?: string[];
    blockedGeometries?: unknown[];
    penaltyEdgeFactors?: Record<string, number>;
};

async function request<T>(path: string, body?: unknown): Promise<T> {
    try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        const token = env.ROUTING_TRACKING_SERVICE_TOKEN;
        if (token) headers.authorization = `Bearer ${token}`;
        const init: RequestInit = {
            method: body === undefined ? "GET" : "POST",
            headers,
            signal: AbortSignal.timeout(8000),
        };
        if (body !== undefined) init.body = JSON.stringify(body);
        const response = await fetch(new URL(path, env.ROUTING_TRACKING_BASE_URL), init);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = payload?.detail;
            const code = typeof payload?.code === "string" ? payload.code : typeof detail?.code === "string" ? detail.code : "ROUTING_UNAVAILABLE";
            const message = typeof payload?.message === "string" ? payload.message : typeof detail === "string" ? detail : typeof detail?.message === "string" ? detail.message : "Routing service unavailable";
            throw new AppError(response.status === 404 || code === "ROUTE_NOT_FOUND" ? 422 : 503, message, code);
        }
        return payload as T;
    } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(503, "Routing service unavailable", "ROUTING_UNAVAILABLE");
    }
}

export const routingInternalClient = {
    async graphVersion() {
        return request<{ graphVersion: string }>("/internal/routing/graph-version");
    },
    async route(input: RouteInput): Promise<InternalRoute> {
        return request<InternalRoute>("/internal/routing/route", input);
    },
    async resolveRestriction(input: { geometry: unknown; blockedEdgeIds?: string[]; penaltyFactor?: number }) {
        return request<{
            graphVersion: string;
            affectedDirectedEdgeIds: string[];
            affectedPhysicalSegmentIds: string[];
            occupiedCandidateEdges: string[];
        }>("/internal/routing/road-restrictions/resolve", input);
    },
};
