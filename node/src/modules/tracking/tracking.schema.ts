import { z } from "zod";

export const telemetryObservationSchema = z.object({
    external_id: z.string(), latitude: z.number(), longitude: z.number(), speed_kmh: z.number().nullable(),
    heading_deg: z.number().nullable(), telemetry_source: z.enum(["BIMS_LIVE", "BIMS_REPLAY", "DEVICE_GPS", "RECORDED_GPS"]),
    observed_at_utc: z.string().nullable(), route_progress_pct: z.number().nullable(), source_metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const trackingResponseSchema = z.object({
    data: z.object({ generated_at_utc: z.string().nullable(), vehicles: z.array(z.object({ telemetry: telemetryObservationSchema }).passthrough()), warnings: z.array(z.unknown()) }),
});

export const telemetryModeSchema = z.object({
    mode: z.enum(["live", "playback"]),
});

export const telemetryModeResponseSchema = z.object({
    data: z.object({
        mode: z.enum(["live", "playback"]),
        available: z.boolean(),
    }),
});
