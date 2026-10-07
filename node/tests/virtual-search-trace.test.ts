import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ draft: vi.fn(), scenario: vi.fn(), vehicle: vi.fn(),
    dispatched: vi.fn(), active: vi.fn(), restrictions: vi.fn(), version: vi.fn(), route: vi.fn() }));
vi.mock("../src/infrastructure/database/prisma.ts", () => ({ prisma: {
    virtualRouteDraft: { findUnique: mocks.draft }, virtualScenario: { findUnique: mocks.scenario },
    vehicle: { findUnique: mocks.vehicle }, virtualDispatchRequest: { findFirst: mocks.dispatched },
    virtualTrip: { findFirst: mocks.active }, virtualRoadRestriction: { findMany: mocks.restrictions },
} }));
vi.mock("../src/modules/virtual/routing-internal.client.ts", () => ({ routingInternalClient: {
    route: mocks.route, graphVersion: mocks.version,
} }));
import { virtualService } from "../src/modules/virtual/virtual.service.ts";
import { AppError } from "../src/common/errors/app-error.ts";
import { searchTraceSchema } from "../src/modules/virtual/virtual.schema.ts";
import express from "express";
import request from "supertest";
vi.mock("../src/common/auth/authenticate.ts", () => ({ authenticate(req: any, res: any, next: any) {
    const role = req.header("x-test-role");
    if (!role) { res.status(401).end(); return; }
    req.auth = { userId: "1", role }; next();
} }));
import { virtualRouter } from "../src/modules/virtual/virtual.router.ts";

function app() {
    const server = express(); server.use(express.json()); server.use("/virtual", virtualRouter);
    server.use((error: AppError, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ error: { code: error.code } }));
    return server;
}

const input = { draftId: "4", expectedRestrictionRevision: 2 };
beforeEach(() => {
    vi.resetAllMocks();
    mocks.draft.mockResolvedValue({ draftId: 4n, scenarioId: 1n, selectedVehicleId: 3n,
        expiresAt: new Date(Date.now() + 60000), restrictionRevision: 2, graphVersion: "g1",
        origin: { lat: 35, lon: 129 }, destination: { lat: 35.1, lon: 129.1 }, waypoints: [],
        requestedProfile: { vehicleProfile: "semi" } });
    mocks.scenario.mockResolvedValue({ restrictionRevision: 2 });
    mocks.vehicle.mockResolvedValue({ vehicleSource: "VIRTUAL", isActive: true, vehicleStatus: "READY" });
    mocks.dispatched.mockResolvedValue(null); mocks.active.mockResolvedValue(null);
    mocks.restrictions.mockResolvedValue([]); mocks.version.mockResolvedValue({ graphVersion: "g1" });
    mocks.route.mockResolvedValue({ graphVersion: "g1", searchTrace: { events: [], edges: {}, truncated: false } });
});

describe("on-demand virtual search trace", () => {
    it.each(["astar", "dijkstra", "greedy"] as const)("forwards %s for animation only", async algorithm => {
        await virtualService.searchTrace(1n, { ...input, algorithm });
        expect(mocks.route).toHaveBeenCalledWith(expect.objectContaining({ searchAlgorithm: algorithm,
            includeSearchTrace: true }), 60000, undefined);
    });
    it("rejects unknown algorithms at the API boundary", async () => {
        const response = await request(app()).post("/virtual/scenarios/1/routes/search-trace")
            .set("x-test-role", "OPERATOR").send({ ...input, algorithm: "unknown" });
        expect(response.status).toBe(400);
        expect(mocks.route).not.toHaveBeenCalled();
    });
    it("uses the saved draft profile and performs only reads", async () => {
        const result = await virtualService.searchTrace(1n, input);
        expect(result).toMatchObject({ draftId: "4", restrictionRevision: 2, searchTrace: {} });
        expect(mocks.route).toHaveBeenCalledWith(expect.objectContaining({
            includeSearchTrace: true, vehicleProfile: "semi", waypoints: [], searchAlgorithm: "astar",
        }), 60000, undefined);
        // The mock database intentionally exposes no create/update/upsert operations.
        expect(mocks.scenario).toHaveBeenCalledTimes(2);
    });
    it.each(["expired", "dispatched", "active", "wrong scenario", "graph", "revision"])("rejects %s drafts", async condition => {
        if (condition === "expired") mocks.draft.mockResolvedValue({ ...(await mocks.draft()), expiresAt: new Date(0) });
        if (condition === "dispatched") mocks.dispatched.mockResolvedValue({ requestId: 1n });
        if (condition === "active") mocks.active.mockResolvedValue({ virtualTripId: 1n });
        if (condition === "wrong scenario") mocks.draft.mockResolvedValue({ ...(await mocks.draft()), scenarioId: 5n });
        if (condition === "graph") mocks.version.mockResolvedValue({ graphVersion: "g2" });
        if (condition === "revision") mocks.scenario.mockResolvedValue({ restrictionRevision: 3 });
        await expect(virtualService.searchTrace(1n, input)).rejects.toMatchObject({ statusCode: 409 });
        expect(mocks.route).not.toHaveBeenCalled();
    });
    it("discards results when restrictions change during calculation", async () => {
        mocks.scenario.mockResolvedValueOnce({ restrictionRevision: 2 }).mockResolvedValue({ restrictionRevision: 3 });
        await expect(virtualService.searchTrace(1n, input)).rejects.toMatchObject({ code: "STALE_REVISION" });
    });
    it("preserves the partial trace on no-route errors", async () => {
        const error = new AppError(422, "No route", "ROUTE_NOT_FOUND", { searchTrace: { events: [{ kind: "expanded" }] } });
        mocks.route.mockRejectedValue(error);
        await expect(virtualService.searchTrace(1n, input)).rejects.toBe(error);
    });
    it("passes cancellation to routing and never exposes a cancelled result", async () => {
        const controller = new AbortController();
        mocks.route.mockImplementation(async () => { controller.abort(); return { graphVersion: "g1" }; });
        expect(await virtualService.searchTrace(1n, input, controller.signal)).toBeNull();
        expect(mocks.route.mock.calls[0][2]).toBe(controller.signal);
    });
    it("requires positive draft IDs and an explicit revision", () => {
        expect(searchTraceSchema.safeParse({ draftId: "0", expectedRestrictionRevision: 2 }).success).toBe(false);
        expect(searchTraceSchema.safeParse({ draftId: "4" }).success).toBe(false);
    });
    it("rejects unauthenticated and viewer requests before starting a search", async () => {
        const url = "/virtual/scenarios/1/routes/search-trace";
        expect((await request(app()).post(url).send(input)).status).toBe(401);
        expect((await request(app()).post(url).set("x-test-role", "VIEWER").send(input)).status).toBe(403);
        expect(mocks.route).not.toHaveBeenCalled();
    });
    it.each(["ADMIN", "OPERATOR"])("allows %s to retrieve the trace", async role => {
        const response = await request(app()).post("/virtual/scenarios/1/routes/search-trace").set("x-test-role", role).send(input);
        expect(response.status).toBe(200);
        expect(response.body.data.draftId).toBe("4");
    });
});
