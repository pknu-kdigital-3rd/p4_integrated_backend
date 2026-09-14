import { prisma } from "../../infrastructure/database/prisma.ts";
import { removeUndefined } from "../../common/util/remove-undefined.ts";
import type {
    CreateVehicleBody,
    UpdateVehicleBody
} from "./vehicle.schema.ts";

// import type { Prisma } from "../../generated/prisma/client.ts";
// type VehicleCreateInput = Prisma.VehicleCreateInput;

export const vehicleRepository = {
    async findAll() {
        return prisma.vehicle.findMany();
    },

    async findById(vehicleId: bigint) {
        return prisma.vehicle.findUnique({
            where: {
                vehicleId,
            },
        });
    },

    async update(vehicleId: bigint, input: UpdateVehicleBody) {
        const data = removeUndefined(input);
        return prisma.vehicle.update({
            where: {
                vehicleId,
            },
            data
        });
    },

    async delete(vehicleId: bigint) {
        return prisma.vehicle.delete({
            where: {
                vehicleId,
            },
        });
    },

    async create(input: CreateVehicleBody) {
        return prisma.vehicle.create({
            data: {
                vehicleCode: input.vehicleCode,
                vehicleStatus: input.vehicleStatus,
                vehicleSource: input.vehicleSource,

                ...(input.plateNumber !== undefined ? { plateNumber: input.plateNumber } : {}),
                ...(input.vehicleName !== undefined ? { vehicleName: input.vehicleName } : {}),
                ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
                ...(input.maxLoadKg !== undefined ? { maxLoadKg: input.maxLoadKg } : {}),
                ...(input.heightM !== undefined ? { heightM: input.heightM } : {}),
                ...(input.widthM !== undefined ? { widthM: input.widthM } : {}),
                ...(input.lengthM !== undefined ? { lengthM: input.lengthM } : {}),
                ...(input.streamUrl !== undefined ? { streamUrl: input.streamUrl } : {}),
                ...(input.cameraHeightM !== undefined ? { cameraHeightM: input.cameraHeightM } : {}),
                ...(input.cameraPitchDeg !== undefined ? { cameraPitchDeg: input.cameraPitchDeg } : {}),
                ...(input.cameraRollDeg !== undefined ? { cameraRollDeg: input.cameraRollDeg } : {}),
                ...(input.cameraYawDeg !== undefined ? { cameraYawDeg: input.cameraYawDeg } : {}),
                ...(input.focalLengthMm !== undefined ? { focalLengthMm: input.focalLengthMm } : {}),
                ...(input.sensorWidthMm !== undefined ? { sensorWidthMm: input.sensorWidthMm } : {}),
                ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            },
        });
    },
};
