-- Virtual Routing & Dispatch v1. The virtual domain is intentionally separate
-- from real Trip/VehiclePosition telemetry and recording tables.

ALTER TABLE "vehicle" DROP CONSTRAINT IF EXISTS "vehicle_source_check";
ALTER TABLE "vehicle"
  ADD CONSTRAINT "vehicle_source_check"
  CHECK ("vehicle_source" IN ('CUSTOM', 'BIMS', 'VIRTUAL'));

CREATE TABLE "virtual_scenario" (
  "scenario_id" BIGSERIAL NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "state" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "auto_accept_after_seconds" INTEGER,
  "restriction_revision" INTEGER NOT NULL DEFAULT 0,
  "created_by" BIGINT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_scenario_pkey" PRIMARY KEY ("scenario_id"),
  CONSTRAINT "virtual_scenario_state_check" CHECK ("state" IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),
  CONSTRAINT "virtual_scenario_auto_accept_check" CHECK ("auto_accept_after_seconds" IS NULL OR ("auto_accept_after_seconds" >= 0 AND "auto_accept_after_seconds" <= 86400))
);
CREATE INDEX "idx_virtual_scenario_state" ON "virtual_scenario"("state", "updated_at");

CREATE TABLE "virtual_vehicle_settings" (
  "vehicle_id" BIGINT NOT NULL,
  "auto_follow_enabled" BOOLEAN NOT NULL DEFAULT true,
  "policy_version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_vehicle_settings_pkey" PRIMARY KEY ("vehicle_id"),
  CONSTRAINT "virtual_vehicle_settings_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "virtual_route_draft" (
  "draft_id" BIGSERIAL NOT NULL,
  "scenario_id" BIGINT NOT NULL,
  "selected_vehicle_id" BIGINT NOT NULL,
  "origin" JSONB NOT NULL,
  "destination" JSONB NOT NULL,
  "waypoints" JSONB NOT NULL,
  "requested_profile" JSONB NOT NULL,
  "route_geojson" JSONB NOT NULL,
  "directed_itinerary" JSONB NOT NULL,
  "snapped_stops" JSONB NOT NULL,
  "graph_version" VARCHAR(160) NOT NULL,
  "restriction_revision" INTEGER NOT NULL,
  "distance_m" DOUBLE PRECISION NOT NULL,
  "duration_sec" DOUBLE PRECISION NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" BIGINT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_route_draft_pkey" PRIMARY KEY ("draft_id"),
  CONSTRAINT "virtual_route_draft_scenario_fkey" FOREIGN KEY ("scenario_id") REFERENCES "virtual_scenario"("scenario_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "virtual_route_draft_vehicle_fkey" FOREIGN KEY ("selected_vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_virtual_route_draft_scenario" ON "virtual_route_draft"("scenario_id", "created_at");
CREATE INDEX "idx_virtual_route_draft_vehicle" ON "virtual_route_draft"("selected_vehicle_id", "expires_at");

CREATE TABLE "virtual_dispatch_request" (
  "request_id" BIGSERIAL NOT NULL,
  "scenario_id" BIGINT NOT NULL,
  "draft_id" BIGINT NOT NULL,
  "selected_vehicle_id" BIGINT NOT NULL,
  "simulated_driver_name" VARCHAR(120) NOT NULL,
  "state" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "accept_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6),
  "accepted_trip_id" BIGINT,
  "idempotency_key" VARCHAR(120) NOT NULL,
  "requested_by" BIGINT,
  "decided_by" BIGINT,
  "decided_at" TIMESTAMPTZ(6),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_dispatch_request_pkey" PRIMARY KEY ("request_id"),
  CONSTRAINT "virtual_dispatch_request_idempotency_key_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "virtual_dispatch_request_accepted_trip_key" UNIQUE ("accepted_trip_id"),
  CONSTRAINT "virtual_dispatch_request_state_check" CHECK ("state" IN ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
  CONSTRAINT "virtual_dispatch_request_scenario_fkey" FOREIGN KEY ("scenario_id") REFERENCES "virtual_scenario"("scenario_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "virtual_dispatch_request_draft_fkey" FOREIGN KEY ("draft_id") REFERENCES "virtual_route_draft"("draft_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "virtual_dispatch_request_vehicle_fkey" FOREIGN KEY ("selected_vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_virtual_dispatch_due" ON "virtual_dispatch_request"("scenario_id", "state", "accept_at");
CREATE INDEX "idx_virtual_dispatch_vehicle_state" ON "virtual_dispatch_request"("selected_vehicle_id", "state");

CREATE TABLE "virtual_trip" (
  "virtual_trip_id" BIGSERIAL NOT NULL,
  "scenario_id" BIGINT NOT NULL,
  "vehicle_id" BIGINT NOT NULL,
  "dispatch_request_id" BIGINT NOT NULL,
  "origin" JSONB NOT NULL,
  "destination" JSONB NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'DRIVING',
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(6),
  "active_route_id" BIGINT,
  "route_version" INTEGER NOT NULL DEFAULT 1,
  "command_version" INTEGER NOT NULL DEFAULT 1,
  "trip_revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_trip_pkey" PRIMARY KEY ("virtual_trip_id"),
  CONSTRAINT "virtual_trip_dispatch_request_key" UNIQUE ("dispatch_request_id"),
  CONSTRAINT "virtual_trip_scenario_fkey" FOREIGN KEY ("scenario_id") REFERENCES "virtual_scenario"("scenario_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "virtual_trip_vehicle_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "virtual_trip_dispatch_request_fkey" FOREIGN KEY ("dispatch_request_id") REFERENCES "virtual_dispatch_request"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "idx_virtual_trip_scenario_state" ON "virtual_trip"("scenario_id", "state");
CREATE INDEX "idx_virtual_trip_vehicle_state" ON "virtual_trip"("vehicle_id", "state");
CREATE UNIQUE INDEX "uq_virtual_active_trip_vehicle" ON "virtual_trip"("vehicle_id") WHERE "state" IN ('DRIVING', 'PAUSED', 'REROUTING', 'BLOCKED_AWAITING_OPERATOR', 'NO_ROUTE');

CREATE TABLE "virtual_route" (
  "route_id" BIGSERIAL NOT NULL,
  "virtual_trip_id" BIGINT NOT NULL,
  "route_version" INTEGER NOT NULL,
  "route_type" VARCHAR(30) NOT NULL,
  "route_geojson" JSONB NOT NULL,
  "directed_itinerary" JSONB NOT NULL,
  "distance_m" DOUBLE PRECISION NOT NULL,
  "duration_sec" DOUBLE PRECISION NOT NULL,
  "restriction_revision" INTEGER NOT NULL,
  "graph_version" VARCHAR(160) NOT NULL,
  "reason" VARCHAR(40),
  "is_current" BOOLEAN NOT NULL DEFAULT true,
  "activated_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_route_pkey" PRIMARY KEY ("route_id"),
  CONSTRAINT "virtual_route_trip_version_key" UNIQUE ("virtual_trip_id", "route_version"),
  CONSTRAINT "virtual_route_trip_fkey" FOREIGN KEY ("virtual_trip_id") REFERENCES "virtual_trip"("virtual_trip_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uq_virtual_route_current" ON "virtual_route"("virtual_trip_id") WHERE "is_current";

CREATE TABLE "virtual_trip_waypoint" (
  "waypoint_id" BIGSERIAL NOT NULL,
  "virtual_trip_id" BIGINT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "original_point" JSONB NOT NULL,
  "snapped_point" JSONB,
  "snapped_edge_id" VARCHAR(180),
  "snapped_offset_m" DOUBLE PRECISION,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "client_id" VARCHAR(80),
  "reached_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_trip_waypoint_pkey" PRIMARY KEY ("waypoint_id"),
  CONSTRAINT "virtual_trip_waypoint_trip_sequence_key" UNIQUE ("virtual_trip_id", "sequence"),
  CONSTRAINT "virtual_trip_waypoint_trip_fkey" FOREIGN KEY ("virtual_trip_id") REFERENCES "virtual_trip"("virtual_trip_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "idx_virtual_waypoint_status" ON "virtual_trip_waypoint"("virtual_trip_id", "status");

CREATE TABLE "virtual_vehicle_state" (
  "vehicle_id" BIGINT NOT NULL,
  "scenario_id" BIGINT NOT NULL,
  "virtual_trip_id" BIGINT NOT NULL,
  "active_route_id" BIGINT,
  "sim_status" VARCHAR(32) NOT NULL DEFAULT 'DRIVING',
  "route_version" INTEGER NOT NULL DEFAULT 1,
  "command_version" INTEGER NOT NULL DEFAULT 1,
  "event_sequence" BIGINT NOT NULL DEFAULT 0,
  "graph_version" VARCHAR(160),
  "current_edge_id" VARCHAR(180),
  "current_physical_segment_id" VARCHAR(180),
  "offset_m" DOUBLE PRECISION,
  "speed_kmh" DOUBLE PRECISION,
  "speed_factor" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "sim_elapsed_ms" BIGINT NOT NULL DEFAULT 0,
  "last_position" JSONB NOT NULL,
  "blocked_reason" VARCHAR(160),
  "last_checkpoint_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_vehicle_state_pkey" PRIMARY KEY ("vehicle_id"),
  CONSTRAINT "virtual_vehicle_state_trip_key" UNIQUE ("virtual_trip_id"),
  CONSTRAINT "virtual_vehicle_state_vehicle_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "virtual_vehicle_state_scenario_fkey" FOREIGN KEY ("scenario_id") REFERENCES "virtual_scenario"("scenario_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "virtual_vehicle_state_trip_fkey" FOREIGN KEY ("virtual_trip_id") REFERENCES "virtual_trip"("virtual_trip_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "idx_virtual_state_scenario_status" ON "virtual_vehicle_state"("scenario_id", "sim_status");
CREATE UNIQUE INDEX "virtual_vehicle_state_active_route_id_key" ON "virtual_vehicle_state"("active_route_id");

CREATE TABLE "virtual_road_restriction" (
  "restriction_id" BIGSERIAL NOT NULL,
  "scenario_id" BIGINT NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "geometry" JSONB NOT NULL,
  "affected_directed_edge_ids" JSONB NOT NULL,
  "affected_physical_segment_ids" JSONB NOT NULL,
  "graph_version" VARCHAR(160) NOT NULL,
  "penalty_factor" DOUBLE PRECISION,
  "revision" INTEGER NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "expires_at" TIMESTAMPTZ(6),
  "reason" VARCHAR(240),
  "created_by" BIGINT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_road_restriction_pkey" PRIMARY KEY ("restriction_id"),
  CONSTRAINT "virtual_road_restriction_kind_check" CHECK ("kind" IN ('BLOCKED', 'HEAVY_PENALTY')),
  CONSTRAINT "virtual_road_restriction_penalty_check" CHECK (("kind" = 'BLOCKED' AND "penalty_factor" IS NULL) OR ("kind" = 'HEAVY_PENALTY' AND "penalty_factor" > 1 AND "penalty_factor" <= 100)),
  CONSTRAINT "virtual_road_restriction_scenario_fkey" FOREIGN KEY ("scenario_id") REFERENCES "virtual_scenario"("scenario_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "idx_virtual_restriction_active" ON "virtual_road_restriction"("scenario_id", "is_active");

CREATE TABLE "virtual_operator_event" (
  "event_id" BIGSERIAL NOT NULL,
  "scenario_id" BIGINT NOT NULL,
  "virtual_trip_id" BIGINT,
  "request_id" BIGINT,
  "actor_id" BIGINT,
  "event_type" VARCHAR(60) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "virtual_operator_event_pkey" PRIMARY KEY ("event_id"),
  CONSTRAINT "virtual_operator_event_scenario_fkey" FOREIGN KEY ("scenario_id") REFERENCES "virtual_scenario"("scenario_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "virtual_operator_event_trip_fkey" FOREIGN KEY ("virtual_trip_id") REFERENCES "virtual_trip"("virtual_trip_id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "idx_virtual_event_replay" ON "virtual_operator_event"("scenario_id", "event_id");
