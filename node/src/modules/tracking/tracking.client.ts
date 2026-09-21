import { env } from "../../config/env.ts";
import { AppError } from "../../common/errors/app-error.ts";

export type TrackingSnapshot = {
    generated_at_utc: string | null;
    vehicles: Array<{
        external_id: string;
        latitude: number;
        longitude: number;
        speed_kmh: number | null;
        heading_deg: number | null;
        telemetry_source: "BIMS_LIVE" | "BIMS_REPLAY" | "DEVICE_GPS" | "RECORDED_GPS";
        observed_at_utc: string | null;
        route_progress_pct: number | null;
        source_metadata: Record<string, unknown> | null;
    }>;
    warnings: Array<unknown>;
};

export type TelemetryMode = "live" | "playback";

export type TelemetryModeStatus = {
    mode: TelemetryMode;
    available: boolean;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    try {
        const response = await fetch(new URL(path, env.ROUTING_TRACKING_BASE_URL), {
            ...init,
            headers: {
                "content-type": "application/json",
                ...(init.headers as Record<string, string> | undefined),
            },
            signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json() as T;
    } catch (error) {
        void error;
        throw new AppError(503, "Tracking service unavailable", "TRACKING_SERVICE_UNAVAILABLE");
    }
}

export const trackingClient = {
    snapshot: () => request<TrackingSnapshot>("/internal/vehicles"),
    vehicle: (externalId: string) => request<TrackingSnapshot["vehicles"][number]>(`/internal/vehicles/${encodeURIComponent(externalId)}`),
    telemetryMode: () => request<TelemetryModeStatus>("/internal/telemetry/status"),
    setTelemetryMode: (mode: TelemetryMode) => request<TelemetryModeStatus>("/internal/telemetry/mode", {
        method: "PUT",
        body: JSON.stringify({ mode }),
    }),
};
