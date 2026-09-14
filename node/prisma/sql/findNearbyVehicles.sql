-- prisma/sql/findNearbyVehicles.sql
-- Uses the GiST index (idx_vehicle_position_location) via ST_DWithin.
-- $1/$2 = center lng/lat, $3 = radius in meters.
SELECT DISTINCT ON (vp.vehicle_id)
    vp.vehicle_id                    AS "vehicleId",
    ST_Y(vp.location::geometry)      AS lat,
    ST_X(vp.location::geometry)      AS lng,
    ST_Distance(
        vp.location,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
    )                                  AS "distanceM",
    vp.recorded_at                    AS "recordedAt"
FROM vehicle_position vp
WHERE ST_DWithin(
    vp.location,
    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
    $3
)
ORDER BY vp.vehicle_id, vp.recorded_at DESC;
