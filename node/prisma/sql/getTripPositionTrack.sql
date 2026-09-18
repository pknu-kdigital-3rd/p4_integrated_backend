-- prisma/sql/getTripPositionTrack.sql
-- v15: bounded trip history for map/replay. Use a time window instead of returning an entire long trip.
-- Source-time semantics: the window and order use recorded_at (sensor UTC).
-- v18: also returns the source-timeline/quality columns of device GPS rows.
-- @param {BigInt} $1:tripId
-- @param {DateTime} $2:fromTime
-- @param {DateTime} $3:toTime

SELECT
    vp.position_id                         AS "positionId",
    vp.vehicle_id                          AS "vehicleId",
    vp.trip_id                             AS "tripId",
    ST_Y(vp.location::geometry)::double precision AS lat,
    ST_X(vp.location::geometry)::double precision AS lng,
    vp.speed_kmh::double precision         AS "speedKmh",
    vp.heading_deg::double precision       AS "headingDeg",
    vp.recorded_at                         AS "recordedAt",
    vp.received_at                         AS "receivedAt",
    vp.telemetry_source                    AS "telemetrySource",
    vp.recording_session_id                AS "recordingSessionId",
    vp.source_timestamp_ns                 AS "sourceTimestampNs",
    vp.horizontal_accuracy_m::double precision AS "horizontalAccuracyM"
FROM vehicle_position vp
WHERE vp.trip_id = $1
  AND vp.recorded_at >= $2
  AND vp.recorded_at <= $3
ORDER BY vp.recorded_at ASC, vp.position_id ASC;
