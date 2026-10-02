import { z } from "zod";

import { registry } from "../../docs/registry.ts";
import { assistantChatSchema } from "./assistant.schema.ts";

const AssistantChatResponse = registry.register("AssistantChat", z.object({
    data: z.object({
        mode: z.enum(["qa", "report"]),
        question: z.string(),
        answer: z.string().openapi({ description: "Markdown answer; report mode starts with data-rendered tables" }),
        sources: z.array(z.record(z.string(), z.unknown())).openapi({ description: "KOSHA GUIDE evidence ([S1] = first)" }),
        model: z.string(),
        snapshotAt: z.string(),
        retrievalError: z.string().nullable(),
        timingsMs: z.object({ retrieval: z.number(), generation: z.number() }),
    }),
}));

registry.registerPath({
    method: "post",
    path: "/api/v1/assistant/chat",
    tags: ["Assistant"],
    summary: "Ask the fleet assistant (current fleet state + KOSHA transport guides)",
    request: { body: { content: { "application/json": { schema: assistantChatSchema } } } },
    responses: {
        200: { description: "Assistant answer", content: { "application/json": { schema: AssistantChatResponse } } },
        503: { description: "Assistant not configured or unavailable" },
    },
});
