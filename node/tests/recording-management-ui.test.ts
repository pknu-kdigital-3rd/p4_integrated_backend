import { describe, expect, it, vi } from "vitest";
import { deleteRecordingSnapshot, recordingDuration, recordingSize, recordingStatus } from "../../operator-web/recording-management.js";

describe("recording library", () => {
    it("formats trip storage, long duration and mixed stored statuses", () => {
        expect(recordingDuration(3661)).toBe("1:01:01");
        expect(recordingSize("1073741824")).toBe("1.0 GB");
        expect(recordingStatus({ recordingStatuses: { FINALIZED: 10, FAILED: 2 } })).toBe("저장 완료 10 · 실패 2");
    });
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
