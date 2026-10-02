import { z } from "zod";

const idSchema = z.string().regex(/^\d{1,19}$/, "must be a numeric id");

// What the operator is looking at when asking: the selected real vehicle in
// monitoring mode, or the selected scenario/virtual vehicle in virtual mode.
export const assistantScopeSchema = z.discriminatedUnion("view", [
    z.object({ view: z.literal("monitoring"), vehicleId: idSchema.optional() }),
    z.object({ view: z.literal("virtual"), scenarioId: idSchema.optional(), vehicleId: idSchema.optional() }),
]);

export const assistantChatSchema = z.object({
    mode: z.enum(["qa", "report"]).default("qa"),
    question: z.string().trim().max(1000).optional(),
    scope: assistantScopeSchema.optional(),
}).refine((body) => body.mode === "report" || Boolean(body.question), {
    message: "question is required in qa mode",
    path: ["question"],
});

export type AssistantScope = z.infer<typeof assistantScopeSchema>;
export type AssistantChatBody = z.infer<typeof assistantChatSchema>;
