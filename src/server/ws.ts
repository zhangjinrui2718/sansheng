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
import { Orchestrator, type ProgressEvent } from "./agents/orchestrator.js";
import type { PlannerLlmCall } from "./agents/planner.js";
import type { ExecutorLlmCall } from "./agents/executor.js";
import { artifactBus } from "./bus/index.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";
// M3+ B2(批次 1 提取):plan_done 的 summary 拼装,与 e2e-blockers.test.ts 共用同一实现
import { buildPlanSummary } from "./agents/planSummary.js";
// B4:WS 握手 Origin 校验与 HTTP 安全中间件共用同一 hostname 白名单(单一来源)
import { isAllowedOriginHeader } from "./http/security.js";

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

/**
 * M3+ B1: 把 kernel 的 resolved Model 包装成 PlannerLlmCall/ExecutorLlmCall。
 * 两个接口签名相同((input:{systemPrompt,userPrompt})=>Promise<string>),
 * 所以一个 factory 同时满足两者。
 *
 * 实现:用 pi-ai/compat 的 completeSimple() 跑一次单轮对话,
 * 把 AssistantMessage 的 text blocks 拼成 raw string 返回(Planner/Executor 后续自行 parse)。
 */
function makeLlmCall(kernel: AgentKernel): PlannerLlmCall & ExecutorLlmCall {
  return async (input: { systemPrompt: string; userPrompt: string }) => {
    const model = kernel.getModel();
    if (!model) {
      throw new Error("makeLlmCall: kernel has no resolved model (start kernel first)");
    }
    // B6(审查 §B6「明文 key 进 process.env」):key 显式传给 completeSimple。
    // 旧链路依赖 resolveModel 事先把 key 写进 process.env,Pi compat 的
    // withEnvApiKey 再从 env 兜底 —— 意味着 Planner/Executor 每跑一轮,进程的
    // env 里就长期留着一份明文 provider key(且子进程继承)。pi-ai compat 的
    // withEnvApiKey 只在 `options.apiKey` 缺失时才回落 env,显式传参优先级更高。
    const apiKey = kernel.getModelApiKey();
    const result = await completeSimple(
      model as Parameters<typeof completeSimple>[0],
      {
        systemPrompt: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
      },
      apiKey ? { apiKey } : undefined,
    );
    if (result.stopReason === "error" || result.errorMessage) {
      throw new Error(`makeLlmCall: ${result.errorMessage ?? "unknown error"}`);
    }
    const out: string[] = [];
    for (const c of result.content) {
      if (c.type === "text") out.push(c.text);
    }
    return out.join("");
  };
}

export interface AttachOptions {
  storage?: Storage;
  settingsStore?: SettingsStore;
  dataDir?: string;
  /**
   * 测试注入 seam(仅集成测试用):替换默认的 makeLlmCall。
   * 生产(index.ts)不传 → 行为不变(makeLlmCall(kernel))。
   * 只有 llmCall 允许 fake — runPlan 闭包 / Orchestrator / sink / 生命周期全部走生产路径
   * (docs/CODE-REVIEW-2026-10-01.md §E 批次 1 验收标准)。
   */
  llmCallFactory?: (kernel: AgentKernel) => PlannerLlmCall & ExecutorLlmCall;
}

export function attachWebSocket(
  server: Server,
  kernel: AgentKernel,
  opts: AttachOptions = {},
): WebSocketServer {
  const storage = opts.storage;
  const settingsStore = opts.settingsStore;
  const dataDir = opts.dataDir;
  /** M3b:当前正在跑的 Orchestrator(同时只允许 1 个)。
   *  C7(S2):挂在 attach 级 —— plan 生命周期与任何单个连接解耦,
   *  发起连接中途关闭不打断 plan,也不允许 close handler abort 它。 */
  let activeOrchestrator: Orchestrator | null = null;
  const wss = new WebSocketServer({ noServer: true });

  /**
   * C7(S2):广播到所有 OPEN 客户端。
   * runPlan 的进度/结果不再发给单个连接的 sink —— 旧实现把发起 plan 的 ws
   * 捕获进闭包,刷新页面(连接关闭)后 plan_done/todo_failed 永久进死 socket。
   */
  const broadcast = (payload: ServerEvent): void => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify(payload));
        } catch (err) {
          log.warn("ws broadcast failed:", err);
        }
      }
    }
  };

  /**
   * M3b: 启动一个 Orchestrator,广播 blackboard_update / plan_done。
   * C7(S2):从 per-connection 闭包提升到 attach 级 —— 进度与结果经 broadcast
   * 发给所有活连接;闭包只依赖 attach 级状态(storage/settingsStore/dataDir/
   * activeOrchestrator/kernel),不依赖任何 ws。
   */
  async function runPlan(conversationId: string, goal: string): Promise<void> {
    if (!storage || !settingsStore || !dataDir) {
      broadcast({
        type: "error",
        conversationId,
        error: { code: "plan_unavailable", message: "Orchestrator 需要 storage + settingsStore + dataDir" },
      });
      return;
    }
    if (activeOrchestrator) {
      broadcast({
        type: "error",
        conversationId,
        error: { code: "plan_busy", message: "已有 plan 在跑,请先 abort_plan" },
      });
      return;
    }
    const settings = settingsStore.load();
    const active = settings.providers.find((p) => p.id === settings.activeProviderId);
    if (!active?.apiKey) {
      broadcast({
        type: "error",
        conversationId,
        error: { code: "no_api_key", message: "请先在设置中配置 API Key" },
      });
      return;
    }
    // DI seam:生产默认 makeLlmCall(kernel);集成测试可注入 fake(见 AttachOptions.llmCallFactory)
    const llmCallFactory = opts.llmCallFactory ?? makeLlmCall;
    const orchestrator = new Orchestrator({
      storage,
      dataDir,
      agentDir: kernel.getAgentDir(),
      // M3+ B1: 把 kernel.getModel() 包成 Planner/Executor LLM call
      plannerLlmCall: llmCallFactory(kernel),
      executorLlmCall: llmCallFactory(kernel),
      // M3+ B3/B5: Executor 需要 help → kernel.handleExecutorCallback
      // → Communicator.handleWorkerAsk(knowIt=false) → pending_question
      // S1(A7):经 kernel.emit 多播到活连接,不再绑定发起连接的 sink。
      routeCallback: (cbArg) => kernel.handleExecutorCallback(cbArg, conversationId),
    });
    activeOrchestrator = orchestrator;
    try {
      // A1 修复(docs/CODE-REVIEW-2026-10-01.md §A1):
      // 旧实现在 sink 的 completed 分支里访问 `finalBb`(此时 `const finalBb = await ...`
      // 仍在 TDZ,因为 completeRun 在 resolve 之前同步调 sink)→ ReferenceError →
      // resolve 不可达 + runTimer 已失效 → run() 永久挂起、activeOrchestrator 永不清除。
      // 现在:sink 的 completed 分支只记录 intentId;buildPlanSummary + plan_done
      // 移到 `await orchestrator.run(...)` 返回(finalBb 已初始化)之后统一发送。
      let completedIntentId: string | undefined;
      const finalBb = await orchestrator.run(
        conversationId,
        goal,
        // M3+ B2: 转发 ProgressEvent(C7:经 broadcast 到所有活连接)。
        // - intent_received/todos_planned/todo_started/todo_resolved/callback_routed
        //   /callback_escalated/decision_received → 不外发 ws(artifact_bus 订阅已转发
        //   artifact_created/artifact_status_changed/executor_callback/executor_resume,
        //   重复发会造成客户端重复消费 + 反馈回环)。
        // - todo_failed → error
        // - completed → 仅记录 intentId;plan_done 在 run() settle 之后发(见下,A1)
        (progress: ProgressEvent) => {
          switch (progress.type) {
            case "todo_failed":
              broadcast({
                type: "error",
                conversationId,
                error: { code: "todo_failed", message: `${progress.todo.title}: ${progress.reason}` },
              });
              break;
            case "completed":
              completedIntentId = progress.intent.id;
              break;
            default:
              break;
          }
        },
      );
      // run() 已 settle → finalBb 可用。intentId 优先取 completed 事件;
      // sink 异常被 orchestrator 吞掉时(理论上不发生的兜底)从 artifacts 里找 intent。
      const summary = buildPlanSummary(finalBb, goal);
      const intentId =
        completedIntentId ??
        (finalBb.artifacts ?? []).filter((a) => a.kind === "intent").at(-1)?.id ??
        "";
      broadcast({
        type: "plan_done",
        conversationId,
        intentId,
        summary,
        artifacts: finalBb.artifacts ?? [],
      });
    } catch (err) {
      log.warn("Orchestrator failed:", err);
      broadcast({
        type: "plan_failed",
        conversationId,
        message: (err as Error).message ?? String(err),
      });
    } finally {
      activeOrchestrator = null;
      // A2 修复(docs/CODE-REVIEW-2026-10-01.md §A2):必须 shutdown —
      // 退订全局 artifactBus + 清 watchdog/run timers + abort 在飞 executor。
      // 旧实现只置 null:Orchestrator 变僵尸订阅者跨连接存活,下一个 plan 的
      // intent 会被僵尸重复消费(实证 planner=2 executor=2 → 重复 LLM 调用、
      // 重复落库、同一 todo 双方执行)。shutdown() 幂等;run 未 settle 时兜底
      // reject(本路径 run 已 settle,通常为 no-op)。
      try {
        orchestrator.shutdown();
      } catch (err) {
        log.warn("runPlan: orchestrator.shutdown failed:", err);
      }
    }
  }

  // M3+ B4 / C7(S2):setOnTask 在 attach 级只接线一次(幂等,不再被后续连接覆盖)。
  // handler 稳定:runPlan 经 broadcast 发进度 —— 即使触发 task 的连接已关闭,
  // plan 照跑、结果到达所有活连接。setOnTask 会处理 communicator 未就绪的情况
  // (_pendingOnTask 缓存,ensureCommunicator 时绑定)。
  kernel.setOnTask(({ goal, conversationId: goalConvId }) => {
    void runPlan(goalConvId, goal);
  });

  // 批次 4b B5(审查 §B5):/api/reset 会删掉 sansheng.db —— 在删之前先 abort 掉
  // 在跑的 plan(退订 bus + abort 在飞 executor + 清 watchdog),否则它会在数据
  // 消失之后继续烧 token 并把产物写进刚重建的空库。activeOrchestrator 是
  // attach 级状态,只有 ws.ts 拿得到,所以在这里注册给 kernel 的数据重置钩子。
  kernel.setOnDataReset(() => {
    if (!activeOrchestrator) return;
    const running = activeOrchestrator;
    activeOrchestrator = null;
    try {
      running.abort();
    } catch (err) {
      log.warn("data reset: activeOrchestrator.abort failed:", err);
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    // B4(docs/CODE-REVIEW-2026-10-01.md §B4):WS 握手 Origin 校验 ——
    // 有 Origin 头 → hostname 必须在本地白名单(127.0.0.1/localhost/::1,任意端口,
    // 与 HTTP 安全中间件同源);无 Origin → 放行(curl/CLI/测试 ws client 等非浏览器
    // 客户端,批次 1 集成测试即此形态)。拒绝时回 403 再 destroy,客户端可诊断。
    const originRaw = req.headers.origin;
    const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
    if (typeof origin === "string" && !isAllowedOriginHeader(origin)) {
      log.muted(`ws upgrade rejected: Origin not local: ${origin}`);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    log.muted(`ws connected (clients=${wss.clients.size})`);
    // S1(A7):连接建立即 attachSink —— kernel 的流式 delta / bus_event / ready 等
    // 经 emit 多播到所有活连接;close 时 detach。本连接死亡不再影响 kernel 输出,
    // 重连的新连接立即开始收流(旧实现把首个连接的 sink 捕获进 kernel 闭包)。
    const detachSink = kernel.attachSink((e: ServerEvent) => send(ws, e));

    // 连接后立刻发握手 ready(连接级事件,只发本连接;start 内部的 ready 走多播)
    const meta = kernel.activeInfo() ?? { modelId: "unknown", provider: "unknown" };
    send(ws, { type: "ready", conversationId: kernel.getConversationId(), modelId: meta.modelId, provider: meta.provider });

    // 每次都实时查 kernel.isReady(),不缓存(settings 变更会 invalidate kernel)
    const ensureStarted = (): Promise<void> =>
      kernel.isReady() ? Promise.resolve() : kernel.start();

    // 连接时主动启动一次(start 的 ready/error 经 emit 到所有活连接;
    // 这里的 catch 只兜 ensureStarted 自身 reject 时给本连接补一个 start_failed)
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
      // S1(A7):detach 本连接 sink —— kernel 多播集合移除,事件不再进死 socket。
      detachSink();
      for (const u of busUnsubs) {
        try { u(); } catch { /* ignore */ }
      }
      // C7(S2):连接关闭 **不** abort activeOrchestrator —— plan 生命周期挂在
      // attach 级,刷新/断线后 plan 继续跑,进度经 broadcast 到达重连的连接。
      log.muted(`ws closed (clients=${wss.clients.size})`);
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

      if (cmd.type === "load_conversation") {
        if (!cmd.conversationId) return;
        try {
          await ensureStarted();
          // 只有 conversationId 不同时才 resume(避免无谓 dispose)
          if (kernel.getConversationId() !== cmd.conversationId) {
            await kernel.resume(cmd.conversationId);
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
              await kernel.resume(cmd.conversationId);
            }
            // M3a B8: 注入 fragment / profile context (可选,失败不阻塞)
            // 批次 5a.5 T1(§B1):富集段改经 contextBlock 参数传递 —— kernel 落库
            // raw 原文(用户历史不再出现「# Relevant Memories…---User:」blob),
            // Pi session 仍收到 enriched 全文(记忆能力保留)。summary kind 已被
            // searchFragmentsByText 默认排除(存量垃圾失活,见 repo/fragments.ts)。
            let contextBlock: string | undefined;
            if (storage) {
              try {
                const { searchFragmentsByText, listProfile } = await import("./storage/index.js");
                const fragments = searchFragmentsByText(storage.db, cmd.content, { limit: 3 });
                const profile = listProfile(storage.db);
                const ctx = buildContextBlock(
                  fragments.map((f) => ({ kind: f.kind, content: f.content })),
                  profile.map((p) => ({ key: p.key, value: p.value, confidence: p.confidence })),
                );
                if (ctx) contextBlock = ctx;
              } catch (err) {
                log.warn("ws: context injection failed:", err);
              }
            }
            await kernel.prompt(cmd.content, contextBlock ? { contextBlock } : undefined);
          })
          .catch((err) => {
            // M3c: 即使 ensureStarted 失败(如没 LLM provider),仍尝试 prompt,
            // Communicator 可以走启发式/禁用 LLM 路径提供反馈。
            if (err && (err as Error).message?.includes("尚未配置任何 provider")) {
              log.warn("ws: ensureStarted failed (no provider); continuing to prompt for Communicator:", err);
              void kernel.prompt(cmd.content).catch((err2) =>
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

      // M3c/B3/B5: 用户回答 worker 提问 → kernel.handleUserAnswer
      // 不仅 bus.reply,还反查 pendingExecutorCallbacks → publish executor_resume
      if (cmd.type === "answer_question") {
        const { replied, resumed } = kernel.handleUserAnswer(cmd.questionId, cmd.payload, cmd.conversationId);
        if (!replied && !resumed) {
          send(ws, {
            type: "error",
            conversationId: cmd.conversationId,
            error: { code: "no_pending_question", message: `question ${cmd.questionId} 不在 pending` },
          });
        }
        // resumed 在内部已经 publish executor_resume(artifactBus → kernel.handleUserAnswer)，
        // artifactBus 订阅会把 executor_resume 推到 ws(本连接已订阅)。
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

    ws.on("error", (err) => log.warn("ws error:", err));

  });

  return wss;
}

function send(ws: WebSocket, payload: ServerEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}