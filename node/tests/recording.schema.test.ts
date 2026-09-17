import { describe, expect, it } from "vitest";

import { replayDetectionBatchSchema } from "../src/modules/recording/recording.schema.ts";

describe("replay detection batch schema", () => {
    it("accepts normalized detections and empty frames", () => {
        const result = replayDetectionBatchSchema.safeParse({
            samples: [
                {
                    tripId: "12",
                    recordingSessionId: "session-a",
                    relayEpoch: "7",
                    frameSeq: "300",
                    videoPts90k: "90000",
                    detections: [{ class: "car", confidence: 0.9, bbox: [0.1, 0.2, 0.8, 0.9], trackId: 4 }],
                },
                {
                    tripId: "12",
                    recordingSessionId: "session-a",
                    relayEpoch: "7",
                    frameSeq: "330",
                    videoPts90k: "135000",
                    detections: [],
                },
            ],
        });
        expect(result.success).toBe(true);
    });

    it("rejects boxes outside the normalized image and inverted corners", () => {
        for (const bbox of [[-0.1, 0, 1, 1], [0.7, 0.1, 0.3, 0.8]]) {
            const result = replayDetectionBatchSchema.safeParse({
                samples: [{
                    tripId: "12",
                    recordingSessionId: "session-a",
                    relayEpoch: "7",
                    frameSeq: "300",
                    videoPts90k: "90000",
                    detections: [{ class: "car", confidence: 0.9, bbox }],
                }],
            });
            expect(result.success).toBe(false);
        }
    });
});
