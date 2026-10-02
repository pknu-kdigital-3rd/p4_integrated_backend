import { z } from "zod";

export const assistantChatSchema = z.object({
    mode: z.enum(["qa", "report"]).default("qa"),
    question: z.string().trim().max(1000).optional(),
}).refine((body) => body.mode === "report" || Boolean(body.question), {
    message: "question is required in qa mode",
    path: ["question"],
});

export type AssistantChatBody = z.infer<typeof assistantChatSchema>;
