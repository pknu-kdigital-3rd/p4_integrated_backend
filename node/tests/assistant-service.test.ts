import { describe, expect, it } from "vitest";

import { assistantChatSchema } from "../src/modules/assistant/assistant.schema.ts";
import {
    REPORT_QUESTION,
    createAssistantService,
    type AssistantUpstreamRequest,
} from "../src/modules/assistant/assistant.service.ts";
import { ALL_SECTIONS, type FleetSnapshot } from "../src/modules/fleet/fleet.snapshot.ts";
import { fleetContext } from "../src/modules/assistant/assistant.context.ts";

const SNAPSHOT: FleetSnapshot = {
    generatedAt: "2026-10-02T01:00:00.000Z",
    realVehicles: { total: 2, bySource: { CUSTOM: 2 }, byStatus: { DRIVING: 2 }, reporting: 2, stale: 0, noPosition: 0, activeTrips: 1, notable: [], reportingVehicles: [] },
    virtual: { scenarios: [{ scenarioId: "7", name: "도심 통제", vehicles: 1, byStatus: { NO_ROUTE: 1 }, restrictions: { blocked: 1, penalty: 0 }, recentEvents: {}, problemVehicles: [{ vehicleCode: "V-2", simStatus: "NO_ROUTE", blockedReason: null }] }] },
    vision: { windowMinutes: 30, detections: 0, byRisk: {}, topClasses: [], unconfirmedAlerts: 0, recentAlerts: [] },
};

function serviceWithRecorder() {
    const requests: AssistantUpstreamRequest[] = [];
    const service = createAssistantService({
        context: async () => fleetContext(SNAPSHOT, ALL_SECTIONS, "전체 현황"),
        ask: async (request) => {
            requests.push(request);
            return { answer: "평가 [S1]", model: "EXAONE4.5", sources: [{ rank: 1, doc_id: "G-10-2023" }], retrieval_ms: 12, generation_ms: 900, retrieval_error: null };
        },
    });
    return { service, requests };
}

describe("assistant service", () => {
    it("answers a question with the fleet snapshot as live context", async () => {
        const { service, requests } = serviceWithRecorder();
        const result = await service.chat({ mode: "qa", question: "정지한 차량은?" });
        expect(requests[0]).toMatchObject({ question: "정지한 차량은?", mode: "qa", top_k: 5 });
        expect(requests[0]!.live_context).toContain("V-2 NO_ROUTE");
        expect(requests[0]!.retrieval_query).toBeUndefined();
        expect(result.answer).toBe("평가 [S1]");
        expect(result.sources[0]!.doc_id).toBe("G-10-2023");
        expect(result.snapshotAt).toBe(SNAPSHOT.generatedAt);
    });

    it("prepends data-rendered figures to the report and steers retrieval", async () => {
        const { service, requests } = serviceWithRecorder();
        const result = await service.chat({ mode: "report" });
        expect(requests[0]!.question).toBe(REPORT_QUESTION);
        expect(requests[0]!.retrieval_query).toContain("도로 통제");
        expect(result.answer.startsWith("## 차량 현황 보고서")).toBe(true);
        expect(result.answer).toContain("| 활성 차량 | 2대 |");
        expect(result.answer).toContain("### 평가 및 권고\n평가 [S1]");
    });

    it("is a 503 when the assistant is not configured", async () => {
        const service = createAssistantService({ context: async () => fleetContext(SNAPSHOT, ALL_SECTIONS, "전체 현황") });
        await expect(service.chat({ mode: "qa", question: "q" })).rejects.toMatchObject({ statusCode: 503, code: "ASSISTANT_DISABLED" });
    });

    it("requires a question in qa mode only", () => {
        expect(assistantChatSchema.safeParse({ mode: "qa" }).success).toBe(false);
        expect(assistantChatSchema.safeParse({ mode: "report" }).success).toBe(true);
        expect(assistantChatSchema.safeParse({ question: "현황?" }).data).toEqual({ mode: "qa", question: "현황?" });
    });
});
