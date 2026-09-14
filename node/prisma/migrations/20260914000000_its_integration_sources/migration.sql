ALTER TABLE "vehicle"
  ADD COLUMN "vehicle_source" VARCHAR(20) NOT NULL DEFAULT 'CUSTOM',
  ADD COLUMN "external_id" VARCHAR(100);

ALTER TABLE "route"
  ADD COLUMN "route_source" VARCHAR(30) NOT NULL DEFAULT 'OPTIMAL_PATH',
  ADD COLUMN "source_metadata" JSONB;

ALTER TABLE "vehicle_position"
  ADD COLUMN "telemetry_source" VARCHAR(30) NOT NULL DEFAULT 'DEVICE_GPS';

ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_source_check"
  CHECK ("vehicle_source" IN ('CUSTOM', 'BIMS'));
ALTER TABLE "route" ADD CONSTRAINT "route_source_check"
  CHECK ("route_source" IN ('BIMS_LINE', 'OPTIMAL_PATH'));
ALTER TABLE "vehicle_position" ADD CONSTRAINT "vehicle_position_telemetry_source_check"
  CHECK ("telemetry_source" IN ('BIMS_LIVE', 'BIMS_REPLAY', 'DEVICE_GPS', 'RECORDED_GPS'));
CREATE UNIQUE INDEX "vehicle_vehicle_source_external_id_key"
  ON "vehicle"("vehicle_source", "external_id");
