import { AppError } from "../../common/errors/app-error.ts";
import { tripRepository } from "./trip.repository.ts";
import type { CreateTripBody } from "./trip.schema.ts";

export const tripService = {
    getTrips() {
        return tripRepository.findRecent();
    },

    async createTrip(input: CreateTripBody) {
        const vehicle = await tripRepository.findVehicle(BigInt(input.vehicleId));
        if (!vehicle) {
            throw new AppError(404, "Vehicle not found", "VEHICLE_NOT_FOUND");
        }
        if (!vehicle.isActive) {
            throw new AppError(409, "Cannot assign a trip to an inactive vehicle", "VEHICLE_INACTIVE");
        }

        const startedAt = input.tripStatus === "IN_PROGRESS" ? new Date() : null;
        const trip = await tripRepository.create(input, startedAt);
        if (!trip) {
            throw new AppError(500, "Created trip could not be loaded", "TRIP_CREATE_FAILED");
        }
        return trip;
    },
};
