import type { Request, Response } from "express";

import { prisma } from "../../infrastructure/database/prisma.ts";
import { collectFleetSnapshot, renderSnapshotText } from "./fleet.snapshot.ts";

export const fleetController = {
    // Read-only fleet state: real vehicles, active virtual scenarios and
    // recent vision detections/alerts, plus the compact text the assistant
    // receives, so operators can see exactly what it was told.
    async summary(_req: Request, res: Response) {
        const snapshot = await collectFleetSnapshot(prisma);
        res.status(200).json({ data: { snapshot, text: renderSnapshotText(snapshot) } });
    },
};
