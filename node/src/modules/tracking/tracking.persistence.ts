import { Prisma } from "../../generated/prisma/client.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import type { TrackingSnapshot } from "./tracking.client.ts";

const lastPersisted = new Map<string, string>();

export function persistAuthoritativeObservations(
    identities: Array<{ vehicleId: bigint; externalId: string | null }>,
    snapshot: TrackingSnapshot,
): void {
    const byExternalId = new Map(identities.map(item => [item.externalId, item.vehicleId]));
    const pending = snapshot.vehicles.filter(item => {
        if (!item.observed_at_utc || !byExternalId.has(item.external_id)) return false;
        if (lastPersisted.get(item.external_id) === item.observed_at_utc) return false;
        lastPersisted.set(item.external_id, item.observed_at_utc);
        return true;
    });
    void Promise.all(pending.map(item => prisma.$executeRaw(Prisma.sql`
        INSERT INTO vehicle_position (vehicle_id, trip_id, location, speed_kmh, heading_deg, recorded_at, telemetry_source)
        VALUES (
            ${byExternalId.get(item.external_id)}, NULL,
            ST_SetSRID(ST_MakePoint(${item.longitude}, ${item.latitude}), 4326)::geography,
            ${item.speed_kmh}, ${item.heading_deg}, ${new Date(item.observed_at_utc!)}, ${item.telemetry_source}
        )
    `))).catch(() => {
        for (const item of pending) lastPersisted.delete(item.external_id);
    });
}
