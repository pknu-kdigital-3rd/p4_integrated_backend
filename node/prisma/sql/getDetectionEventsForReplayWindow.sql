-- prisma/sql/getDetectionEventsForReplayWindow.sql
-- v15: Node read-side query. FastAPI Vision owns detection_event INSERTs.
-- Replay is aligned by capture_timestamp_ns, not network/DB arrival time or frame_id/fps.
-- @param {BigInt} $1:tripId
-- @param {BigInt} $2:fromCaptureTimestampNs
-- @param {BigInt} $3:toCaptureTimestampNs

SELECT
    de.detection_event_id                  AS "detectionEventId",
    de.session_id                          AS "sessionId",
    de.frame_id                            AS "frameId",
    de.capture_timestamp_ns                AS "captureTimestampNs",
    de.vehicle_id                          AS "vehicleId",
    de.vehicle_code                        AS "vehicleCode",
    de.trip_id                             AS "tripId",
    de.model_version                       AS "modelVersion",
    de.class_id                            AS "classId",
    de.track_id                            AS "trackId",
    de.class_name                          AS "className",
    de.display_name                        AS "displayName",
    de.confidence::double precision        AS confidence,
    de.distance_m::double precision        AS "distanceM",
    de.warning_distance_m::double precision AS "warningDistanceM",
    de.risk_level                          AS "riskLevel",
    CASE
        WHEN de.location IS NULL THEN NULL
        ELSE ST_Y(de.location::geometry)::double precision
    END                                    AS lat,
    CASE
        WHEN de.location IS NULL THEN NULL
        ELSE ST_X(de.location::geometry)::double precision
    END                                    AS lng,
    de.bbox_x1::double precision           AS "bboxX1",
    de.bbox_y1::double precision           AS "bboxY1",
    de.bbox_x2::double precision           AS "bboxX2",
    de.bbox_y2::double precision           AS "bboxY2",
    de.pitch_at_capture_deg::double precision AS "pitchAtCaptureDeg",
    de.roll_at_capture_deg::double precision  AS "rollAtCaptureDeg",
    de.telemetry_source                    AS "telemetrySource",
    de.detected_at                         AS "detectedAt",
    de.created_at                          AS "createdAt"
FROM detection_event de
WHERE de.trip_id = $1
  AND de.capture_timestamp_ns >= $2
  AND de.capture_timestamp_ns <= $3
ORDER BY
    de.capture_timestamp_ns ASC,
    de.frame_id ASC,
    de.detection_event_id ASC;
