import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    scenario: { findUnique: vi.fn(), updateMany: vi.fn() },
    restriction: { findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    state: { findMany: vi.fn() }, event: { create: vi.fn() }, transaction: vi.fn(),
    resolve: vi.fn(), brush: vi.fn(),
}));
vi.mock("../src/infrastructure/database/prisma.ts", () => ({ prisma: {
    virtualScenario: mocks.scenario, virtualRoadRestriction: mocks.restriction,
    virtualVehicleState: mocks.state, virtualOperatorEvent: mocks.event, $transaction: mocks.transaction,
} }));
vi.mock("../src/modules/virtual/routing-internal.client.ts", () => ({ routingInternalClient: { resolveRestriction: mocks.resolve, brushRestriction: mocks.brush } }));

import { virtualService } from "../src/modules/virtual/virtual.service.ts";
import { restrictionRestoreSchema } from "../src/modules/virtual/virtual.schema.ts";

const full = { type: "Polygon" as const, coordinates: [[[129, 35], [129.01, 35], [129.01, 35.01], [129, 35]]] };
const cut = { type: "Polygon" as const, coordinates: [[[129, 35], [129.005, 35], [129.005, 35.01], [129, 35]]] };
let revision: number;
let rows: Map<bigint, any>;
const snapshot = (restrictionId: string, isActive: boolean, geometry = full) => ({ restrictionId, isActive, geometry });

beforeEach(() => {
    for (const group of [mocks.scenario, mocks.restriction, mocks.state, mocks.event]) for (const fn of Object.values(group)) fn.mockReset();
    mocks.transaction.mockReset(); mocks.resolve.mockReset(); mocks.brush.mockReset();
    revision = 0; rows = new Map();
    mocks.scenario.findUnique.mockImplementation(async () => ({ scenarioId: 7n, restrictionRevision: revision }));
    mocks.scenario.updateMany.mockImplementation(async ({ where, data }) => {
        if (where.restrictionRevision !== revision) return { count: 0 };
        revision = data.restrictionRevision; return { count: 1 };
    });
    mocks.restriction.findMany.mockImplementation(async ({ where }) => [...rows.values()].filter(row => row.scenarioId === where.scenarioId
        && (where.isActive === undefined || row.isActive === where.isActive)
        && (!where.kind || row.kind === where.kind)
        && (!where.restrictionId || where.restrictionId.in.includes(row.restrictionId))));
    mocks.restriction.create.mockImplementation(async ({ data }) => {
        const row = { ...data, restrictionId: BigInt(rows.size + 1) }; rows.set(row.restrictionId, row); return row;
    });
    mocks.restriction.update.mockImplementation(async ({ where, data }) => {
        const row = { ...rows.get(where.restrictionId), ...data }; rows.set(where.restrictionId, row); return row;
    });
    mocks.state.findMany.mockResolvedValue([]); mocks.event.create.mockResolvedValue({});
    mocks.resolve.mockResolvedValue({ affectedDirectedEdgeIds: ["25:5:9:0"], affectedPhysicalSegmentIds: ["segment"], graphVersion: "graph" });
    mocks.transaction.mockImplementation(async callback => {
        const savedRows = new Map(rows), savedRevision = revision;
        try { return await callback({ virtualScenario: mocks.scenario, virtualRoadRestriction: mocks.restriction, virtualOperatorEvent: mocks.event }); }
        catch (error) { rows = savedRows; revision = savedRevision; throw error; }
    });
    vi.spyOn(virtualService, "refreshFollowingTrips").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("brush undo and redo", () => {
    it("records a paint stroke and restores it in both directions", async () => {
        mocks.brush.mockResolvedValue({ geometry: full });
        const result = await virtualService.brushRestriction(7n, { mode: "paint", points: [{ lat: 35, lon: 129 }], radiusM: 20, expectedRestrictionRevision: 0 });
        expect(result.history).toEqual({ before: [snapshot("1", false)], after: [snapshot("1", true)] });
        await virtualService.restoreRestrictions(7n, { states: [snapshot("1", false)], expectedRestrictionRevision: 1 });
        expect(rows.get(1n).isActive).toBe(false);
        expect(virtualService.refreshFollowingTrips).toHaveBeenLastCalledWith(7n, expect.objectContaining({ recoverStoppedTrips: true, preserveMotionOnFailure: true }));
        await virtualService.restoreRestrictions(7n, { states: [snapshot("1", true)], expectedRestrictionRevision: 2 });
        expect(rows.get(1n).isActive).toBe(true);
        expect(revision).toBe(3);
        expect(mocks.resolve).toHaveBeenCalledWith({ geometry: full });
    });

    it("undoes and redoes a partial erase plus a fully erased shape atomically", async () => {
        for (const restrictionId of [1n, 2n]) rows.set(restrictionId, { restrictionId, scenarioId: 7n, kind: "BLOCKED", isActive: true, geometry: full, affectedDirectedEdgeIds: ["25:5:9:0"] });
        mocks.brush.mockResolvedValue({ changes: [{ restrictionId: "1", geometry: cut }, { restrictionId: "2", geometry: null }] });
        const result = await virtualService.brushRestriction(7n, { mode: "erase", points: [{ lat: 35, lon: 129 }], radiusM: 20, expectedRestrictionRevision: 0 });
        expect(result.history!.before).toEqual([snapshot("1", true), snapshot("2", true)]);
        expect(result.history!.after).toEqual([snapshot("1", true, cut), snapshot("2", false)]);
        await virtualService.restoreRestrictions(7n, { states: result.history!.before as any, expectedRestrictionRevision: 1 });
        expect(rows.get(1n).geometry).toEqual(full); expect(rows.get(2n).isActive).toBe(true);
        await virtualService.restoreRestrictions(7n, { states: result.history!.after as any, expectedRestrictionRevision: 2 });
        expect(rows.get(1n).geometry).toEqual(cut); expect(rows.get(2n).isActive).toBe(false);
    });

    it("rejects stale history and restrictions from other scenarios without writing", async () => {
        await expect(virtualService.restoreRestrictions(7n, { states: [snapshot("1", false)], expectedRestrictionRevision: 1 })).rejects.toMatchObject({ code: "STALE_REVISION" });
        rows.set(1n, { restrictionId: 1n, scenarioId: 8n, kind: "BLOCKED" });
        await expect(virtualService.restoreRestrictions(7n, { states: [snapshot("1", false)], expectedRestrictionRevision: 0 })).rejects.toMatchObject({ code: "RESTRICTION_NOT_FOUND" });
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("refuses to reactivate a blockage on an occupied road", async () => {
        rows.set(1n, { restrictionId: 1n, scenarioId: 7n, kind: "BLOCKED", isActive: false, geometry: full });
        mocks.state.findMany.mockResolvedValue([{ vehicleId: 9n, currentEdgeId: "25:9:5:0" }]);
        await expect(virtualService.restoreRestrictions(7n, { states: [snapshot("1", true)], expectedRestrictionRevision: 0 })).rejects.toMatchObject({ code: "ROAD_OCCUPIED" });
        expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("rolls back all shapes and the revision when any restore write fails", async () => {
        for (const restrictionId of [1n, 2n]) rows.set(restrictionId, { restrictionId, scenarioId: 7n, kind: "BLOCKED", isActive: true, geometry: full });
        mocks.restriction.update.mockImplementation(async ({ where, data }) => {
            if (where.restrictionId === 2n) throw new Error("write failed");
            const row = { ...rows.get(where.restrictionId), ...data }; rows.set(where.restrictionId, row); return row;
        });
        await expect(virtualService.restoreRestrictions(7n, { states: [snapshot("1", false), snapshot("2", false)], expectedRestrictionRevision: 0 })).rejects.toThrow("write failed");
        expect(rows.get(1n).isActive).toBe(true); expect(revision).toBe(0);
        expect(virtualService.refreshFollowingTrips).not.toHaveBeenCalled();
    });

    it("checks the revision again inside the transaction", async () => {
        rows.set(1n, { restrictionId: 1n, scenarioId: 7n, kind: "BLOCKED", isActive: false, geometry: full });
        mocks.scenario.updateMany.mockResolvedValue({ count: 0 });
        await expect(virtualService.restoreRestrictions(7n, { states: [snapshot("1", true)], expectedRestrictionRevision: 0 })).rejects.toMatchObject({ code: "STALE_REVISION" });
        expect(mocks.restriction.update).not.toHaveBeenCalled();
    });

    it("validates MultiPolygon snapshots and rejects duplicate ids", () => {
        expect(restrictionRestoreSchema.safeParse({ expectedRestrictionRevision: 0, states: [{ ...snapshot("1", true), geometry: { type: "MultiPolygon", coordinates: [full.coordinates] } }] }).success).toBe(true);
        expect(restrictionRestoreSchema.safeParse({ expectedRestrictionRevision: 0, states: [snapshot("1", true), snapshot("1", false)] }).success).toBe(false);
    });
});
