import { Router } from "express";
import type { Request, Response } from "express";

import { authenticate } from "../../common/auth/authenticate.ts";
import { requireRole } from "../../common/auth/require-role.ts";
import { validateBody } from "../../common/middleware/validate-body.ts";
import { assistantChatSchema, type AssistantChatBody } from "./assistant.schema.ts";
import { assistantService } from "./assistant.service.ts";

export const assistantRouter = Router();

assistantRouter.post(
    "/chat",
    authenticate,
    requireRole("ADMIN", "OPERATOR", "VIEWER"),
    validateBody(assistantChatSchema),
    async (req: Request<{}, {}, AssistantChatBody>, res: Response) => {
        res.status(200).json({ data: await assistantService.chat(req.body) });
    },
);
