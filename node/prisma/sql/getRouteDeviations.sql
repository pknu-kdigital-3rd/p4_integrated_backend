-- prisma/sql/getRouteDeviations.sql
-- v15: bounded deviation history for map/history/replay APIs.
-- @param {BigInt} $1:tripId
-- @param {DateTime} $2:fromTime
-- @param {DateTime} $3:toTime

SELECT
    rd.deviation_id                         AS "deviationId",
    rd.vehicle_id                           AS "vehicleId",
    rd.trip_id                              AS "tripId",
    rd.route_id                             AS "routeId",
    rd.deviation_distance_m::double precision AS "deviationDistanceM",
    ST_Y(rd.location::geometry)::double precision AS lat,
    ST_X(rd.location::geometry)::double precision AS lng,
    rd.detected_at                          AS "detectedAt",
    rd.resolved_at                          AS "resolvedAt",
    rd.recalculated_route_id                AS "recalculatedRouteId",
    rd.created_at                           AS "createdAt"
FROM route_deviation rd
WHERE rd.trip_id = $1
  AND rd.detected_at >= $2
  AND rd.detected_at <= $3
ORDER BY rd.detected_at ASC, rd.deviation_id ASC;
