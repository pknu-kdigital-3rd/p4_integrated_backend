import { Router } from "express";
import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { validateParams } from "../../common/middleware/validate-params.ts";
import { virtualController } from "./virtual.controller.ts";
import {
    commandSchema,
    createScenarioSchema,
    createVirtualVehicleSchema,
    dispatchRequestSchema,
    followingSchema,
    requestIdParamSchema,
    restrictionSchema,
    restrictionIdParamSchema,
    restrictionUpdateSchema,
    routePreviewSchema,
    scenarioIdParamSchema,
    virtualTripIdParamSchema,
    virtualVehicleIdParamSchema,
    waypointsSchema,
} from "./virtual.schema.ts";

export const virtualRouter = Router();
const read = [authenticate, requireRole("ADMIN", "OPERATOR", "VIEWER")];
const write = [authenticate, requireRole("ADMIN", "OPERATOR")];

virtualRouter.post("/scenarios", ...write, validateBody(createScenarioSchema), virtualController.createScenario);
virtualRouter.get("/scenarios", ...read, virtualController.listScenarios);
virtualRouter.get("/scenarios/:scenarioId", ...read, validateParams(scenarioIdParamSchema), virtualController.getScenario);
virtualRouter.get("/scenarios/:scenarioId/vehicles", ...read, validateParams(scenarioIdParamSchema), virtualController.listVehicles);
virtualRouter.post("/scenarios/:scenarioId/vehicles", ...write, validateParams(scenarioIdParamSchema), validateBody(createVirtualVehicleSchema), virtualController.createVehicle);
virtualRouter.post("/scenarios/:scenarioId/routes/preview", ...write, validateParams(scenarioIdParamSchema), validateBody(routePreviewSchema), virtualController.previewRoute);
virtualRouter.get("/scenarios/:scenarioId/dispatch-requests", ...read, validateParams(scenarioIdParamSchema), virtualController.listRequests);
virtualRouter.post("/scenarios/:scenarioId/dispatch-requests", ...write, validateParams(scenarioIdParamSchema), validateBody(dispatchRequestSchema), virtualController.createRequest);
virtualRouter.post("/dispatch-requests/:requestId/accept", ...write, validateParams(requestIdParamSchema), virtualController.acceptRequest);
virtualRouter.post("/dispatch-requests/:requestId/reject", ...write, validateParams(requestIdParamSchema), virtualController.rejectRequest);
virtualRouter.put("/vehicles/:vehicleId/following", ...write, validateParams(virtualVehicleIdParamSchema), validateBody(followingSchema), virtualController.setFollowing);
virtualRouter.get("/trips/:tripId", ...read, validateParams(virtualTripIdParamSchema), virtualController.getTrip);
virtualRouter.post("/trips/:tripId/commands", ...write, validateParams(virtualTripIdParamSchema), validateBody(commandSchema), virtualController.command);
virtualRouter.put("/trips/:tripId/waypoints", ...write, validateParams(virtualTripIdParamSchema), validateBody(waypointsSchema), virtualController.replaceWaypoints);
virtualRouter.post("/scenarios/:scenarioId/road-restrictions/preview", ...write, validateParams(scenarioIdParamSchema), validateBody(restrictionSchema), virtualController.previewRestriction);
virtualRouter.post("/scenarios/:scenarioId/road-restrictions", ...write, validateParams(scenarioIdParamSchema), validateBody(restrictionSchema), virtualController.createRestriction);
virtualRouter.patch("/road-restrictions/:restrictionId", ...write, validateParams(restrictionIdParamSchema), validateBody(restrictionUpdateSchema), virtualController.updateRestriction);
virtualRouter.get("/scenarios/:scenarioId/events", ...read, validateParams(scenarioIdParamSchema), virtualController.listEvents);
