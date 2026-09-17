-- prisma/sql/createTrip.sql
-- v15: Node owns trip writes. PostGIS constructs origin/destination geography values.
-- @param {BigInt} $1:vehicleId
-- @param {BigInt} $2:driverId?
-- @param {String} $3:originName?
-- @param {String} $4:originAddress?
-- @param {Float} $5:originLongitude?
-- @param {Float} $6:originLatitude?
-- @param {String} $7:destinationName
-- @param {String} $8:destinationAddress?
-- @param {Float} $9:destinationLongitude
-- @param {Float} $10:destinationLatitude
-- @param {DateTime} $11:plannedStartAt?
-- @param {String} $12:tripStatus
-- @param {DateTime} $13:startedAt?

INSERT INTO trip (
    vehicle_id,
    driver_id,
    origin_name,
    origin_address,
    origin_location,
    destination_name,
    destination_address,
    destination_location,
    trip_status,
    planned_start_at,
    started_at
)
VALUES (
    $1,
    $2,
    $3,
    $4,
    CASE
        WHEN CAST($5 AS DOUBLE PRECISION) IS NULL
          OR CAST($6 AS DOUBLE PRECISION) IS NULL THEN NULL
        ELSE ST_SetSRID(
            ST_MakePoint(CAST($5 AS DOUBLE PRECISION), CAST($6 AS DOUBLE PRECISION)),
            4326
        )::geography
    END,
    $7,
    $8,
    ST_SetSRID(
        ST_MakePoint(CAST($9 AS DOUBLE PRECISION), CAST($10 AS DOUBLE PRECISION)),
        4326
    )::geography,
    $12,
    $11,
    $13
)
RETURNING
    trip_id          AS "tripId",
    vehicle_id       AS "vehicleId",
    driver_id        AS "driverId",
    origin_name      AS "originName",
    destination_name AS "destinationName",
    trip_status      AS "tripStatus",
    planned_start_at AS "plannedStartAt",
    created_at       AS "createdAt";
