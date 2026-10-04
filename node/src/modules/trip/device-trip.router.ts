import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { parseVehicleId, replayPreviewSchema, replayPreviewService } from "./trip.preview.ts";
import { tripService } from "./trip.service.ts";
import { matchReplayPreview } from "./trip-road-match.ts";
import { subscribeTripChanges } from "./trip-events.ts";

export const deviceTripRouter = Router();
const stateBody = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() });

deviceTripRouter.put("/vehicles/:vehicleId/replay-preview", validateBody(replayPreviewSchema), async (req, res) => {
    const preview = await replayPreviewService.upload(parseVehicleId(String(req.params.vehicleId)), req.body);
    // Prepare the road geometry while the phone continues its upload flow.
    void matchReplayPreview(preview);
    res.json({ data: { replayPreviewId: preview.replayPreviewId, fingerprint: preview.fingerprint } });
});
deviceTripRouter.get("/vehicles/:vehicleId/trip", async (req, res) => {
    res.json({ data: await tripService.current(String(req.params.vehicleId), true) });
});
deviceTripRouter.get("/vehicles/:vehicleId/trip/events", async (req, res) => {
    const vehicleId = parseVehicleId(String(req.params.vehicleId));
    let closed = false, revision = 0;
    const writeSnapshot = async () => {
        const version = ++revision;
        try {
            const trip = await tripService.current(vehicleId.toString(), true);
            if (!closed && version === revision) {
                const payload = JSON.stringify({ data: trip }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
                res.write(`event: trip\ndata: ${payload}\n\n`);
            }
        } catch { if (!closed) res.end(); }
    };
    const unsubscribe = subscribeTripChanges(vehicleId, () => { void writeSnapshot(); });
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    // A transport keepalive, with no periodic database query.
    const heartbeat = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 15_000);
    res.on("close", () => { closed = true; clearInterval(heartbeat); unsubscribe(); });
    await writeSnapshot();
});
deviceTripRouter.post("/vehicles/:vehicleId/trips/:tripId/start", validateBody(stateBody), async (req, res) => {
    res.json({ data: await tripService.changeState(String(req.params.vehicleId), String(req.params.tripId), "start", req.body.fingerprint) });
});
deviceTripRouter.post("/vehicles/:vehicleId/trips/:tripId/complete", async (req, res) => {
    res.json({ data: await tripService.changeState(String(req.params.vehicleId), String(req.params.tripId), "complete") });
});
