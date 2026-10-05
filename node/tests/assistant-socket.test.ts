import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import {
    ASSISTANT_SOCKET_PATH,
    CLOSE_FORBIDDEN,
    CLOSE_UNAUTHORIZED,
    attachAssistantSocket,
    type AssistantSocketDeps,
} from "../src/modules/assistant/assistant.socket.ts";
import { createAssistantService, type AssistantUpstreamEvent } from "../src/modules/assistant/assistant.service.ts";
import { ALL_SECTIONS, type FleetSnapshot } from "../src/modules/fleet/fleet.snapshot.ts";
import { fleetContext } from "../src/modules/assistant/assistant.context.ts";

const SNAPSHOT: FleetSnapshot = {
    generatedAt: "2026-10-02T01:00:00.000Z",
    realVehicles: { total: 1, bySource: { CUSTOM: 1 }, byStatus: { DRIVING: 1 }, reporting: 1, stale: 0, noPosition: 0, activeTrips: 0, notable: [], reportingVehicles: [] },
    virtual: { scenarios: [] },
    vision: { windowMinutes: 30, detections: 0, byRisk: {}, topClasses: [], unconfirmedAlerts: 0, recentAlerts: [] },
};

let server: Server | undefined;
let closeSocket: (() => void) | undefined;

afterEach(async () => {
    closeSocket?.();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
});

async function start(deps: AssistantSocketDeps): Promise<string> {
    server = createServer();
    closeSocket = attachAssistantSocket(server, deps).close;
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `ws://127.0.0.1:${(server!.address() as AddressInfo).port}${ASSISTANT_SOCKET_PATH}`;
}

function connect(url: string) {
    const socket = new WebSocket(url);
    const messages: Array<Record<string, unknown>> = [];
    const waiters: Array<() => void> = [];
    socket.on("message", (data) => { messages.push(JSON.parse(data.toString())); waiters.splice(0).forEach((wake) => wake()); });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    const opened = new Promise<void>((resolve) => socket.on("open", () => resolve()));
    async function until(predicate: (message: Record<string, unknown>) => boolean) {
        for (;;) {
            const found = messages.find(predicate);
            if (found) return found;
            await new Promise<void>((resolve) => waiters.push(resolve));
        }
    }
    return { socket, messages, closed, opened, until, send: (value: unknown) => socket.send(JSON.stringify(value)) };
}

function serviceWithUpstream(stream: (signal: AbortSignal) => AsyncIterable<AssistantUpstreamEvent>) {
    return createAssistantService({ context: async () => fleetContext(SNAPSHOT, ALL_SECTIONS, "전체 현황"), stream: (_request, signal) => stream(signal) });
}

const verifyOperator = async () => ({ role: "OPERATOR" });

describe("assistant websocket", () => {
    it("requires authentication first", async () => {
        const url = await start({ verify: verifyOperator, streamChat: async function* () {} });
        const client = connect(url);
        await client.opened;
        client.send({ type: "ask", requestId: "r1", mode: "qa", question: "q" });
        expect((await client.closed).code).toBe(CLOSE_UNAUTHORIZED);
    });

    it("rejects invalid tokens and roles", async () => {
        const url = await start({ verify: async (token) => { if (token === "bad") throw new Error("bad"); return { role: "DRIVER" }; }, streamChat: async function* () {} });
        const bad = connect(url);
        await bad.opened;
        bad.send({ type: "auth", token: "bad" });
        expect((await bad.closed).code).toBe(CLOSE_UNAUTHORIZED);
        const driver = connect(url);
        await driver.opened;
        driver.send({ type: "auth", token: "driver" });
        expect((await driver.closed).code).toBe(CLOSE_FORBIDDEN);
    });

    it("passes the operator's selection scope to the answer", async () => {
        const bodies: unknown[] = [];
        const url = await start({
            verify: verifyOperator,
            streamChat: async function* (body) { bodies.push(body); yield { type: "done", model: "m", timingsMs: { retrieval: 0, generation: 0 } }; },
        });
        const client = connect(url);
        await client.opened;
        client.send({ type: "auth", token: "t" });
        await client.until((message) => message.type === "ready");
        client.send({ type: "ask", requestId: "r1", mode: "qa", question: "이 차량 속도는?", scope: { view: "virtual", scenarioId: "7", vehicleId: "9" } });
        await client.until((message) => message.type === "done");
        expect(bodies).toEqual([{ mode: "qa", question: "이 차량 속도는?", scope: { view: "virtual", scenarioId: "7", vehicleId: "9" } }]);
        client.send({ type: "ask", requestId: "r2", mode: "qa", question: "q", scope: { view: "monitoring", vehicleId: "x" } });
        expect(await client.until((message) => message.requestId === "r2")).toMatchObject({ type: "error", code: "VALIDATION_ERROR" });
    });

    it("streams start, meta, deltas and done for a question", async () => {
        const service = serviceWithUpstream(async function* () {
            yield { type: "meta", sources: [{ rank: 1, doc_id: "G-10-2023" }], model: "EXAONE4.5", retrieval_ms: 12, retrieval_error: null };
            yield { type: "delta", text: "통로를 " };
            yield { type: "delta", text: "분리합니다 [S1]." };
            yield { type: "done", generation_ms: 900 };
        });
        const url = await start({ verify: verifyOperator, streamChat: (body, signal) => service.streamChat(body, signal) });
        const client = connect(url);
        await client.opened;
        client.send({ type: "auth", token: "t" });
        await client.until((message) => message.type === "ready");
        client.send({ type: "ask", requestId: "r1", mode: "qa", question: "통로?" });
        const done = await client.until((message) => message.type === "done");
        expect(done).toMatchObject({ requestId: "r1", model: "EXAONE4.5", timingsMs: { retrieval: 12, generation: 900 } });
        const events = client.messages.filter((message) => message.requestId === "r1");
        expect(events.map((message) => message.type)).toEqual(["start", "meta", "delta", "delta", "done"]);
        expect(events.filter((message) => message.type === "delta").map((message) => message.text).join("")).toBe("통로를 분리합니다 [S1].");
        expect(events[0]).toMatchObject({ mode: "qa", snapshotAt: SNAPSHOT.generatedAt });
    });

    it("sends the report figures before the streamed assessment", async () => {
        const service = serviceWithUpstream(async function* () {
            yield { type: "meta", sources: [], model: "EXAONE4.5", retrieval_ms: 1, retrieval_error: null };
            yield { type: "delta", text: "평가" };
            yield { type: "done", generation_ms: 1 };
        });
        const url = await start({ verify: verifyOperator, streamChat: (body, signal) => service.streamChat(body, signal) });
        const client = connect(url);
        await client.opened;
        client.send({ type: "auth", token: "t" });
        await client.until((message) => message.type === "ready");
        client.send({ type: "ask", requestId: "r2", mode: "report" });
        await client.until((message) => message.type === "done");
        const deltas = client.messages.filter((message) => message.type === "delta").map((message) => String(message.text));
        expect(deltas[0]).toContain("## 차량 현황 보고서");
        expect(deltas[0]).toContain("### 평가");
        expect(deltas[1]).toBe("평가");
    });

    it("closing the socket aborts the in-flight answer", async () => {
        let aborted!: () => void;
        const abortSeen = new Promise<void>((resolve) => { aborted = resolve; });
        const service = serviceWithUpstream(async function* (signal) {
            signal.addEventListener("abort", () => aborted());
            yield { type: "meta", sources: [], model: "EXAONE4.5", retrieval_ms: 1, retrieval_error: null };
            yield { type: "delta", text: "생성 중" };
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        });
        const url = await start({ verify: verifyOperator, streamChat: (body, signal) => service.streamChat(body, signal) });
        const client = connect(url);
        await client.opened;
        client.send({ type: "auth", token: "t" });
        await client.until((message) => message.type === "ready");
        client.send({ type: "ask", requestId: "r3", mode: "qa", question: "q" });
        await client.until((message) => message.type === "delta");
        client.socket.close(1000, "aborted by operator");
        await abortSeen;
    });

    it("allows one answer at a time and validates requests", async () => {
        const url = await start({
            verify: verifyOperator,
            streamChat: async function* (_body, signal) {
                yield { type: "start", mode: "qa", question: "q", snapshotAt: SNAPSHOT.generatedAt };
                await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
            },
        });
        const client = connect(url);
        await client.opened;
        client.send({ type: "auth", token: "t" });
        await client.until((message) => message.type === "ready");
        client.send({ type: "ask", requestId: "a", mode: "qa", question: "q" });
        await client.until((message) => message.type === "start");
        client.send({ type: "ask", requestId: "b", mode: "qa", question: "q2" });
        expect(await client.until((message) => message.requestId === "b")).toMatchObject({ type: "error", code: "ASSISTANT_BUSY" });
        client.send({ type: "ask", requestId: "c", mode: "qa" });
        expect(await client.until((message) => message.requestId === "c")).toMatchObject({ type: "error", code: "VALIDATION_ERROR" });
    });
});
