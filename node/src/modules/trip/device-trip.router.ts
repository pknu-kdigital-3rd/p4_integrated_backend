import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { parseVehicleId, replayPreviewSchema, replayPreviewService } from "./trip.preview.ts";
import { tripService } from "./trip.service.ts";

export const deviceTripRouter = Router();
const stateBody = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() });

deviceTripRouter.put("/vehicles/:vehicleId/replay-preview", validateBody(replayPreviewSchema), async (req, res) => {
    const preview = await replayPreviewService.upload(parseVehicleId(String(req.params.vehicleId)), req.body);
    res.json({ data: { replayPreviewId: preview.replayPreviewId, fingerprint: preview.fingerprint } });
});
deviceTripRouter.get("/vehicles/:vehicleId/trip", async (req, res) => {
    res.json({ data: await tripService.current(String(req.params.vehicleId)) });
});
deviceTripRouter.post("/vehicles/:vehicleId/trips/:tripId/start", validateBody(stateBody), async (req, res) => {
    res.json({ data: await tripService.changeState(String(req.params.vehicleId), String(req.params.tripId), "start", req.body.fingerprint) });
});
deviceTripRouter.post("/vehicles/:vehicleId/trips/:tripId/complete", async (req, res) => {
    res.json({ data: await tripService.changeState(String(req.params.vehicleId), String(req.params.tripId), "complete") });
});
