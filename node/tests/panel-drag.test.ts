import { describe, expect, it } from "vitest";

import { clampPanelPosition } from "../../operator-web/panel-drag.js";

const bounds = { width: 1000, height: 600 };
const panel = { width: 540, height: 400 };

describe("live preview drag bounds", () => {
    it("keeps a position that already fits", () => {
        expect(clampPanelPosition({ left: 100, top: 50 }, panel, bounds)).toEqual({ left: 100, top: 50 });
    });

    it("never lets the panel leave the map on any side", () => {
        expect(clampPanelPosition({ left: -40, top: -10 }, panel, bounds)).toEqual({ left: 0, top: 0 });
        expect(clampPanelPosition({ left: 900, top: 500 }, panel, bounds)).toEqual({ left: 460, top: 200 });
    });

    it("pins a panel larger than the map to its top-left corner", () => {
        expect(clampPanelPosition({ left: 30, top: 30 }, { width: 1200, height: 700 }, bounds)).toEqual({ left: 0, top: 0 });
    });
});
