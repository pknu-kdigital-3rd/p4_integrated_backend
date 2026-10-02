// WebSocket transport for the operator assistant panel.
//
// Protocol (JSON text frames) on /api/v1/assistant/ws:
//   client -> { type: "auth", token }                    first message, within 10 s
//   server -> { type: "ready" }
//   client -> { type: "ask", requestId, mode, question? }
//   server -> { type: "start" | "meta" | "delta" | "done" | "error", requestId, ... }
//
// The panel keeps one socket for the page's lifetime, so hiding the panel
// does not interrupt an answer. Closing the socket is the explicit abort:
// every in-flight answer is aborted, which closes the upstream request to
// p4-llm and stops generation there.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { verifyAccessToken } from "../../common/auth/jwt.ts";
import { logger } from "../../config/logger.ts";
import { assistantChatSchema } from "./assistant.schema.ts";
import { assistantService, type AssistantClientEvent } from "./assistant.service.ts";

export const ASSISTANT_SOCKET_PATH = "/api/v1/assistant/ws";
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
// One answer at a time per socket keeps EXAONE load bounded per operator.
const MAX_ACTIVE_ANSWERS = 1;
const ALLOWED_ROLES = new Set(["ADMIN", "OPERATOR", "VIEWER"]);

export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4403;

type StreamChat = (body: Parameters<typeof assistantService.streamChat>[0], signal: AbortSignal) => AsyncIterable<AssistantClientEvent>;

export type AssistantSocketDeps = {
    verify: (token: string) => Promise<{ role: string }>;
    streamChat: StreamChat;
};

const defaultDeps: AssistantSocketDeps = {
    verify: verifyAccessToken,
    streamChat: (body, signal) => assistantService.streamChat(body, signal),
};

function send(socket: WebSocket, message: Record<string, unknown>) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function parse(data: RawData): Record<string, unknown> | null {
    try {
        const value = JSON.parse(data.toString());
        return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function handleConnection(socket: WebSocket, deps: AssistantSocketDeps) {
    let authenticated = false;
    let alive = true;
    const active = new Map<string, AbortController>();
    const authTimer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, "authentication required"), AUTH_TIMEOUT_MS);

    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
        if (!alive) { socket.terminate(); return; }
        alive = false;
        socket.ping();
    }, HEARTBEAT_MS);

    async function answer(requestId: string, body: Parameters<StreamChat>[0], controller: AbortController) {
        try {
            for await (const event of deps.streamChat(body, controller.signal)) {
                if (controller.signal.aborted) break;
                send(socket, { ...event, requestId });
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                logger.warn({ err: error, requestId }, "Assistant answer failed");
                send(socket, { type: "error", requestId, code: "ASSISTANT_UNAVAILABLE", message: "Assistant answer failed" });
            }
        } finally {
            active.delete(requestId);
        }
    }

    socket.on("message", async (data) => {
        const message = parse(data);
        if (!message) { send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Invalid JSON message" }); return; }

        if (!authenticated) {
            if (message.type !== "auth" || typeof message.token !== "string") {
                socket.close(CLOSE_UNAUTHORIZED, "authentication required");
                return;
            }
            try {
                const principal = await deps.verify(message.token);
                if (!ALLOWED_ROLES.has(principal.role)) { socket.close(CLOSE_FORBIDDEN, "forbidden"); return; }
            } catch {
                socket.close(CLOSE_UNAUTHORIZED, "invalid or expired access token");
                return;
            }
            authenticated = true;
            clearTimeout(authTimer);
            send(socket, { type: "ready" });
            return;
        }

        if (message.type !== "ask") {
            send(socket, { type: "error", code: "INVALID_MESSAGE", message: `Unsupported message type: ${String(message.type)}` });
            return;
        }
        const requestId = typeof message.requestId === "string" ? message.requestId.slice(0, 64) : "";
        if (!requestId) { send(socket, { type: "error", code: "INVALID_MESSAGE", message: "requestId is required" }); return; }
        const parsed = assistantChatSchema.safeParse({ mode: message.mode, question: message.question });
        if (!parsed.success) {
            send(socket, { type: "error", requestId, code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "Invalid request" });
            return;
        }
        if (active.size >= MAX_ACTIVE_ANSWERS || active.has(requestId)) {
            send(socket, { type: "error", requestId, code: "ASSISTANT_BUSY", message: "An answer is already in progress" });
            return;
        }
        const controller = new AbortController();
        active.set(requestId, controller);
        void answer(requestId, parsed.data, controller);
    });

    socket.on("close", () => {
        clearTimeout(authTimer);
        clearInterval(heartbeat);
        for (const controller of active.values()) controller.abort();
        active.clear();
    });
}

// Attach the assistant WebSocket to the HTTP server. Returns a closer for
// graceful shutdown (open sockets would otherwise keep the server alive).
export function attachAssistantSocket(server: Server, deps: AssistantSocketDeps = defaultDeps) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    wss.on("connection", (socket) => handleConnection(socket, deps));
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path !== ASSISTANT_SOCKET_PATH) {
            socket.destroy();
            return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    });
    return {
        close() {
            for (const client of wss.clients) client.close(1001, "server shutting down");
            wss.close();
        },
    };
}
