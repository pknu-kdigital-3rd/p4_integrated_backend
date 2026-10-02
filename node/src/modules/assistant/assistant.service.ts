// Operator assistant: current fleet snapshot + KOSHA transport-guide RAG.
//
// The p4-llm assistant API (services/llm, ASSISTANT_BASE_URL) owns retrieval and the LLM;
// this service supplies the fleet facts. In report mode the figures are
// rendered here from the snapshot and the LLM only adds the assessment and
// recommendations, so a report's numbers can never be invented.
import { AppError } from "../../common/errors/app-error.ts";
import { env } from "../../config/env.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import {
    collectFleetSnapshot,
    renderReportFigures,
    renderSnapshotText,
    reportRetrievalQuery,
    type FleetSnapshot,
} from "../fleet/fleet.snapshot.ts";
import type { AssistantChatBody } from "./assistant.schema.ts";

export const REPORT_QUESTION = "현재 차량 현황에 대한 보고서를 작성하세요.";

export type AssistantSource = {
    rank?: number;
    doc_id?: string;
    source_relpath?: string;
    heading_path?: string;
    page_start?: number;
    page_end?: number;
};

export type AssistantUpstreamRequest = {
    question: string;
    mode: "qa" | "report";
    live_context: string;
    retrieval_query?: string;
    top_k: number;
};

export type AssistantUpstreamResponse = {
    answer: string;
    model: string;
    sources: AssistantSource[];
    retrieval_ms: number;
    generation_ms: number;
    retrieval_error: string | null;
};

export type AssistantDeps = {
    snapshot: () => Promise<FleetSnapshot>;
    // undefined when ASSISTANT_BASE_URL is not configured
    ask?: (request: AssistantUpstreamRequest) => Promise<AssistantUpstreamResponse>;
};

async function postToAssistant(request: AssistantUpstreamRequest): Promise<AssistantUpstreamResponse> {
    let response: Response;
    try {
        response = await fetch(new URL("/v1/assistant/chat", env.ASSISTANT_BASE_URL), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(env.ASSISTANT_TIMEOUT_MS),
        });
    } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new AppError(503, timedOut ? "Assistant did not answer in time" : "Assistant service unavailable", "ASSISTANT_UNAVAILABLE");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = (payload as { detail?: { message?: string } | string }).detail;
        const message = typeof detail === "string" ? detail : detail?.message ?? "Assistant request failed";
        throw new AppError(response.status === 422 ? 400 : 503, message, "ASSISTANT_UNAVAILABLE");
    }
    return payload as AssistantUpstreamResponse;
}

export function createAssistantService(deps: AssistantDeps) {
    return {
        async chat(body: AssistantChatBody) {
            if (!deps.ask) throw new AppError(503, "Assistant is not configured (ASSISTANT_BASE_URL)", "ASSISTANT_DISABLED");
            const snapshot = await deps.snapshot();
            const report = body.mode === "report";
            const question = body.question || REPORT_QUESTION;
            const upstream = await deps.ask({
                question,
                mode: body.mode,
                live_context: renderSnapshotText(snapshot),
                ...(report ? { retrieval_query: reportRetrievalQuery(snapshot) } : {}),
                top_k: report ? 6 : 5,
            });
            const answer = report
                ? `${renderReportFigures(snapshot)}\n\n### 평가 및 권고\n${upstream.answer}`
                : upstream.answer;
            return {
                mode: body.mode,
                question,
                answer,
                sources: upstream.sources ?? [],
                model: upstream.model,
                snapshotAt: snapshot.generatedAt,
                retrievalError: upstream.retrieval_error ?? null,
                timingsMs: { retrieval: upstream.retrieval_ms, generation: upstream.generation_ms },
            };
        },
    };
}

export const assistantService = createAssistantService({
    snapshot: () => collectFleetSnapshot(prisma),
    ...(env.ASSISTANT_BASE_URL ? { ask: postToAssistant } : {}),
});
