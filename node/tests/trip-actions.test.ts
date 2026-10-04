import { describe, expect, it, vi } from "vitest";
import { deleteTripWithRecordings, tripAction } from "../../operator-web/trip-actions.js";

describe("trip row actions", () => {
    it("offers cancellation for active trips and deletion only for terminal trips", () => {
        for (const role of ["ADMIN", "OPERATOR"]) {
            for (const status of ["READY", "IN_PROGRESS", "PAUSED"]) expect(tripAction(status,role)).toBe("cancel");
            for (const status of ["COMPLETED", "CANCELLED"]) expect(tripAction(status,role)).toBe("delete");
        }
        expect(tripAction("COMPLETED", "VIEWER")).toBeNull();expect(tripAction("COMPLETED", "")).toBeNull();
    });
    it("shows the trip ID and recording count before doing any destructive action", async () => {
        const api = vi.fn().mockResolvedValue([{tripVideoId:"11"}]),confirm=vi.fn(()=>false),beforeDelete=vi.fn();
        expect(await deleteTripWithRecordings(api,"7",confirm,beforeDelete)).toBe(false);
        expect(confirm.mock.calls[0][0]).toContain("운행 7");expect(confirm.mock.calls[0][0]).toContain("녹화 1개");
        expect(api).toHaveBeenCalledOnce();expect(beforeDelete).not.toHaveBeenCalled();
    });
    it("clears confirmed recordings before removing the trip entry", async () => {
        const api=vi.fn().mockResolvedValueOnce([{tripVideoId:"11"}]).mockResolvedValueOnce({deletedTripVideoIds:["11"],failures:[]}).mockResolvedValueOnce({tripId:"7",deleted:true});
        expect(await deleteTripWithRecordings(api,"7",()=>true)).toBe(true);
        expect(api.mock.calls.map(call=>call[0])).toEqual(["/api/v1/trips/7/videos","/api/v1/trips/7/videos","/api/v1/trips/7"]);
        expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({tripVideoIds:["11"]});
        expect(api.mock.calls[2][1].method).toBe("DELETE");
    });
    it("retains the trip after partial recording deletion failure", async () => {
        const api=vi.fn().mockResolvedValueOnce([{tripVideoId:"11"}]).mockResolvedValueOnce({deletedTripVideoIds:[],failures:[{tripVideoId:"11",message:"Storage unavailable"}]});
        await expect(deleteTripWithRecordings(api,"7",()=>true)).rejects.toThrow("운행 항목은 유지됩니다");
        expect(api).toHaveBeenCalledTimes(2);
    });
    it("removes an empty trip directly after confirmation", async () => {
        const api=vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce({tripId:"7",deleted:true});
        expect(await deleteTripWithRecordings(api,"7",()=>true)).toBe(true);
        expect(api.mock.calls[1][0]).toBe("/api/v1/trips/7");
    });
});
