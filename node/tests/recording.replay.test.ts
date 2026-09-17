import { describe, expect, it } from "vitest";

import { detectionCoverageIncomplete } from "../src/modules/recording/recording.replay.ts";

describe("replay detection coverage", () => {
    it("marks missing samples and gaps larger than the 2 Hz tolerance", () => {
        expect(detectionCoverageIncomplete(0n, 135_000n, [])).toBe(true);
        expect(detectionCoverageIncomplete(0n, 135_000n, [45_000n])).toBe(true);
    });

    it("accepts samples that cover the segment edges and cadence", () => {
        expect(detectionCoverageIncomplete(0n, 135_000n, [45_000n, 90_000n])).toBe(false);
        expect(detectionCoverageIncomplete(0n, 135_000n, [67_500n])).toBe(false);
    });
});
