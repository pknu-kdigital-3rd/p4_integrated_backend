import type { Request, Response } from "express";
import { virtualService } from "./virtual.service.ts";
import type {
    CommandBody,
    CreateScenarioBody,
    CreateVirtualVehicleBody,
    DestinationBody,
    DispatchRequestBody,
    FollowingBody,
    RestrictionBody,
    RoutePreviewBody,
    WaypointsBody,
    RestrictionUpdateBody,
    SnapPointBody,
    VirtualVehicleLifecycleBody,
} from "./virtual.schema.ts";

function actorId(req: Request): bigint | undefined {
    const value = req.auth?.userId;
    return value && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

export const virtualController = {
    async createScenario(req: Request<{}, {}, CreateScenarioBody>, res: Response) {
        res.status(201).json({ data: await virtualService.createScenario(req.body, actorId(req)) });
    },

    async listScenarios(_req: Request, res: Response) {
        res.json({ data: await virtualService.listScenarios() });
    },

    async removeScenario(req: Request<{ scenarioId: string }>, res: Response) {
        res.json({ data: await virtualService.removeScenario(BigInt(req.params.scenarioId), actorId(req)) });
    },

    async getScenario(req: Request<{ scenarioId: string }>, res: Response) {
        res.json({ data: await virtualService.getScenario(BigInt(req.params.scenarioId)) });
    },

    async listVehicles(req: Request<{ scenarioId: string }>, res: Response) {
        res.json({ data: await virtualService.listVehicles(BigInt(req.params.scenarioId)) });
    },

    async createVehicle(req: Request<{ scenarioId: string }, {}, CreateVirtualVehicleBody>, res: Response) {
        // The scenario is part of the URL to keep the UI workflow scoped. Inventory is
        // global by design so a virtual vehicle can be reused in consecutive scenarios.
        await virtualService.getScenario(BigInt(req.params.scenarioId));
        res.status(201).json({ data: await virtualService.createVehicle(req.body) });
    },

    async previewRoute(req: Request<{ scenarioId: string }, {}, RoutePreviewBody>, res: Response) {
        res.status(201).json({ data: await virtualService.previewRoute(BigInt(req.params.scenarioId), req.body, actorId(req)) });
    },

    async snapRoutePoint(req: Request<{ scenarioId: string }, {}, SnapPointBody>, res: Response) {
        res.json({ data: await virtualService.snapRoutePoint(BigInt(req.params.scenarioId), req.body) });
    },

    async listRequests(req: Request<{ scenarioId: string }>, res: Response) {
        res.json({ data: await virtualService.listDispatchRequests(BigInt(req.params.scenarioId)) });
    },

    async createRequest(req: Request<{ scenarioId: string }, {}, DispatchRequestBody>, res: Response) {
        res.status(201).json({ data: await virtualService.createDispatchRequest(BigInt(req.params.scenarioId), req.body, actorId(req)) });
    },

    async acceptRequest(req: Request<{ requestId: string }>, res: Response) {
        res.json({ data: await virtualService.acceptRequest(BigInt(req.params.requestId), actorId(req)) });
    },

    async rejectRequest(req: Request<{ requestId: string }>, res: Response) {
        res.json({ data: await virtualService.rejectRequest(BigInt(req.params.requestId), actorId(req)) });
    },

    async setFollowing(req: Request<{ vehicleId: string }, {}, FollowingBody>, res: Response) {
        res.json({ data: await virtualService.setFollowing(BigInt(req.params.vehicleId), req.body, actorId(req)) });
    },

    async setVehicleActive(req: Request<{ vehicleId: string }, {}, VirtualVehicleLifecycleBody>, res: Response) {
        res.json({ data: await virtualService.setVehicleActive(BigInt(req.params.vehicleId), req.body.isActive) });
    },

    async getTrip(req: Request<{ tripId: string }>, res: Response) {
        res.json({ data: await virtualService.getTrip(BigInt(req.params.tripId)) });
    },

    async command(req: Request<{ tripId: string }, {}, CommandBody>, res: Response) {
        res.json({ data: await virtualService.command(BigInt(req.params.tripId), req.body, actorId(req)) });
    },

    async replaceWaypoints(req: Request<{ tripId: string }, {}, WaypointsBody>, res: Response) {
        res.json({ data: await virtualService.replaceWaypoints(BigInt(req.params.tripId), req.body, actorId(req)) });
    },

    async replaceDestination(req: Request<{ tripId: string }, {}, DestinationBody>, res: Response) {
        res.json({ data: await virtualService.replaceDestination(BigInt(req.params.tripId), req.body, actorId(req)) });
    },

    async previewRestriction(req: Request<{ scenarioId: string }, {}, RestrictionBody>, res: Response) {
        res.json({ data: await virtualService.previewRestriction(BigInt(req.params.scenarioId), req.body) });
    },

    async createRestriction(req: Request<{ scenarioId: string }, {}, RestrictionBody>, res: Response) {
        res.status(201).json({ data: await virtualService.createRestriction(BigInt(req.params.scenarioId), req.body, actorId(req)) });
    },

    async updateRestriction(req: Request<{ restrictionId: string }, {}, RestrictionUpdateBody>, res: Response) {
        res.json({ data: await virtualService.updateRestriction(BigInt(req.params.restrictionId), req.body, actorId(req)) });
    },

    async listEvents(req: Request<{ scenarioId: string }>, res: Response) {
        const after = typeof req.query.after === "string" && /^\d+$/.test(req.query.after) ? BigInt(req.query.after) : undefined;
        res.json({ data: await virtualService.listEvents(BigInt(req.params.scenarioId), after) });
    },
};
