import { z } from "zod";
import { AppError } from "../../common/errors/app-error.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";

export const routeModeSchema = z.enum(["DUAL", "REPLAY_ONLY"]);
const previewPointSchema = z.tuple([
    z.string().regex(/^\d+$/),
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
    z.number().finite().nonnegative(),
]);
export type PreviewPoint = z.infer<typeof previewPointSchema>;
export function parseVehicleId(value: string): bigint {
    if (!/^[1-9]\d*$/.test(value)) throw new AppError(400, "vehicleId must be a positive integer", "INVALID_VEHICLE_ID");
    return BigInt(value);
}

export const replayPreviewSchema = z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    datasetName: z.string().trim().min(1).max(150),
    points: z.array(previewPointSchema).min(2).max(1500),
    totalDistanceM: z.number().int().nonnegative(),
}).superRefine((value, context) => {
    for (let index = 1; index < value.points.length; index++) {
        const before = value.points[index - 1]!;
        const after = value.points[index]!;
        if (BigInt(after[0]) < BigInt(before[0]) || after[3] < before[3]) {
            context.addIssue({ code: "custom", path: ["points", index], message: "Preview time and distance must not decrease" });
            break;
        }
    }
    if (Math.abs(value.points.at(-1)![3] - value.totalDistanceM) > 2) {
        context.addIssue({ code: "custom", path: ["totalDistanceM"], message: "Distance must match final point" });
    }
});

export function previewPoints(value: unknown): PreviewPoint[] {
    const result = z.array(previewPointSchema).safeParse(value);
    if (!result.success || result.data.length < 2) throw new AppError(500, "Stored replay preview is invalid", "REPLAY_PREVIEW_INVALID");
    return result.data;
}

export const replayPreviewService = {
    async upload(vehicleId: bigint, input: z.infer<typeof replayPreviewSchema>) {
        const vehicle = await prisma.vehicle.findUnique({ where: { vehicleId }, select: { vehicleId: true, isActive: true } });
        if (!vehicle || !vehicle.isActive) throw new AppError(404, "Active vehicle not found", "VEHICLE_NOT_FOUND");
        return prisma.replayPreview.upsert({
            where: { vehicleId_fingerprint: { vehicleId, fingerprint: input.fingerprint } },
            create: { vehicleId, fingerprint: input.fingerprint, datasetName: input.datasetName,
                points: input.points, totalDistanceM: input.totalDistanceM },
            // A trip may already pin this fingerprint; never rewrite its path or endpoint.
            update: { createdAt: new Date() },
        });
    },
    latest(vehicleId: bigint) {
        return prisma.replayPreview.findFirst({ where: { vehicleId }, orderBy: [{ createdAt: "desc" }, { replayPreviewId: "desc" }] });
    },
};
