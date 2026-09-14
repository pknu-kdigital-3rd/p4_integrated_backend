import { AppError } from "../../common/errors/app-error.ts"
import { vehicleRepository } from "./vehicle.repository.ts";
import { CreateVehicleBody, UpdateVehicleBody } from "./vehicle.schema.ts";

export const vehicleService = {
    async getVehicles() {
        return vehicleRepository.findAll();
    },

    async getVehicle(vehicleId: bigint) {
        const vehicle = await vehicleRepository.findById(vehicleId);
        if (!vehicle) {
            throw new AppError(
                404,
                "Vehicle not found",
                "VEHICLE_NOT_FOUND",
            );
        }
        return vehicle;
    },

    async deleteVehicle(vehicleId: bigint) {
        return vehicleRepository.delete(vehicleId);
    },

    async createVehicle(input: CreateVehicleBody) {
        return vehicleRepository.create(input);
    },

    async updateVehicle(vehicleId: bigint, input: UpdateVehicleBody) {
        return vehicleRepository.update(vehicleId, input);
    }
};
