import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve("../services/vision/index.html"), "utf8");
const controls = html.slice(html.indexOf("  let serverMode ="), html.indexOf("  function openSocket()"));

function viewer() {
    const elements = new Map<string, any>();
    const sent: any[] = [];
    const context = vm.createContext({
        document: { getElementById(id: string) {
            if (!elements.has(id)) elements.set(id, { value: "0", setAttribute() {} });
            return elements.get(id);
        } },
        stopped: false, awaitingLiveEpoch: false, lastPresentedSeq: 2,
        foregroundResumePending: false,
        playing: true, send: (message: any) => sent.push(message),
        resetPlayback() { context.awaitingLiveEpoch = true; },
        setLoading() {}, setStatus() {}, clearForegroundResumeTimer() {},
    });
    vm.runInContext(controls, context);
    return { context, sent, elements, run: (code: string) => vm.runInContext(code, context) };
}

describe("server inference timeline", () => {
    it("waits for the last presented frame before looping", () => {
        const page = viewer();
        page.run('updateSource({mode:"server", ready:true, duration:10, loop:[2,4], end_seq:3})');
        expect(page.sent).toEqual([]);
        page.context.lastPresentedSeq = 3;
        page.run("finishServerPlayback()");
        expect(page.sent).toEqual([{ type: "seek", position: 2 }]);
        page.run("finishServerPlayback()");
        expect(page.sent).toHaveLength(1);
    });

    it("seeks backwards and clears looping at the presented position", () => {
        const page = viewer();
        page.run('updateSource({mode:"server", ready:true, duration:20}); videoPosition=15');
        page.elements.get("seek-back").onclick();
        expect(page.sent[0]).toEqual({ type: "seek", position: 5 });
        page.context.awaitingLiveEpoch = false;
        page.elements.get("clear-loop").onclick();
        expect(page.sent[1]).toEqual({ type: "clear_loop", position: 15 });
    });

    it("does not repeatedly seek an interval containing no frames", () => {
        const page = viewer();
        page.run('updateSource({mode:"server", ready:true, duration:10, loop:[0.01,0.02], end_seq:-1})');
        expect(page.sent).toEqual([]);
        expect(page.context.playing).toBe(false);
    });
});
