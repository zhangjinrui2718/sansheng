/**
 * Sansheng WebSocket bridge · /ws 端点
 *
 * 协议(JSON over text frame):
 * Client → Server:
 *   { type: "send"; content: string; conversationId?: string }
 *   { type: "interrupt" }
 *   { type: "ping" }
 *   { type: "load_conversation"; conversationId: string }
 *
 * Server → Client: 复用 agentKernel 的 ServerEvent
 *
 * M3a:
 *   - send 可选携带 conversationId;mismatch 时自动 resume
 *   - load_conversation 显式触发 resume
 *   - prompt handler 注入 fragment / profile context(B8 可选增强)
 */
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { log } from "../shared/log.js";
/**
 * WS 命令类型 - 镜像 shared/types/ws.ts(避免 server build rootDir 问题)
 * 同步点:ClientCommand 变更时两边同步改。
 */
export type ClientCommand =
  | { type: "send"; content: string; conversationId?: string }
  | { type: "interrupt" }
  | { type: "ping" }
  | { type: "load_conversation"; conversationId: string }
  // M3b: 多 agent / plan
  | { type: "plan"; goal: string; conversationId: string }
  | { type: "abort_plan" }
  // M3c: Communicator ↔ MessageBus
  | { type: "answer_question"; questionId: string; payload: string; conversationId: string }
  | { type: "cancel_question"; questionId: string; conversationId: string }
  | { type: "bus_replay"; conversationId: string; fromTs: number };

import type { AgentKernel, ServerEvent } from "./kernel/agentKernel.js";
import { SettingsStore } from "./settings/store.js";
import { Storage } from "./storage/index.js";
import { Orchestrator } from "./agents/orchestrator.js";
import type { Blackboard } from "@shared/types/agents";
import { artifactBus } from "./bus/index.js";

/**
 * 把 user message 包成含历史 context 的 prompt
 * M3a: 简单 LIKE 匹配 fragments + profile 注入
 */
function buildContextBlock(fragments: Array<{ kind: string; content: string }>, profile: Array<{ key: string; value: string; confidence?: number }>): string {
  if (fragments.length === 0 && profile.length === 0) return "";
  const parts: string[] = [];
  if (profile.length > 0) {
    parts.push("# User Profile");
    for (const p of profile) {
      parts.push(`- ${p.key}: ${p.value}${p.confidence !== undefined ? ` (confidence: ${p.confidence.toFixed(2)})` : ""}`);
    }
  }
  if (fragments.length > 0) {
    parts.push("\n# Relevant Memories");
    for (const f of fragments) {
      parts.push(`- [${f.kind}] ${f.content}`);
    }
  }
  return parts.join("\n");
}

export interface AttachOptions {
  storage?: Storage;
  settingsStore?: SettingsStore;
  dataDir?: string;
}

export function attachWebSocket(
  server: Server,
  kernel: AgentKernel,
  opts: AttachOptions = {},
): WebSocketServer {
  const storage = opts.storage;
  const settingsStore = opts.settingsStore;
  const dataDir = opts.dataDir;
  /** M3b:当前 connection 上正在跑的 Orchestrator(同时只允许 1 个) */
  let activeOrchestrator: Orchestrator | null = null;
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

    // 连接后立刻广播 ready 事件(前端可借此判断协议握手完成)
    const meta = kernel.activeInfo() ?? { modelId: "unknown", provider: "unknown" };
    send(ws, { type: "ready", conversationId: kernel.getConversationId(), modelId: meta.modelId, provider: meta.provider });

    // 每次都实时查 kernel.isReady(),不缓存(settings 变更会 invalidate kernel)
    const ensureStarted = (): Promise<void> =>
      kernel.isReady() ? Promise.resolve() : kernel.start(sink);

    // M3b: Orchestrator runner 在 ws.on("error") 之后定义(依赖 send(ws, ...))
    // 略(全量定义在下方)

    // 连接时主动启动一次
    ensureStarted().catch((err) => {
      send(ws, {
        type: "error",
        conversationId: kernel.getConversationId(),
        error: { code: "start_failed", message: err?.message ?? String(err) },
      });
    });

    // M3+: 订阅 BlackboardArtifact lifecycle bus → 转发到 Client(同 connection)
    // 这里用 artifactBus(process singleton) + per-connection unsubscribe list。
    const busUnsubs: Array<() => void> = [];
    busUnsubs.push(
      artifactBus.subscribe("artifact_created", (e) => {
        send(ws, { type: "artifact_created", artifact: e.artifact });
      }),
    );
    busUnsubs.push(
      artifactBus.subscribe("artifact_status_changed", (e) => {
        send(ws, {
          type: "artifact_status_changed",
          artifactId: e.artifactId,
          oldStatus: e.oldStatus,
          newStatus: e.newStatus,
          actor: e.actor,
        });
      }),
    );
    busUnsubs.push(
      artifactBus.subscribe("executor_callback", (e) => {
        send(ws, {
          type: "executor_callback",
          executorSessionId: e.executorSessionId,
          hypothesisId: e.hypothesisId,
          reason: e.reason,
        });
      }),
    );
    busUnsubs.push(
      artifactBus.subscribe("executor_resume", (e) => {
        send(ws, {
          type: "executor_resume",
          executorSessionId: e.executorSessionId,
          decisionArtifactId: e.decisionArtifactId,
        });
      }),
    );
    busUnsubs.push(
      artifactBus.subscribe("harness_proposal_created", (e) => {
        send(ws, { type: "harness_proposal_created", artifact: e.artifact });
      }),
    );
    ws.on("close", () => {
      for (const u of busUnsubs) {
        try { u(); } catch { /* ignore */ }
      }
    });

    /**
     * M3b: 启动一个 Orchestrator,在 ws 上发 blackboard_update / plan_done。
     * 闭包依赖 send(ws, ...)、storage、settingsStore、dataDir、activeOrchestrator、kernel.getAgentDir()。
     */
    async function runPlan(conversationId: string, goal: string): Promise<void> {
      if (!storage || !settingsStore || !dataDir) {
        send(ws, {
          type: "error",
          conversationId,
          error: { code: "plan_unavailable", message: "Orchestrator 需要 storage + settingsStore + dataDir" },
        });
        return;
      }
      if (activeOrchestrator) {
        send(ws, {
          type: "error",
          conversationId,
          error: { code: "plan_busy", message: "已有 plan 在跑,请先 abort_plan" },
        });
        return;
      }
      const settings = settingsStore.load();
      const active = settings.providers.find((p) => p.id === settings.activeProviderId);
      if (!active?.apiKey) {
        send(ws, {
          type: "error",
          conversationId,
          error: { code: "no_api_key", message: "请先在设置中配置 API Key" },
        });
        return;
      }
      const orchestrator = new Orchestrator({
        storage,
        dataDir,
        agentDir: kernel.getAgentDir(),
        settings: {
          provider: active.provider,
          baseUrl: active.baseUrl,
          apiKey: active.apiKey,
          modelId: active.modelId,
          thinkingLevel: active.thinkingLevel,
        },
      });
      activeOrchestrator = orchestrator;
      try {
        const finalBb = await orchestrator.run(
          conversationId,
          goal,
          (progress) => {
            send(ws, {
              type: "blackboard_update",
              blackboard: progress.blackboard,
              agents: progress.agents,
            });
          },
        );
        send(ws, { type: "plan_done", blackboard: finalBb });
      } catch (err) {
        log.warn("Orchestrator failed:", err);
        send(ws, {
          type: "error",
          conversationId,
          error: { code: "plan_failed", message: (err as Error).message ?? String(err) },
        });
      } finally {
        activeOrchestrator = null;
      }
    }

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

      if (cmd.type === "load_conversation") {
        if (!cmd.conversationId) return;
        try {
          await ensureStarted();
          // 只有 conversationId 不同时才 resume(避免无谓 dispose)
          if (kernel.getConversationId() !== cmd.conversationId) {
            await kernel.resume(cmd.conversationId, sink);
          } else {
            // 同 id 也再 emit 一次 ready,便于前端在切 tab 后快速恢复 kernelReady
            const active = kernel.activeInfo();
            send(ws, {
              type: "ready",
              conversationId: kernel.getConversationId(),
              modelId: active?.modelId ?? "?",
              provider: active?.provider ?? "?",
            });
          }
        } catch (err) {
          send(ws, {
            type: "error",
            conversationId: cmd.conversationId,
            error: { code: "resume_failed", message: (err as Error)?.message ?? String(err) },
          });
        }
        return;
      }

      if (cmd.type === "send") {
        if (typeof cmd.content !== "string" || !cmd.content.trim()) return;
        // M3b: `/plan 目标` 快捷转发到 plan 处理器
        if (cmd.content.startsWith("/plan ")) {
          const goal = cmd.content.slice(6).trim();
          if (goal && cmd.conversationId) {
            void runPlan(cmd.conversationId, goal);
          }
          return;
        }
        // ensureStarted 后:若 conversationId 不匹配,先 resume 再 prompt
        ensureStarted()
          .then(async () => {
            if (cmd.conversationId && kernel.getConversationId() !== cmd.conversationId) {
              await kernel.resume(cmd.conversationId, sink);
            }
            // M3a B8: 注入 fragment / profile context (可选,失败不阻塞)
            let enriched = cmd.content;
            if (storage) {
              try {
                const { searchFragmentsByText, listProfile } = await import("./storage/index.js");
                const fragments = searchFragmentsByText(storage.db, cmd.content, { limit: 3 });
                const profile = listProfile(storage.db);
                const ctx = buildContextBlock(
                  fragments.map((f) => ({ kind: f.kind, content: f.content })),
                  profile.map((p) => ({ key: p.key, value: p.value, confidence: p.confidence })),
                );
                if (ctx) enriched = `${ctx}\n\n---\n\nUser: ${cmd.content}`;
              } catch (err) {
                log.warn("ws: context injection failed:", err);
              }
            }
            await kernel.prompt(enriched, sink);
          })
          .catch((err) => {
            // M3c: 即使 ensureStarted 失败(如没 LLM provider),仍尝试 prompt,
            // Communicator 可以走启发式/禁用 LLM 路径提供反馈。
            if (err && (err as Error).message?.includes("尚未配置任何 provider")) {
              log.warn("ws: ensureStarted failed (no provider); continuing to prompt for Communicator:", err);
              void kernel.prompt(cmd.content, sink).catch((err2) =>
                send(ws, {
                  type: "error",
                  conversationId: kernel.getConversationId(),
                  error: { code: "prompt_failed", message: err2?.message ?? String(err2) },
                }),
              );
              return;
            }
            send(ws, {
              type: "error",
              conversationId: kernel.getConversationId(),
              error: { code: "prompt_failed", message: err?.message ?? String(err) },
            });
          });
        return;
      }

      // M3b: 显式 plan 命令
      if (cmd.type === "plan") {
        if (!cmd.goal || !cmd.conversationId) return;
        void runPlan(cmd.conversationId, cmd.goal);
        return;
      }

      if (cmd.type === "abort_plan") {
        if (activeOrchestrator) {
          activeOrchestrator.abort();
          activeOrchestrator = null;
        }
        return;
      }

      // M3c: 用户回答 worker 提问 → communicator.answerPending
      if (cmd.type === "answer_question") {
        const ok = kernel.answerPendingQuestion(cmd.questionId, cmd.payload);
        if (!ok) {
          send(ws, {
            type: "error",
            conversationId: cmd.conversationId,
            error: { code: "no_pending_question", message: `question ${cmd.questionId} 不在 pending` },
          });
        }
        return;
      }

      // M3c: 取消一个 pending question
      if (cmd.type === "cancel_question") {
        kernel.cancelPendingQuestion(cmd.questionId);
        return;
      }

      // M3c: timeline 回放
      if (cmd.type === "bus_replay") {
        kernel
          .replayBus(cmd.conversationId, cmd.fromTs)
          .then((messages) => {
            for (const m of messages) {
              send(ws, { type: "bus_event", message: m });
            }
          })
          .catch((err) =>
            send(ws, {
              type: "error",
              conversationId: cmd.conversationId,
              error: { code: "replay_failed", message: (err as Error).message ?? String(err) },
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