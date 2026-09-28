/**
 * Sansheng WebSocket bridge · /ws 端点
 *
 * 协议(JSON over text frame):
 * Client → Server:
 *   { type: "send"; content: string }
 *   { type: "interrupt" }
 *   { type: "ping" }
 *
 * Server → Client: 复用 agentKernel 的 ServerEvent
 */
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { log } from "../shared/log.js";
import type { AgentKernel, ServerEvent } from "./kernel/agentKernel.js";

export type ClientCommand =
  | { type: "send"; content: string }
  | { type: "interrupt" }
  | { type: "ping" };

export function attachWebSocket(server: Server, kernel: AgentKernel): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    log.muted(`ws connected (clients=${wss.clients.size})`);
    const sink = (e: ServerEvent) => send(ws, e);

    // 每次都实时查 kernel.isReady(),不缓存(settings 变更会 invalidate kernel)
    const ensureStarted = (): Promise<void> =>
      kernel.isReady() ? Promise.resolve() : kernel.start(sink);

    // 连接时主动启动一次
    ensureStarted().catch((err) => {
      send(ws, {
        type: "error",
        conversationId: kernel.getConversationId(),
        error: { code: "start_failed", message: err?.message ?? String(err) },
      });
    });

    ws.on("message", async (raw) => {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(raw.toString());
      } catch {
        send(ws, {
          type: "error",
          conversationId: kernel.getConversationId(),
          error: { code: "bad_json", message: "invalid json" },
        });
        return;
      }

      if (cmd.type === "ping") {
        ensureStarted()
          .then(() => {
            const active = kernel.activeInfo();
            send(ws, {
              type: "ready",
              conversationId: kernel.getConversationId(),
              modelId: active?.modelId ?? "?",
              provider: active?.provider ?? "?",
            });
          })
          .catch((err) =>
            send(ws, {
              type: "error",
              conversationId: kernel.getConversationId(),
              error: { code: "start_failed", message: err?.message ?? String(err) },
            }),
          );
        return;
      }

      if (cmd.type === "interrupt") {
        kernel.abort();
        send(ws, { type: "interrupt", conversationId: kernel.getConversationId() });
        return;
      }

      if (cmd.type === "send") {
        if (typeof cmd.content !== "string" || !cmd.content.trim()) return;
        // ensureStarted 后 prompt;把 sink 传给 prompt 以便极端情况下自启动
        ensureStarted()
          .then(() => kernel.prompt(cmd.content, sink))
          .catch((err) =>
            send(ws, {
              type: "error",
              conversationId: kernel.getConversationId(),
              error: { code: "prompt_failed", message: err?.message ?? String(err) },
            }),
          );
        return;
      }
    });

    ws.on("close", () => log.muted(`ws closed (clients=${wss.clients.size})`));
    ws.on("error", (err) => log.warn("ws error:", err));
  });

  return wss;
}

function send(ws: WebSocket, payload: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}