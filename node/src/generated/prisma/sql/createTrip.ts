import { makeTypedQueryFactory, type TypedSql } from "@prisma/client/runtime/client";

type CreateTripParams = [
    vehicleId: bigint,
    driverId: bigint | null,
    originName: string | null,
    originAddress: string | null,
    originLongitude: number | null,
    originLatitude: number | null,
    destinationName: string,
    destinationAddress: string | null,
    destinationLongitude: number,
    destinationLatitude: number,
    plannedStartAt: Date | null,
    tripStatus: "READY" | "IN_PROGRESS",
    startedAt: Date | null,
];

type CreateTripResult = {
    tripId: bigint;
    vehicleId: bigint;
    driverId: bigint | null;
    originName: string | null;
    destinationName: string;
    tripStatus: string;
    plannedStartAt: Date | null;
    createdAt: Date;
};

const createTripQuery = makeTypedQueryFactory(`
INSERT INTO trip (
    vehicle_id,
    driver_id,
    origin_name,
    origin_address,
    origin_location,
    destination_name,
    destination_address,
    destination_location,
    trip_status,
    planned_start_at,
    started_at
)
VALUES (
    $1,
    $2,
    $3,
    $4,
    CASE
        WHEN $5 IS NULL OR $6 IS NULL THEN NULL
        ELSE ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography
    END,
    $7,
    $8,
    ST_SetSRID(ST_MakePoint($9, $10), 4326)::geography,
    $12,
    $11,
    $13
)
RETURNING
    trip_id AS "tripId",
    vehicle_id AS "vehicleId",
    driver_id AS "driverId",
    origin_name AS "originName",
    destination_name AS "destinationName",
    trip_status AS "tripStatus",
    planned_start_at AS "plannedStartAt",
    created_at AS "createdAt"
`);

export const createTrip = (...params: CreateTripParams) =>
    createTripQuery(...params) as TypedSql<CreateTripParams, CreateTripResult>;
