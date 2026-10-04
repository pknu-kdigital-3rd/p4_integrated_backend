import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { STATUS_LABELS, vehicleStatus, vehicleDisplayName } from "../../operator-web/dashboard-ui.js";
const source = readFileSync(new URL("../../operator-web/app.js", import.meta.url), "utf8");
const picker = source.slice(source.indexOf("async function loadTripAssignments(){"), source.indexOf("  syncTripRouteMode();", source.indexOf("async function loadTripAssignments(){"))) + "}";
async function render(trips: unknown[]) {
    const vehicle = { vehicleId: "2", vehicleStatus: "READY", isActive: true };
    const options: {text: string, value: string}[] = [];
    const select = { value: "2", replaceChildren: (option: any) => { options.splice(0, options.length, option); }, add: (option: any) => options.push(option) };
    const context = { STATUS_LABELS, vehicleStatus, vehicleDisplayName, currentRole: "OPERATOR", tripListSignature: "", activeTripByVehicle: new Map(),
        api: async (path: string) => path.includes("vehicles") ? [vehicle] : trips,
        uiText: (text: string) => text, document: { querySelector: () => select },
        Option: class { constructor(public text: string, public value: string) {} } };
    await runInNewContext(`${picker}\nloadTripAssignments()`, context);
    return { vehicle, options, context };
}
describe("assignment vehicle state", () => {
    it("shows the same running state as the fleet while the stored vehicle is READY", async () => {
        const trip = { tripId: "10", vehicleId: "2", tripStatus: "IN_PROGRESS" };
        const { vehicle, options, context } = await render([trip]);
        expect(options[1].text).toContain(STATUS_LABELS[vehicleStatus({ ...vehicle, tripStatus: trip.tripStatus })]);
        expect(options[1].text).toContain("운행중");
        expect(context.activeTripByVehicle.get("2")).toBe("10");
        expect(vehicle.vehicleStatus).toBe("READY");
    });
    it.each(["COMPLETED", "CANCELLED"])("returns to the stored state after %s", async tripStatus => {
        const { options, context } = await render([{ tripId: "10", vehicleId: "2", tripStatus }]);
        expect(options[1].text).toContain("대기");
        expect(context.activeTripByVehicle.size).toBe(0);
    });
    it("uses the newest active assignment instead of an older running trip", async () => {
        const { options, context } = await render([
            { tripId: "11", vehicleId: "2", tripStatus: "READY" },
            { tripId: "10", vehicleId: "2", tripStatus: "IN_PROGRESS" },
        ]);
        expect(options[1].text).toContain("대기");
        expect(context.activeTripByVehicle.get("2")).toBe("11");
    });
});
