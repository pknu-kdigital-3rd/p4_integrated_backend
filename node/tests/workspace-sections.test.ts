import { describe, expect, it } from "vitest";

import { createSectionVisibility } from "../operator-web/workspace-sections.js";

function section(hidden: boolean) {
    return { hidden };
}

describe("normal-monitoring section visibility across a virtual workspace visit", () => {
    it("restores each section to what it was, not to a recomputed default", () => {
        // The state the dashboard actually leaves behind: signed in (login
        // hidden), a vehicle selected (details shown), trip panel shown in
        // non-demo mode, recordings and the error line always present.
        const login = section(true);
        const details = section(false);
        const tripPanel = section(false);
        const recordings = section(false);
        const telemetrySettings = section(true);
        const sections = [login, details, tripPanel, recordings, telemetrySettings];
        const visibility = createSectionVisibility(sections);

        visibility.hide();
        expect(sections.map(item => item.hidden)).toEqual([true, true, true, true, true]);

        visibility.restore();
        expect(sections.map(item => item.hidden)).toEqual([true, false, false, false, true]);
    });

    it("keeps the first snapshot when the workspace is entered twice without leaving", () => {
        const details = section(false);
        const visibility = createSectionVisibility([details]);

        visibility.hide();
        visibility.hide();
        visibility.restore();

        expect(details.hidden).toBe(false);
    });

    it("leaves sections alone when restoring without a prior hide", () => {
        const details = section(true);
        const visibility = createSectionVisibility([details]);

        visibility.restore();

        expect(details.hidden).toBe(true);
    });

    it("survives a restore/hide cycle so repeated switching does not drift", () => {
        const login = section(true);
        const details = section(false);
        const visibility = createSectionVisibility([login, details]);

        for (let visit = 0; visit < 3; visit++) {
            visibility.hide();
            visibility.restore();
        }

        expect([login.hidden, details.hidden]).toEqual([true, false]);
    });
});
