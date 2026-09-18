import { z } from "zod";

import { positiveIntegerString, recordingSessionId } from "../recording/recording.schema.ts";

const maxInt64 = 9_223_372_036_854_775_807n;

// 64-bit values (nanosecond source timestamps, epoch milliseconds, database ids)
// are JSON strings: a JavaScript number cannot represent them exactly. They are
// converted to BigInt after validation and never to `number`.
export const positiveInt64String = positiveIntegerString
    .refine(value => BigInt(value) <= maxInt64, "must fit in a signed 64-bit integer");

export const telemetryModeSchema = z.enum(["REPLAY", "LIVE"]);

export const deviceGpsSampleSchema = z.object({
    sourceTimestampNs: positiveInt64String,
    utcEpochMs: positiveInt64String.nullable().optional(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    // Column ranges: altitude/accuracy DECIMAL(10,3), speed_kmh DECIMAL(6,2).
    altitudeM: z.number().min(-100_000).max(100_000).nullable().optional(),
    speedMps: z.number().min(0).max(277).nullable().optional(),
    bearingDeg: z.number().min(0).lt(360).nullable().optional(),
    // Poor accuracy is still an authoritative observation; it is stored, not rejected.
    horizontalAccuracyM: z.number().min(0).max(1_000_000).nullable().optional(),
});

export const deviceGpsBatchSchema = z.object({
    mode: telemetryModeSchema,
    tripId: positiveIntegerString,
    vehicleId: positiveIntegerString,
    recordingSessionId,
    receivedAt: z.iso.datetime({ offset: true }),
    samples: z.array(deviceGpsSampleSchema).min(1).max(16),
});

export const deviceGpsResponseSchema = z.object({
    data: z.object({
        accepted: z.number().int(),
        inserted: z.number().int(),
        duplicates: z.number().int(),
        telemetrySource: z.enum(["RECORDED_GPS", "DEVICE_GPS"]),
    }),
});

export type TelemetryMode = z.infer<typeof telemetryModeSchema>;
export type DeviceGpsSampleBody = z.infer<typeof deviceGpsSampleSchema>;
export type DeviceGpsBatchBody = z.infer<typeof deviceGpsBatchSchema>;
