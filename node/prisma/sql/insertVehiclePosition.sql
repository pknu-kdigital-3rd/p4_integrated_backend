-- prisma/sql/insertVehiclePosition.sql
-- TypedSQL isn't read-only — writes work the same way.
-- $1=vehicle_id $2=trip_id $3=lng $4=lat $5=speed_kmh $6=heading_deg $7=recorded_at $8=telemetry_source
INSERT INTO vehicle_position (vehicle_id, trip_id, location, speed_kmh, heading_deg, recorded_at, telemetry_source)
VALUES (
    $1,
    $2,
    ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography,
    $5,
    $6,
    $7,
    $8
)
RETURNING position_id AS "positionId";
