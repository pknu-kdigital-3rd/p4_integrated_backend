-- prisma/sql/insertRouteDeviationIfExceeded.sql
-- v15: persist a route-deviation domain event only when the measured distance crosses the threshold.
-- The caller passes the already-persisted position and the route that was current for this check.
-- @param {BigInt} $1:vehicleId
-- @param {BigInt} $2:tripId
-- @param {BigInt} $3:routeId
-- @param {BigInt} $4:positionId
-- @param {Float} $5:thresholdMeters
-- @param {DateTime} $6:detectedAt

WITH measurement AS (
    SELECT
        vp.location,
        ST_Distance(vp.location, r.route_line) AS deviation_distance_m
    FROM vehicle_position vp
    JOIN route r
      ON r.route_id = $3
    WHERE vp.position_id = $4
      AND vp.vehicle_id = $1
      AND vp.trip_id = $2
      AND r.trip_id = $2
      AND r.route_line IS NOT NULL
)
INSERT INTO route_deviation (
    vehicle_id,
    trip_id,
    route_id,
    deviation_distance_m,
    location,
    detected_at
)
SELECT
    $1,
    $2,
    $3,
    m.deviation_distance_m,
    m.location,
    $6
FROM measurement m
WHERE m.deviation_distance_m >= $5
RETURNING
    deviation_id                         AS "deviationId",
    vehicle_id                           AS "vehicleId",
    trip_id                              AS "tripId",
    route_id                             AS "routeId",
    deviation_distance_m::double precision AS "deviationDistanceM",
    detected_at                          AS "detectedAt",
    created_at                           AS "createdAt";
