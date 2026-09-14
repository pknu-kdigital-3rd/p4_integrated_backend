-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateTable
CREATE TABLE "system_user" (
    "user_id" BIGSERIAL NOT NULL,
    "login_id" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "user_name" VARCHAR(100) NOT NULL,
    "role" VARCHAR(30) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_user_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "vehicle_id" BIGSERIAL NOT NULL,
    "vehicle_code" VARCHAR(50) NOT NULL,
    "plate_number" VARCHAR(30),
    "vehicle_name" VARCHAR(100),
    "max_load_kg" DECIMAL(10,2),
    "height_m" DECIMAL(5,2),
    "width_m" DECIMAL(5,2),
    "length_m" DECIMAL(5,2),
    "vehicle_status" VARCHAR(30) NOT NULL,
    "stream_url" TEXT,
    "camera_height_m" DECIMAL(5,3),
    "camera_pitch_deg" DECIMAL(6,2),
    "camera_roll_deg" DECIMAL(6,2),
    "camera_yaw_deg" DECIMAL(6,2),
    "focal_length_mm" DECIMAL(6,2),
    "sensor_width_mm" DECIMAL(6,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("vehicle_id")
);

-- CreateTable
CREATE TABLE "driver" (
    "driver_id" BIGSERIAL NOT NULL,
    "driver_name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(30),
    "license_number" VARCHAR(100),
    "driver_status" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "trip" (
    "trip_id" BIGSERIAL NOT NULL,
    "vehicle_id" BIGINT NOT NULL,
    "driver_id" BIGINT,
    "origin_name" VARCHAR(150),
    "origin_address" TEXT,
    "origin_location" geography(Point, 4326),
    "destination_name" VARCHAR(150) NOT NULL,
    "destination_address" TEXT,
    "destination_location" geography(Point, 4326) NOT NULL,
    "trip_status" VARCHAR(30) NOT NULL,
    "planned_start_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "actual_distance_m" INTEGER,
    "ai_summary" TEXT,
    "ai_summary_generated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_pkey" PRIMARY KEY ("trip_id")
);

-- CreateTable
CREATE TABLE "trip_video" (
    "trip_video_id" BIGSERIAL NOT NULL,
    "trip_id" BIGINT NOT NULL,
    "video_url" TEXT NOT NULL,
    "start_frame_id" BIGINT NOT NULL,
    "end_frame_id" BIGINT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "fps" DECIMAL(5,2),
    "duration_sec" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_video_pkey" PRIMARY KEY ("trip_video_id")
);

-- CreateTable
CREATE TABLE "route" (
    "route_id" BIGSERIAL NOT NULL,
    "trip_id" BIGINT NOT NULL,
    "route_version" INTEGER NOT NULL,
    "route_type" VARCHAR(30) NOT NULL,
    "distance_m" INTEGER,
    "duration_sec" INTEGER,
    "encoded_polyline" TEXT,
    "route_geojson" JSONB,
    "route_line" geography(LineString, 4326),
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_pkey" PRIMARY KEY ("route_id")
);

-- CreateTable
CREATE TABLE "vehicle_position" (
    "position_id" BIGSERIAL NOT NULL,
    "vehicle_id" BIGINT NOT NULL,
    "trip_id" BIGINT,
    "location" geography(Point, 4326) NOT NULL,
    "speed_kmh" DECIMAL(6,2),
    "heading_deg" DECIMAL(6,2),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_position_pkey" PRIMARY KEY ("position_id")
);

-- CreateTable
CREATE TABLE "route_deviation" (
    "deviation_id" BIGSERIAL NOT NULL,
    "vehicle_id" BIGINT NOT NULL,
    "trip_id" BIGINT NOT NULL,
    "route_id" BIGINT NOT NULL,
    "deviation_distance_m" DECIMAL(10,2) NOT NULL,
    "location" geography(Point, 4326) NOT NULL,
    "detected_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "recalculated_route_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_deviation_pkey" PRIMARY KEY ("deviation_id")
);

-- CreateTable
CREATE TABLE "object_class" (
    "class_id" BIGSERIAL NOT NULL,
    "model_class_id" INTEGER NOT NULL,
    "class_name" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "warning_distance_m" DECIMAL(6,2),
    "is_alert_target" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "object_class_pkey" PRIMARY KEY ("class_id")
);

-- CreateTable
CREATE TABLE "detection_event" (
    "detection_event_id" BIGSERIAL NOT NULL,
    "frame_id" BIGINT NOT NULL,
    "vehicle_id" BIGINT NOT NULL,
    "vehicle_code" VARCHAR(50) NOT NULL,
    "trip_id" BIGINT,
    "class_id" BIGINT NOT NULL,
    "class_name" VARCHAR(100) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "distance_m" DECIMAL(8,2),
    "warning_distance_m" DECIMAL(8,2),
    "risk_level" VARCHAR(20) NOT NULL,
    "location" geography(Point, 4326),
    "bbox_x1" DECIMAL(10,4),
    "bbox_y1" DECIMAL(10,4),
    "bbox_x2" DECIMAL(10,4),
    "bbox_y2" DECIMAL(10,4),
    "pitch_at_capture_deg" DECIMAL(6,3),
    "roll_at_capture_deg" DECIMAL(6,3),
    "telemetry_source" VARCHAR(20),
    "detected_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detection_event_pkey" PRIMARY KEY ("detection_event_id")
);

-- CreateTable
CREATE TABLE "event_image" (
    "event_image_id" BIGSERIAL NOT NULL,
    "detection_event_id" BIGINT NOT NULL,
    "image_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_image_pkey" PRIMARY KEY ("event_image_id")
);

-- CreateTable
CREATE TABLE "alert" (
    "alert_id" BIGSERIAL NOT NULL,
    "vehicle_id" BIGINT NOT NULL,
    "detection_event_id" BIGINT,
    "route_deviation_id" BIGINT,
    "trip_id" BIGINT,
    "alert_type" VARCHAR(30) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "alert_message" TEXT,
    "operator_note" TEXT,
    "alert_status" VARCHAR(30) NOT NULL,
    "acknowledged_by" BIGINT,
    "acknowledged_at" TIMESTAMPTZ(6),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_pkey" PRIMARY KEY ("alert_id")
);

-- CreateTable
CREATE TABLE "transport_goal" (
    "goal_id" BIGSERIAL NOT NULL,
    "goal_code" VARCHAR(50) NOT NULL,
    "destination_name" VARCHAR(150) NOT NULL,
    "destination_address" TEXT,
    "destination_location" geography(Point, 4326),
    "cargo_weight_kg" DECIMAL(10,2),
    "priority" VARCHAR(20) NOT NULL,
    "target_eta" TIMESTAMPTZ(6),
    "goal_status" VARCHAR(30) NOT NULL,
    "assigned_vehicle_id" BIGINT,
    "assigned_trip_id" BIGINT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transport_goal_pkey" PRIMARY KEY ("goal_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "system_user_login_id_key" ON "system_user"("login_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_vehicle_code_key" ON "vehicle"("vehicle_code");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_plate_number_key" ON "vehicle"("plate_number");

-- CreateIndex
CREATE UNIQUE INDEX "driver_license_number_key" ON "driver"("license_number");

-- CreateIndex
CREATE INDEX "idx_trip_video_trip_start" ON "trip_video"("trip_id", "started_at");

-- CreateIndex
CREATE INDEX "idx_route_line" ON "route" USING GIST ("route_line");

-- CreateIndex
CREATE UNIQUE INDEX "route_trip_id_route_version_key" ON "route"("trip_id", "route_version");

-- CreateIndex
CREATE INDEX "idx_vehicle_position_vehicle_time" ON "vehicle_position"("vehicle_id", "recorded_at");

-- CreateIndex
CREATE INDEX "idx_vehicle_position_location" ON "vehicle_position" USING GIST ("location");

-- CreateIndex
CREATE INDEX "idx_route_deviation_location" ON "route_deviation" USING GIST ("location");

-- CreateIndex
CREATE UNIQUE INDEX "object_class_model_class_id_class_name_key" ON "object_class"("model_class_id", "class_name");

-- CreateIndex
CREATE INDEX "idx_detection_event_frame" ON "detection_event"("vehicle_id", "frame_id");

-- CreateIndex
CREATE INDEX "idx_detection_event_location" ON "detection_event" USING GIST ("location");

-- CreateIndex
CREATE UNIQUE INDEX "transport_goal_goal_code_key" ON "transport_goal"("goal_code");

-- CreateIndex
CREATE INDEX "idx_transport_goal_status" ON "transport_goal"("goal_status", "target_eta");

-- CreateIndex
CREATE INDEX "idx_transport_goal_vehicle" ON "transport_goal"("assigned_vehicle_id");

-- CreateIndex
CREATE INDEX "idx_transport_goal_location" ON "transport_goal" USING GIST ("destination_location");

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver"("driver_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_video" ADD CONSTRAINT "trip_video_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("trip_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("trip_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_position" ADD CONSTRAINT "vehicle_position_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_position" ADD CONSTRAINT "vehicle_position_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("trip_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_deviation" ADD CONSTRAINT "route_deviation_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_deviation" ADD CONSTRAINT "route_deviation_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("trip_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_deviation" ADD CONSTRAINT "route_deviation_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "route"("route_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_deviation" ADD CONSTRAINT "route_deviation_recalculated_route_id_fkey" FOREIGN KEY ("recalculated_route_id") REFERENCES "route"("route_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_event" ADD CONSTRAINT "detection_event_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_event" ADD CONSTRAINT "detection_event_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("trip_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detection_event" ADD CONSTRAINT "detection_event_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "object_class"("class_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_image" ADD CONSTRAINT "event_image_detection_event_id_fkey" FOREIGN KEY ("detection_event_id") REFERENCES "detection_event"("detection_event_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_detection_event_id_fkey" FOREIGN KEY ("detection_event_id") REFERENCES "detection_event"("detection_event_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_route_deviation_id_fkey" FOREIGN KEY ("route_deviation_id") REFERENCES "route_deviation"("deviation_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("trip_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert" ADD CONSTRAINT "alert_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "system_user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_goal" ADD CONSTRAINT "transport_goal_assigned_vehicle_id_fkey" FOREIGN KEY ("assigned_vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transport_goal" ADD CONSTRAINT "transport_goal_assigned_trip_id_fkey" FOREIGN KEY ("assigned_trip_id") REFERENCES "trip"("trip_id") ON DELETE SET NULL ON UPDATE CASCADE;
