import { z } from "zod";

import { registry } from "../../docs/registry.ts";

const FleetSummaryResponse = registry.register("FleetSummary", z.object({
    data: z.object({
        snapshot: z.record(z.string(), z.unknown()).openapi({ description: "Structured fleet snapshot (real vehicles, virtual scenarios, vision)" }),
        text: z.string().openapi({ description: "Compact Korean snapshot text given to the assistant" }),
    }),
}));

registry.registerPath({
    method: "get",
    path: "/api/v1/fleet/summary",
    tags: ["Fleet"],
    summary: "Read-only current fleet snapshot",
    responses: {
        200: { description: "Fleet snapshot", content: { "application/json": { schema: FleetSummaryResponse } } },
    },
});
