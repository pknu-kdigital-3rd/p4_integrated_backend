ALTER TABLE "trip_video"
  ADD COLUMN "recording_session_id" VARCHAR(80),
  ADD COLUMN "segment_index" INTEGER,
  ADD COLUMN "storage_bucket" VARCHAR(100),
  ADD COLUMN "object_key" TEXT,
  ADD COLUMN "content_type" VARCHAR(100) NOT NULL DEFAULT 'video/mp4',
  ADD COLUMN "etag" VARCHAR(128),
  ADD COLUMN "size_bytes" BIGINT,
  ADD COLUMN "relay_epoch" BIGINT,
  ADD COLUMN "start_seq" BIGINT,
  ADD COLUMN "end_seq" BIGINT,
  ADD COLUMN "start_pts_90k" BIGINT,
  ADD COLUMN "end_pts_90k" BIGINT,
  ADD COLUMN "upload_status" VARCHAR(20) NOT NULL DEFAULT 'FAILED',
  ADD COLUMN "failure_reason" TEXT;

-- Existing rows refer to legacy URLs and have no MinIO object identity.
-- Preserve them for history while keeping them unavailable to the new player.
UPDATE "trip_video"
SET "recording_session_id" = 'legacy-' || "trip_video_id"::text,
    "segment_index" = 0,
    "storage_bucket" = 'legacy',
    "object_key" = 'legacy/trip-video/' || "trip_video_id"::text,
    "relay_epoch" = 0,
    "start_seq" = 0,
    "start_pts_90k" = 0,
    "upload_status" = 'FAILED';

ALTER TABLE "trip_video"
  ALTER COLUMN "recording_session_id" SET NOT NULL,
  ALTER COLUMN "segment_index" SET NOT NULL,
  ALTER COLUMN "storage_bucket" SET NOT NULL,
  ALTER COLUMN "object_key" SET NOT NULL,
  ALTER COLUMN "relay_epoch" SET NOT NULL,
  ALTER COLUMN "start_seq" SET NOT NULL,
  ALTER COLUMN "start_pts_90k" SET NOT NULL,
  ALTER COLUMN "upload_status" SET DEFAULT 'FINALIZED',
  ALTER COLUMN "video_url" DROP NOT NULL,
  ALTER COLUMN "start_frame_id" DROP NOT NULL;

CREATE UNIQUE INDEX "uq_trip_video_recording_segment"
  ON "trip_video"("recording_session_id", "segment_index");
CREATE UNIQUE INDEX "uq_trip_video_object_key"
  ON "trip_video"("object_key");
CREATE INDEX "idx_trip_video_relay_seq"
  ON "trip_video"("trip_id", "relay_epoch", "start_seq");

ALTER TABLE "trip_video"
  ADD CONSTRAINT "trip_video_upload_status_check"
  CHECK ("upload_status" IN ('FINALIZED', 'FAILED'));
