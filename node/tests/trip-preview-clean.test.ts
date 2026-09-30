import { describe, expect, it } from "vitest";
import { cleanReplayPreviewPoints } from "../src/modules/trip/trip-preview-clean.ts";

describe("recorded GPS preview cleanup", () => {
    it("removes the impossible tunnel detour in trip 11 while retaining the clock gap", () => {
        const seconds = (value: number) => String(value * 1_000_000_000);
        const points: Array<[string, number, number, number]> = [
            [seconds(0), 129.0964166, 35.1494257, 0],
            [seconds(10), 129.1024855, 35.1418144, 1010],
            [seconds(40), 129.1024855, 35.1418144, 1010],
            [seconds(80), 129.1024855, 35.1418144, 1010],
            [seconds(95), 129.1037991, 35.1584777, 2867],
        ];
        const cleaned = cleanReplayPreviewPoints(points);
        expect(cleaned.map(point => point[0])).toEqual([seconds(0), seconds(95)]);
        expect(cleaned[1]![3]).toBeGreaterThan(900);
        expect(cleaned[1]![3]).toBeLessThan(1300);
    });
});
