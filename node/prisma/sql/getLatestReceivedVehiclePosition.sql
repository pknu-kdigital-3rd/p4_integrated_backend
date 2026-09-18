-- prisma/sql/getLatestReceivedVehiclePosition.sql
-- v18: "What did the server most recently receive for this vehicle?"
-- Orders by received_at, not recorded_at: a REPLAY fix carries its original
-- (possibly older) source UTC and must still win over an earlier-received
-- observation. For source-time order use getLatestVehiclePosition.sql /
-- getTripPositionTrack.sql.
-- @param {BigInt} $1:vehicleId
SELECT
    position_id                              AS "positionId",
    vehicle_id                               AS "vehicleId",
    trip_id                                  AS "tripId",
    ST_Y(location::geometry)::double precision AS lat,
    ST_X(location::geometry)::double precision AS lng,
    speed_kmh::double precision              AS "speedKmh",
    heading_deg::double precision            AS "headingDeg",
    recorded_at                              AS "recordedAt",
    received_at                              AS "receivedAt",
    telemetry_source                         AS "telemetrySource",
    recording_session_id                     AS "recordingSessionId",
    source_timestamp_ns                      AS "sourceTimestampNs",
    horizontal_accuracy_m::double precision  AS "horizontalAccuracyM"
FROM vehicle_position
WHERE vehicle_id = $1
ORDER BY received_at DESC, position_id DESC
LIMIT 1;
