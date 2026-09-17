ALTER TABLE "trip_video"
  ADD COLUMN "duration_pts_90k" BIGINT;

CREATE TABLE "trip_video_detection_sample" (
  "detection_sample_id" BIGSERIAL NOT NULL,
  "trip_id" BIGINT NOT NULL,
  "recording_session_id" VARCHAR(80) NOT NULL,
  "relay_epoch" BIGINT NOT NULL,
  "frame_seq" BIGINT NOT NULL,
  "video_pts_90k" BIGINT NOT NULL,
  "detections" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trip_video_detection_sample_pkey" PRIMARY KEY ("detection_sample_id"),
  CONSTRAINT "trip_video_detection_sample_trip_id_fkey"
    FOREIGN KEY ("trip_id") REFERENCES "trip"("trip_id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_trip_video_detection_sample_frame"
  ON "trip_video_detection_sample"("trip_id", "recording_session_id", "relay_epoch", "frame_seq");
CREATE INDEX "idx_trip_video_detection_replay"
  ON "trip_video_detection_sample"("trip_id", "recording_session_id", "relay_epoch", "video_pts_90k");
