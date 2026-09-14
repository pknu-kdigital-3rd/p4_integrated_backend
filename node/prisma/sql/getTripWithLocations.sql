-- prisma/sql/getTripWithLocations.sql
-- v15: PostGIS is the canonical location source; expose API-friendly numeric coordinates.
-- @param {BigInt} $1:tripId

SELECT
    t.trip_id                         AS "tripId",
    t.vehicle_id                      AS "vehicleId",
    t.driver_id                       AS "driverId",
    t.origin_name                     AS "originName",
    t.origin_address                  AS "originAddress",
    ST_Y(t.origin_location::geometry)::double precision
                                      AS "originLat",
    ST_X(t.origin_location::geometry)::double precision
                                      AS "originLng",
    t.destination_name                AS "destinationName",
    t.destination_address             AS "destinationAddress",
    ST_Y(t.destination_location::geometry)::double precision
                                      AS "destinationLat",
    ST_X(t.destination_location::geometry)::double precision
                                      AS "destinationLng",
    t.trip_status                     AS "tripStatus",
    t.planned_start_at                AS "plannedStartAt",
    t.started_at                      AS "startedAt",
    t.ended_at                        AS "endedAt",
    t.actual_distance_m               AS "actualDistanceM",
    t.ai_summary                      AS "aiSummary",
    t.ai_summary_generated_at         AS "aiSummaryGeneratedAt",
    t.created_at                      AS "createdAt",
    t.updated_at                      AS "updatedAt"
FROM trip t
WHERE t.trip_id = $1;
