import { describe, expect, it } from "vitest";

import { countDetections, describeDetections, DETECTION_STALE_MS } from "../../operator-web/detection-status.js";

describe("live detection status line", () => {
    it("groups cars, buses and trucks as 자동차 and lists every category", () => {
        expect(countDetections({ car: 2, bus: 1, truck: 1, person: 1, train: 3 })).toEqual({ 자동차: 4, 사람: 1, 오토바이: 0 });
        expect(describeDetections({ car: 3, person: 1 }, 1000, 1500)).toBe("객체 탐지 중 · 자동차 3 | 사람 1 | 오토바이 0");
    });

    it("shows zeros for an empty frame and ignores malformed counts", () => {
        expect(describeDetections({}, 1000, 1000)).toBe("객체 탐지 중 · 자동차 0 | 사람 0 | 오토바이 0");
        expect(countDetections({ car: -1, person: "x", motorcycle: 2 })).toEqual({ 자동차: 0, 사람: 0, 오토바이: 2 });
    });

    it("says it is waiting before any frame and when frames stop arriving", () => {
        expect(describeDetections(undefined, undefined, 0)).toBe("YOLO 객체 탐지 대기 중");
        expect(describeDetections({ car: 1 }, 0, DETECTION_STALE_MS + 1)).toBe("YOLO 객체 탐지 · 영상 수신 대기 중");
    });
});
