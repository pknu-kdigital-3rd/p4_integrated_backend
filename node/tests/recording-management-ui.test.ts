import { describe, expect, it, vi } from "vitest";
import { deleteRecordingSnapshot } from "../../operator-web/recording-delete.js";

describe("recording deletion", () => {
    it("batches an immutable segment snapshot without selecting later uploads", async () => {
        const videos = Array.from({ length: 51 }, (_, i) => ({ tripVideoId: String(i + 1) }));
        const api = vi.fn(async (_path, options) => {
            const ids = JSON.parse(options.body).tripVideoIds;
            // Simulate another segment arriving after confirmation.
            videos.push({ tripVideoId: "52" });
            return { deletedTripVideoIds: ids.filter(id => id !== "51"), failures: ids.includes("51") ? [{ tripVideoId: "51", message: "Storage down" }] : [] };
        });
        const result = await deleteRecordingSnapshot(api, "7", videos);
        expect(result.deletedTripVideoIds).toHaveLength(50);expect(result.failures).toHaveLength(1);
        expect(api).toHaveBeenCalledTimes(2);
        expect(JSON.parse(api.mock.calls[0][1].body).tripVideoIds).toHaveLength(50);
        expect(JSON.parse(api.mock.calls[1][1].body).tripVideoIds).toEqual(["51"]);
    });
    it("preserves successful batches when another request fails", async () => {
        const api = vi.fn().mockRejectedValueOnce(new Error("Network down")).mockResolvedValueOnce({ deletedTripVideoIds: ["51"], failures: [] });
        const result = await deleteRecordingSnapshot(api, "7", Array.from({ length: 51 }, (_, i) => ({ tripVideoId: String(i + 1) })));
        expect(result.deletedTripVideoIds).toEqual(["51"]);expect(result.failures).toHaveLength(50);
    });
});
