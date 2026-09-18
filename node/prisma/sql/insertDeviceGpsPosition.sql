-- prisma/sql/insertDeviceGpsPosition.sql
-- v18: one authoritative Android/device GPS fix -> one vehicle_position row.
-- Idempotent on (recording_session_id, source_timestamp_ns) so relay retries and
-- WebRTC reconnect duplicates never create a second row. Never used for
-- interpolated/predicted display positions.
-- @param {BigInt}   $1:vehicleId
-- @param {BigInt}   $2:tripId
-- @param {Float}    $3:lng
-- @param {Float}    $4:lat
-- @param {Float}    $5:speedKmh           speed_mps * 3.6
-- @param {Float}    $6:headingDeg         GPS bearing_deg (never IMU yaw)
-- @param {DateTime} $7:recordedAt         source UTC (utc_epoch_ms), else receivedAt
-- @param {String}   $8:telemetrySource    RECORDED_GPS (REPLAY) | DEVICE_GPS (LIVE)
-- @param {String}   $9:recordingSessionId
-- @param {BigInt}   $10:sourceTimestampNs
-- @param {Float}    $11:altitudeM
-- @param {Float}    $12:horizontalAccuracyM
-- @param {DateTime} $13:receivedAt
INSERT INTO vehicle_position (
    vehicle_id, trip_id, location, speed_kmh, heading_deg, recorded_at, telemetry_source,
    recording_session_id, source_timestamp_ns, altitude_m, horizontal_accuracy_m, received_at
)
VALUES (
    $1,
    $2,
    ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13
)
ON CONFLICT (recording_session_id, source_timestamp_ns) DO NOTHING
RETURNING position_id AS "positionId";
