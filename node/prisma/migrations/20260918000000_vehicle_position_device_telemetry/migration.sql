-- v18: authoritative Android/device GPS observations.
--   recorded_at          source/sensor UTC observation time (replay: original recording UTC)
--   received_at          server ingestion time; orders "current" position
--   recording_session_id + source_timestamp_ns
--                        position in the source recording timeline and the
--                        idempotency key for relay retries/reconnects
ALTER TABLE "vehicle_position"
  ADD COLUMN "recording_session_id" VARCHAR(80),
  ADD COLUMN "source_timestamp_ns" BIGINT,
  ADD COLUMN "altitude_m" DECIMAL(10,3),
  ADD COLUMN "horizontal_accuracy_m" DECIMAL(10,3),
  ADD COLUMN "received_at" TIMESTAMPTZ(6);

-- Existing rows were written when they were observed, so their receive time is
-- best approximated by their observation time.
UPDATE "vehicle_position" SET "received_at" = "recorded_at" WHERE "received_at" IS NULL;

ALTER TABLE "vehicle_position"
  ALTER COLUMN "received_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "received_at" SET NOT NULL;

ALTER TABLE "vehicle_position" ADD CONSTRAINT "chk_vehicle_position_source_timestamp_positive"
  CHECK ("source_timestamp_ns" IS NULL OR "source_timestamp_ns" > 0);
ALTER TABLE "vehicle_position" ADD CONSTRAINT "chk_vehicle_position_horizontal_accuracy"
  CHECK ("horizontal_accuracy_m" IS NULL OR "horizontal_accuracy_m" >= 0);

-- NULLs are distinct, so BIMS rows without a session never conflict.
CREATE UNIQUE INDEX "uq_vehicle_position_session_source_ts"
  ON "vehicle_position"("recording_session_id", "source_timestamp_ns");
CREATE INDEX "idx_vehicle_position_vehicle_received"
  ON "vehicle_position"("vehicle_id", "received_at");
