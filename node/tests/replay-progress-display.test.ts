import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { routeDisplayFromPosition, routeProgressAtPosition } from "../../operator-web/trip-route-ui.js";
const source = readFileSync(new URL("../../operator-web/app.js", import.meta.url), "utf8");
const draw = source.slice(source.indexOf("function drawReplayRouteAt("), source.indexOf("// Moves the shown position"));
describe("replay progress follows the displayed road position", () => {
    it("uses road distance, interpolates, and clamps at either endpoint", () => {
        const distances = [0, 100, 500];
        expect(routeProgressAtPosition(distances, 1.5)).toEqual({ percent: 60, remainingM: 200 });
        expect(routeProgressAtPosition(distances, -1)).toEqual({ percent: 0, remainingM: 500 });
        expect(routeProgressAtPosition(distances, 10)).toEqual({ percent: 100, remainingM: 0 });
        expect(routeProgressAtPosition(distances, NaN)).toBeNull();
    });
    it("updates marker, remaining distance and progress together after zoom finishes", () => {
        let deferred: () => void = () => {};
        const track = { style: { setProperty: vi.fn() }, classList: { remove: vi.fn() } };
        const progress = { textContent: "" }, current = { textContent: "" };
        const layer = { setLatLngs: vi.fn() }, marker = { setLatLng: vi.fn() };
        const context = { routeDisplayFromPosition, routeProgressAtPosition,
            currentRouteCoordinates: [[129, 35], [129.1, 35.1], [129.2, 35.2]], currentRouteBreaks: [],
            currentRouteTiming: { distances: [0, 100, 500] }, shownRoutePosition: 0,
            drawWhenNotZooming: (_layer: unknown, callback: () => void) => { deferred = callback; }, cancelGlide: vi.fn(),
            document: { querySelector: (selector: string) => selector === "#trip-track" ? track : selector === "#selected-current" ? current : progress } };
        runInNewContext(`${draw}\nglobalThis.draw=drawReplayRouteAt`, context);
        (context as any).draw(layer, marker, 1.5);
        expect(marker.setLatLng).not.toHaveBeenCalled();
        expect(context.shownRoutePosition).toBe(0);
        expect(track.style.setProperty).not.toHaveBeenCalled();
        deferred();
        expect(context.shownRoutePosition).toBe(1.5);
        expect(track.style.setProperty).toHaveBeenCalledWith("--trip-progress", "60%");
        expect(progress.textContent).toBe("남은 경로: 0.2 km");
        expect(marker.setLatLng.mock.calls[0][0][0]).toBeCloseTo(35.15);
        expect(marker.setLatLng.mock.calls[0][0][1]).toBeCloseTo(129.15);
        (context as any).draw(layer, marker, 2); deferred();
        expect(track.style.setProperty).toHaveBeenLastCalledWith("--trip-progress", "100%");
        expect(progress.textContent).toBe("남은 경로: 0.0 km");
    });
});
