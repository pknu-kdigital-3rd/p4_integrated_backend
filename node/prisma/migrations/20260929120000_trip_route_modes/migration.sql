CREATE TABLE "replay_preview" (
    "replay_preview_id" BIGSERIAL PRIMARY KEY,
    "vehicle_id" BIGINT NOT NULL REFERENCES "vehicle"("vehicle_id"),
    "fingerprint" VARCHAR(64) NOT NULL,
    "dataset_name" VARCHAR(150) NOT NULL,
    "points" JSONB NOT NULL,
    "total_distance_m" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "replay_preview_vehicle_id_fingerprint_key" UNIQUE ("vehicle_id", "fingerprint")
);
CREATE INDEX "replay_preview_vehicle_id_created_at_idx" ON "replay_preview"("vehicle_id", "created_at");
ALTER TABLE "trip" ADD COLUMN "route_mode" VARCHAR(20) NOT NULL DEFAULT 'DUAL';
ALTER TABLE "trip" ADD COLUMN "replay_preview_id" BIGINT REFERENCES "replay_preview"("replay_preview_id");
ALTER TABLE "trip" ADD CONSTRAINT "trip_route_mode_check" CHECK ("route_mode" IN ('DUAL', 'REPLAY_ONLY'));
