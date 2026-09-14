-- prisma/sql/saveRouteFromGeoJson.sql
-- v15: store both display/cache GeoJSON and PostGIS LineString used for spatial computation.
-- IMPORTANT: $7 must be a GeoJSON geometry fragment (LineString), not a full Feature object.
-- @param {BigInt} $1:tripId
-- @param {Int} $2:routeVersion
-- @param {String} $3:routeType
-- @param {Int} $4:distanceM?
-- @param {Int} $5:durationSec?
-- @param {String} $6:encodedPolyline?
-- @param {String} $7:routeGeoJson
-- @param {String} $8:routeSource
-- @param {String} $9:sourceMetadata?

INSERT INTO route (
    trip_id,
    route_version,
    route_type,
    route_source,
    source_metadata,
    distance_m,
    duration_sec,
    encoded_polyline,
    route_geojson,
    route_line,
    is_current
)
VALUES (
    $1,
    $2,
    $3,
    $8,
    $9::jsonb,
    $4,
    $5,
    $6,
    $7::jsonb,
    ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)::geography,
    TRUE
)
RETURNING
    route_id         AS "routeId",
    trip_id          AS "tripId",
    route_version    AS "routeVersion",
    route_type       AS "routeType",
    route_source     AS "routeSource",
    source_metadata  AS "sourceMetadata",
    distance_m       AS "distanceM",
    duration_sec     AS "durationSec",
    encoded_polyline AS "encodedPolyline",
    route_geojson    AS "routeGeoJson",
    is_current       AS "isCurrent",
    created_at       AS "createdAt";
