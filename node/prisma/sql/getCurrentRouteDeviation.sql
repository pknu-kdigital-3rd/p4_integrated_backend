-- prisma/sql/getCurrentRouteDeviation.sql
-- The exact-distance replacement from v8: point-to-linestring, not
-- point-to-nearest-sample-point. $1 = trip_id.
SELECT
    ST_Distance(vp.location, r.route_line) AS "deviationDistanceM"
FROM vehicle_position vp
JOIN route r
    ON r.trip_id = vp.trip_id
    AND r.is_current = TRUE
WHERE vp.trip_id = $1
ORDER BY vp.recorded_at DESC
LIMIT 1;
