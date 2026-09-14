
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE "system_user" ADD CONSTRAINT chk_system_user_role
  CHECK (role IN ('ADMIN','OPERATOR','VIEWER'));
ALTER TABLE "vehicle" ADD CONSTRAINT chk_vehicle_status
  CHECK (vehicle_status IN ('READY','DRIVING','STOPPED','MAINTENANCE','OFFLINE'));
ALTER TABLE "driver" ADD CONSTRAINT chk_driver_status
  CHECK (driver_status IN ('AVAILABLE','DRIVING','OFF_DUTY'));
ALTER TABLE "trip" ADD CONSTRAINT chk_trip_status
  CHECK (trip_status IN ('READY','IN_PROGRESS','PAUSED','COMPLETED','CANCELLED'));
ALTER TABLE "route" ADD CONSTRAINT chk_route_type
  CHECK (route_type IN ('INITIAL','RECALCULATED'));
ALTER TABLE "detection_event" ADD CONSTRAINT chk_detection_event_risk_level
  CHECK (risk_level IN ('NORMAL','CAUTION','DANGER'));
ALTER TABLE "detection_event" ADD CONSTRAINT chk_detection_event_telemetry_source
  CHECK (telemetry_source IN ('DEVICE_SENSOR','SIMULATED'));
ALTER TABLE "alert" ADD CONSTRAINT chk_alert_type
  CHECK (alert_type IN ('OBJECT_PROXIMITY','ROUTE_DEVIATION','TRIP_COMPLETED'));
ALTER TABLE "alert" ADD CONSTRAINT chk_alert_severity
  CHECK (severity IN ('INFO','WARNING','CRITICAL'));
ALTER TABLE "alert" ADD CONSTRAINT chk_alert_status
  CHECK (alert_status IN ('UNCONFIRMED','ACKNOWLEDGED','RESOLVED'));
ALTER TABLE "alert" ADD CONSTRAINT chk_alert_exactly_one_cause CHECK (
  (detection_event_id IS NOT NULL AND route_deviation_id IS NULL AND trip_id IS NULL) OR
  (detection_event_id IS NULL AND route_deviation_id IS NOT NULL AND trip_id IS NULL) OR
  (detection_event_id IS NULL AND route_deviation_id IS NULL AND trip_id IS NOT NULL)
);
ALTER TABLE "transport_goal" ADD CONSTRAINT chk_transport_goal_priority
  CHECK (priority IN ('HIGH','NORMAL','LOW'));
ALTER TABLE "transport_goal" ADD CONSTRAINT chk_transport_goal_status
  CHECK (goal_status IN ('PENDING','ASSIGNED','IN_PROGRESS','COMPLETED','DELAYED','CANCELLED'));