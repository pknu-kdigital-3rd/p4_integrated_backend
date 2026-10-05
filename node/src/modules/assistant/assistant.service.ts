// Operator assistant: live ITS context + KOSHA transport-guide RAG.
//
// The p4-llm assistant API (services/llm, ASSISTANT_BASE_URL) owns retrieval and the LLM;
// this service supplies the live facts, scoped to the operator's current
// selection (assistant.context.ts). In report mode the figures are rendered
// here from data and the LLM only adds the assessment and recommendations,
// so a report's numbers can never be invented.
import { AppError } from "../../common/errors/app-error.ts";
import { env } from "../../config/env.ts";
import { prisma } from "../../infrastructure/database/prisma.ts";
import { buildAssistantContext, type AssistantContext } from "./assistant.context.ts";
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

// NDJSON events from p4-llm POST /v1/assistant/stream.
export type AssistantUpstreamEvent =
    | { type: "meta"; sources: AssistantSource[]; model: string; retrieval_ms: number; retrieval_error: string | null }
    | { type: "delta"; text: string }
    | { type: "done"; generation_ms: number }
    | { type: "error"; code?: string; message: string };

// Events sent to the operator panel over the assistant WebSocket.
export type AssistantClientEvent =
    | { type: "start"; mode: "qa" | "report"; question: string; snapshotAt: string; subject: string }
    | { type: "meta"; sources: AssistantSource[]; model: string; retrievalError: string | null }
    | { type: "delta"; text: string }
    | { type: "done"; model: string; timingsMs: { retrieval: number; generation: number } }
    | { type: "error"; code: string; message: string };

export type AssistantDeps = {
    context: (body: AssistantChatBody) => Promise<AssistantContext>;
    // undefined when ASSISTANT_BASE_URL is not configured
    ask?: (request: AssistantUpstreamRequest) => Promise<AssistantUpstreamResponse>;
    stream?: (request: AssistantUpstreamRequest, signal: AbortSignal) => AsyncIterable<AssistantUpstreamEvent>;
};

function upstreamRequest(body: AssistantChatBody, context: AssistantContext): AssistantUpstreamRequest {
    const report = body.mode === "report";
    return {
        question: body.question || REPORT_QUESTION,
        mode: body.mode,
        live_context: `[질문 대상] ${context.subject}\n${context.liveText}`,
        ...(report ? { retrieval_query: context.retrievalQuery } : {}),
        top_k: report ? 6 : 5,
    };
}

// Reads p4-llm's NDJSON stream. Aborting `signal` closes the HTTP request,
// which makes p4-llm close the LLM stream and stop generating.
export async function* streamFromAssistant(request: AssistantUpstreamRequest, signal: AbortSignal): AsyncGenerator<AssistantUpstreamEvent> {
    let response: Response;
    try {
        response = await fetch(new URL("/v1/assistant/stream", env.ASSISTANT_BASE_URL), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: AbortSignal.any([signal, AbortSignal.timeout(env.ASSISTANT_TIMEOUT_MS)]),
        });
    } catch (error) {
        if (signal.aborted) return;
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        throw new AppError(503, timedOut ? "Assistant did not answer in time" : "Assistant service unavailable", "ASSISTANT_UNAVAILABLE");
    }
    if (!response.ok || !response.body) {
        throw new AppError(response.status === 422 ? 400 : 503, `Assistant request failed (HTTP ${response.status})`, "ASSISTANT_UNAVAILABLE");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) yield JSON.parse(line) as AssistantUpstreamEvent;
            newline = buffer.indexOf("\n");
        }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as AssistantUpstreamEvent;
}

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
            const context = await deps.context(body);
            const request = upstreamRequest(body, context);
            const upstream = await deps.ask(request);
            const answer = body.mode === "report"
                ? `${context.reportFigures}\n\n### 평가\n${upstream.answer}`
                : upstream.answer;
            return {
                mode: body.mode,
                question: request.question,
                subject: context.subject,
                answer,
                sources: upstream.sources ?? [],
                model: upstream.model,
                snapshotAt: context.generatedAt,
                retrievalError: upstream.retrieval_error ?? null,
                timingsMs: { retrieval: upstream.retrieval_ms, generation: upstream.generation_ms },
            };
        },

        // Streaming answer for the WebSocket. Report mode sends the
        // data-rendered figures first, then the LLM's assessment as it
        // is generated. Ends after done or error; aborting `signal` stops
        // quietly and cancels generation upstream.
        async *streamChat(body: AssistantChatBody, signal: AbortSignal): AsyncGenerator<AssistantClientEvent> {
            if (!deps.stream) {
                yield { type: "error", code: "ASSISTANT_DISABLED", message: "Assistant is not configured (ASSISTANT_BASE_URL)" };
                return;
            }
            const context = await deps.context(body);
            const request = upstreamRequest(body, context);
            yield { type: "start", mode: body.mode, question: request.question, snapshotAt: context.generatedAt, subject: context.subject };
            if (body.mode === "report") {
                yield { type: "delta", text: `${context.reportFigures}\n\n### 평가\n` };
            }
            let model = "";
            let retrievalMs = 0;
            try {
                for await (const event of deps.stream(request, signal)) {
                    if (signal.aborted) return;
                    if (event.type === "meta") {
                        model = event.model;
                        retrievalMs = event.retrieval_ms;
                        yield { type: "meta", sources: event.sources ?? [], model: event.model, retrievalError: event.retrieval_error ?? null };
                    } else if (event.type === "delta") {
                        yield { type: "delta", text: event.text };
                    } else if (event.type === "done") {
                        yield { type: "done", model, timingsMs: { retrieval: retrievalMs, generation: event.generation_ms } };
                        return;
                    } else {
                        yield { type: "error", code: event.code ?? "ASSISTANT_UNAVAILABLE", message: event.message };
                        return;
                    }
                }
            } catch (error) {
                if (signal.aborted) return;
                yield {
                    type: "error",
                    code: error instanceof AppError && error.code ? error.code : "ASSISTANT_UNAVAILABLE",
                    message: error instanceof Error ? error.message : String(error),
                };
                return;
            }
            if (!signal.aborted) yield { type: "error", code: "ASSISTANT_UNAVAILABLE", message: "Assistant stream ended unexpectedly" };
        },
    };
}

export const assistantService = createAssistantService({
    context: (body) => buildAssistantContext(prisma, body),
    ...(env.ASSISTANT_BASE_URL ? { ask: postToAssistant, stream: streamFromAssistant } : {}),
});
