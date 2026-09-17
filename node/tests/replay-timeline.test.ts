import { describe, expect, it } from "vitest";

import { buildReplayTimeline, detectionSampleAtPts, entryForTime, segmentDuration } from "../operator-web/replay-timeline.js";

function segment(overrides: Record<string, unknown> = {}) {
    return {
        tripVideoId: "1",
        recordingSessionId: "session-a",
        relayEpoch: "3",
        segmentIndex: 0,
        startSeq: "0",
        endSeq: "29",
        startPts90k: "0",
        endPts90k: "87000",
        durationPts90k: "90000",
        durationSec: 1,
        startedAt: "2026-09-17T00:00:00.000Z",
        endedAt: "2026-09-17T00:00:00.967Z",
        ...overrides,
    };
}

describe("trip replay virtual timeline", () => {
    it("uses exact 90 kHz duration and retains the old rounded-duration fallback", () => {
        expect(segmentDuration(segment({ durationPts90k: "135000", durationSec: 2 }))).toBe(1.5);
        expect(segmentDuration(segment({ durationPts90k: null, durationSec: 2 }))).toBe(2);
    });

    it("concatenates contiguous segments and marks epoch gaps", () => {
        const first = segment();
        const second = segment({
            tripVideoId: "2", segmentIndex: 1, startSeq: "30", endSeq: "59",
            startPts90k: "90000", endPts90k: "177000", startedAt: "2026-09-17T00:00:01.000Z",
        });
        const third = segment({
            tripVideoId: "3", segmentIndex: 2, startSeq: "0", endSeq: "29",
            relayEpoch: "4", startPts90k: "0", endPts90k: "87000",
            startedAt: "2026-09-17T00:00:10.000Z",
        });
        const timeline = buildReplayTimeline([first, second, third]);
        expect(timeline.duration).toBe(3);
        expect(timeline.entries.map(entry => entry.start)).toEqual([0, 1, 2]);
        expect(timeline.entries.map(entry => entry.breakBefore)).toEqual([false, false, true]);
    });

    it("maps global seek positions across boundaries and at the trip end", () => {
        const timeline = buildReplayTimeline([segment(), segment({
            tripVideoId: "2", segmentIndex: 1, startSeq: "30", endSeq: "59", startPts90k: "90000",
        })]);
        expect(entryForTime(timeline.entries, timeline.duration, 0.5)).toBe(0);
        expect(entryForTime(timeline.entries, timeline.duration, 1)).toBe(1);
        expect(entryForTime(timeline.entries, timeline.duration, 2)).toBe(1);
    });

    it("uses the latest detection no more than one second behind playback PTS", () => {
        const samples = [
            { videoPts90k: "90000", detections: [{ class: "car" }] },
            { videoPts90k: "135000", detections: [] },
        ];
        expect(detectionSampleAtPts(samples, 150000n)).toBe(samples[1]);
        expect(detectionSampleAtPts(samples, 230001n)).toBeNull();
    });
});
