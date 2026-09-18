-- prisma/sql/getLatestVehiclePosition.sql
-- Source-time semantics: the fix with the latest recorded_at (sensor UTC).
-- v18: for "most recently received by the server" use
-- getLatestReceivedVehiclePosition.sql; replay fixes carry historical
-- recorded_at values.
-- Prisma introspects this against the real `vehicle_position` table, so
-- ST_Y/ST_X return `Float` in the generated TS type automatically —
-- no hand-written return-type annotation needed (unlike $queryRaw<T>()).
SELECT
    position_id       AS "positionId",
    vehicle_id         AS "vehicleId",
    trip_id            AS "tripId",
    ST_Y(location::geometry) AS lat,
    ST_X(location::geometry) AS lng,
    speed_kmh          AS "speedKmh",
    heading_deg         AS "headingDeg",
    recorded_at         AS "recordedAt"
FROM vehicle_position
WHERE vehicle_id = $1
ORDER BY recorded_at DESC
LIMIT 1;
