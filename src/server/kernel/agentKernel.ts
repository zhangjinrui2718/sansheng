/**
 * Sansheng AgentKernel · 单 agent 模式(M1)
 *
 * 包一层 Pi `createAgentSession`,负责:
 * - Settings → Model 解析
 * - Pi AgentSession 生命周期
 * - Pi AgentSessionEvent → WS ServerEvent 翻译
 * - token usage 累积 + cost 估算
 */
import { createAgentSession, DefaultResourceLoader, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { nanoid } from "nanoid";
import { SettingsStore, isLegacyDefaultCwd, type Settings, type ProviderConfig } from "../settings/store.js";
import { estimateCost } from "../providers/cost.js";
import { log } from "../../shared/log.js";
import { MessageBus } from "../agents/messageBus.js";
import {
  Communicator,
  makeLlmCommunicatorDecide,
  makeAlignmentCheck,
  type CommunicatorSink,
} from "../agents/communicator.js";
// 批次 5b-2 T1:回合后异步智能沉淀(chat 回合 message_end → D7 artifacts 落 blackboard)
import { sedimentTurn } from "../agents/sedimentation.js";
import type { BusMessage as BusMessageFromTypes, CommunicatorDecision } from "@shared/types/agents";
import type { RunnerSettings } from "../agents/runner.js";
import { loadHarness } from "../harness/loader.js";
import { createBridgedTools } from "../harness/toolBridge.js";
import { buildNativeTools } from "../harness/nativeTools.js";
import { appendBusMessage, loadBusMessages } from "../agents/busPersister.js";

/** 本文件用到 BusMessage 类型 */
type BusMessage = BusMessageFromTypes;
import { resolveModel, syncActiveProviderApiKeyEnv } from "../providers/registry.js";
import { artifactBus, makeArtifact } from "../bus/index.js";
import { upsertArtifact } from "../storage/index.js";
import {
  Storage,
  embedText,
  extractFragments,
  insertFragment,
  insertMessage,
  recordMessageUsage,
  upsertAgentState,
  getAgentState,
  upsertConversation,
  listMessagesByConversation,
  getConversation,
  setConversationTitle,
  upsertFragmentEmbedding,
  upsertProfile,
} from "../storage/index.js";

function isStreaming(s: unknown): s is { isStreaming: boolean } {
  return !!s && typeof s === "object" && "isStreaming" in s && typeof (s as { isStreaming: unknown }).isStreaming === "boolean";
}

interface MsgShape {
  id?: string;
  role?: "user" | "assistant";
}
function hasMsgShape(s: unknown): s is MsgShape {
  return !!s && typeof s === "object";
}

export type ServerEvent =
  | { type: "title_changed"; conversationId: string; title: string }
  | { type: "ready"; conversationId: string; modelId: string; provider: string }
  | { type: "agent_start"; conversationId: string; ts: number }
  | { type: "turn_start"; conversationId: string; turnIndex: number; ts: number }
  | { type: "message_start"; conversationId: string; message: { role: "user" | "assistant"; id: string } }
  | { type: "delta"; conversationId: string; messageId: string; text: string }
  | { type: "thinking_delta"; conversationId: string; messageId: string; text: string }
  | { type: "message_end"; conversationId: string; messageId: string; usage?: { input: number; output: number } }
  | { type: "tool_start"; conversationId: string; messageId: string; tool: { id: string; name: string; args: unknown } }
  | { type: "tool_end"; conversationId: string; messageId: string; tool: { id: string; name: string; result: unknown; isError: boolean; durationMs?: number } }
  | { type: "agent_end"; conversationId: string; ts: number; usage?: { input: number; output: number; costUsd: number } }
  | { type: "error"; conversationId: string; error: { code: string; message: string } }
  | { type: "interrupt"; conversationId: string }
  | { type: "conversation_reset"; conversationId: string }
  // M3b: 多 agent Blackboard 流
  | { type: "blackboard_update"; blackboard: import("@shared/types/agents").Blackboard; agents: Record<string, import("@shared/types/agents").AgentRunSummary> }
  // M3+ B2:Orchestrator 完成 / 失败(Sansheng front-end 订阅 plan_done 渲染总结卡)。
  // 旧的 Blackboard 字段被废弃 — 新形态用 conversationId + summary + artifacts。
  // 批次 1 B10-5:前端已接线 — shared/types/ws.ts 的 ServerEvent union 有逐字镜像
  // (web/src/stores/chat.ts applyEvent 消费);改动这两个成员时两边必须同步。
  | {
      type: "plan_done";
      conversationId: string;
      intentId: string;
      summary: string;
      artifacts?: import("@shared/types/blackboard.js").BlackboardArtifact[];
      /**
       * 批次 7-I(B):交付物子集 —— resolved 的 evidence 正文。
       * 与 `artifacts`(整块 blackboard)分开:交付物是**给人看的产物**,
       * artifacts 是给人查的系统状态。定义镜像自 shared/types/ws.ts(同款镜像
       * 关系:server 端不能 value-import @shared/*,两边各自定义)。
       */
      deliveries?: import("@shared/types/chat.js").DeliveryItem[];
    }
  | {
      type: "plan_failed";
      conversationId: string;
      intentId?: string;
      message: string;
    }
  // M3c: Communicator / MessageBus
  | { type: "bus_event"; message: import("@shared/types/agents").BusMessage }
  | { type: "communicator_thinking"; conversationId: string; status: "idle" | "thinking" | "tool_use" }
  | {
      type: "pending_question";
      conversationId: string;
      questionId: string;
      payload: string;
      fromRole: import("@shared/types/agents").RoleId;
    }
  // M3+ BlackboardArtifact lifecycle (forwarded from artifactBus)
  | {
      type: "artifact_created";
      artifact: import("@shared/types/blackboard.js").BlackboardArtifact;
    }
  | {
      type: "artifact_status_changed";
      artifactId: string;
      oldStatus: import("@shared/types/blackboard.js").ArtifactStatus;
      newStatus: import("@shared/types/blackboard.js").ArtifactStatus;
      actor?: import("@shared/types/blackboard.js").ArtifactAuthor;
    }
  | {
      type: "executor_callback";
      executorSessionId: string;
      hypothesisId: string;
      reason: import("@shared/types/blackboard.js").CallbackReason;
    }
  | {
      type: "executor_resume";
      executorSessionId: string;
      decisionArtifactId: string;
    }
  | {
      type: "harness_proposal_created";
      artifact: import("@shared/types/blackboard.js").BlackboardArtifact;
    };

export type EventSink = (e: ServerEvent) => void;

/**
 * 批次 5b-1(P1):AgentKernel 可选构造参数。
 * `decideLlmCall` 是沟通员分类 LLM 的测试注入 seam(参照 ws.ts AttachOptions
 * .llmCallFactory 的 DI 模式)—— 生产不传,decide 走 completeSimple(getModel())。
 */
export interface AgentKernelOptions {
  decideLlmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /**
   * 批次 5b-2(T1):回合后智能沉淀 LLM 的测试注入 seam —— 与 decideLlmCall 同款
   * DI 模式。生产不传 → sedimentTurn 走 completeSimple(getModel());
   * SANSHENG_SEDIMENT=0(tests/setup-env.ts 全局置,测试卫生)或无模型 → 静默跳过。
   * 注入时绕过闸门(显式注入 = 显式测试意图)。
   */
  sedimentLlmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /**
   * 批次 7-E:对齐闸门(ALIGN_SYSTEM_PROMPT)的测试注入 seam —— 与上面两个同款
   * DI 模式。生产不传 → 走 completeSimple(getModel());返回 `{"question":"NONE"}`
   * 即放行开工。测试里用它精确控制「这次要不要拦下来问用户」。
   */
  alignLlmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /**
   * 批次 4a C8 测试 seam / 调优项:createAgentSession 硬超时(ms)。
   * 生产不传 → 8000(Pi SDK 在离线/网络慢时 ModelRuntime.refresh 可能长挂,
   * 无超时会拖死 ensureStarted 链)。
   */
  createSessionTimeoutMs?: number;
}

export class AgentKernel {
  private session: AgentSession | null = null;
  /** S1(A7):start()/resume() 里 session.subscribe 的退订函数。
   *  Pi subscribe 每个 session 恰好调用一次;事件分发靠 emit 动态多播,
   *  连接增减永不重新 subscribe。dispose 路径调用它(与 SDK dispose() 自身
   *  清空 _eventListeners 双保险)。 */
  private sessionUnsubscribe: (() => void) | null = null;
  /**
   * S1(A7 主修):多播 sink 集合。
   * 旧设计把单个 sink 一次性捕获进 session.subscribe / bus.subscribe 闭包,
   * 首个连接关闭或 reset(传 log stub)后,流式输出与 bus 事件永久进死 socket。
   * 现在:ws.ts 每连接 open 时 attachSink(connSink)、close 时 detach;
   * kernel 所有事件出口统一走 this.emit(ev);start/reset/resume/prompt
   * 不再接受 sink 覆盖。
   */
  private sinks = new Set<EventSink>();
  private model: Model<any> | null = null;
  private conversationId: string = `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  private inputTokens = 0;
  private outputTokens = 0;
  private toolStartAt: Map<string, number> = new Map();
  private currentMessageId: string | null = null;
  private settings: Settings;
  /** M2:正在流式写的 assistant message buffer(message_start → message_end) */
  private buf: {
    messageId: string;
    turnIndex: number;
    textDeltas: string[];
    thinkingDeltas: string[];
    toolCalls: Array<{ id: string; name: string; args?: unknown; result?: unknown; isError?: boolean; durationMs?: number }>;
    startedAt: number;
  } | null = null;
  /** M2:当前 turn_index(从 turn_start 事件拿) */
  private currentTurnIndex = 0;
  /** M3a B9: kernel / 上一次 resume 的开始时间(给 reflection 用) */
  private kernelStartedAt = Date.now();
  /** M2:当前正在发/等的 user 文本(prompt() 时 buffer 起来,message_start(user) 时消费) */
  private pendingUserText: string | null = null;
  /**
   * 批次 5b-2 T1:本回合 user raw 的沉淀副本。pendingUserText 在 message_start(user)
   * 即被消费置空,而沉淀触发点在 message_end(assistant)—— 需要独立字段把 raw
   * 原文带过去(与 pendingUserText 同源同值,仅生命周期不同;dispose/newConversation
   * 一并清理)。
   */
  private lastUserRawText: string | null = null;
  /** M3c: MessageBus + Communicator(每会话 1 个,resume 时重建) */
  private bus: MessageBus = new MessageBus();
  private communicator: Communicator | null = null;
  private pendingQuestions = new Map<string, string>(); // questionId → conversationId
  /** M3+ B3/B5: Executor callback(orchestrator.routeCallback 注入此 kernel)。
   *  Synthesized BusMessage questionId → executorSessionId。
   *  user answer 时反查 → publish executor_resume。
   */
  private pendingExecutorCallbacks = new Map<string, string>();
  /** bus 的所有 BusMessage 都走这个 subscriber → 推 ws + 落 jsonl */
  private busUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly agentDir: string,
    private readonly cwd: string,
    private readonly storage: Storage,
    private readonly opts: AgentKernelOptions = {},
  ) {
    this.settings = settingsStore.load();
  }

  isReady(): boolean {
    return this.session !== null;
  }

  /**
   * S1(A7 主修):注册一个多播 sink,返回 detach 函数。
   * ws.ts 每连接 open 时 `const detach = kernel.attachSink(connSink)`,
   * close 时 `detach()`。连接增减不触碰 Pi session 的 subscribe。
   */
  attachSink(fn: EventSink): () => void {
    this.sinks.add(fn);
    return () => {
      this.sinks.delete(fn);
    };
  }

  /**
   * S1:统一事件出口。遍历当前所有 sink,逐个 try/catch —— 单个 sink 抛错
   * (如已半关的 socket)不影响其他 sink,也不冒泡打断 kernel 事件流。
   */
  private emit(ev: ServerEvent): void {
    for (const fn of this.sinks) {
      try {
        fn(ev);
      } catch (err) {
        log.warn("kernel sink threw (isolated):", err);
      }
    }
  }

  /** M3b:ws.ts Orchestrator 需要知道 agentDir 路径 */
  getAgentDir(): string {
    return this.agentDir;
  }

  /** M3+ B1: 暴露底层 Pi session,供 Orchestrator llmCall 注入使用。
   *  makeLlmCall 用它直接 prompt 而不走 kernel.prompt(避免 Communicator 递归)。
   *  返回 null 时表示 session 还没启动(Orchestrator 应抛错或 defer)。
   */
  getSession(): AgentSession | null {
    return this.session;
  }

  /**
   * M3+ B1: ws.ts makeLlmCall 需要 resolved Model 来跑 Planner/Executor 推理。
   * 返回 Model<any> 是为了与 pi-ai 泛型 API(completeSimple 等)兼容 — provider
   * api 类型在调用时由 pi-ai runtime dispatch,不需要 TS 端固定 TApi。
   */
  getModel(): Model<any> | null {
    return this.model;
  }

  /**
   * 批次 4b B6(审查 §B6「明文 key 进 process.env」):当前 active provider 的
   * 明文 apiKey。
   *
   * 存在的理由:resolveModel 改成纯函数之后,凡是**不经 Pi session** 的 LLM 调用
   * (ws.ts makeLlmCall / decide 分类 / 回合后沉淀 / harness decide)都必须显式把
   * key 交给 `completeSimple(model, ctx, { apiKey })` —— pi-ai compat 的
   * withEnvApiKey 只在 options.apiKey 缺失时才回落 env,显式传参优先级更高。
   * 这些调用方统一经 kernel.getModel() 拿模型,配套经本方法拿 key,
   * 两处同源于 `activeProvider()`,不可能配错 provider。
   */
  getModelApiKey(): string | undefined {
    try {
      return this.settingsStore.activeProvider()?.apiKey || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 使当前 session 失效(不重建)。用于 settings 变更后:
   * 下一次 ensureStarted/prompt 会用新的 active provider 重新 start()。
   */
  invalidate(): void {
    if (this.session) {
      // S1(A7):退订 Pi listener(与 dispose() 清空 _eventListeners 双保险)。
      try { this.sessionUnsubscribe?.(); } catch { /* noop */ }
      this.sessionUnsubscribe = null;
      try {
        if (isStreaming(this.session) && this.session.isStreaming) this.session.abort();
        this.session.dispose?.();
      } catch (err) {
        log.warn("invalidate dispose failed:", err);
      }
      this.session = null;
      this.model = null;
      this.currentMessageId = null;
      this.toolStartAt.clear();
      this.buf = null;
      this.pendingUserText = null;
      this.currentTurnIndex = 0;
      log.info("kernel invalidated (settings changed) — will rebuild on next prompt");
    }
  }

  getConversationId(): string {
    return this.conversationId;
  }

  /** 当前 active provider / model 信息(供 ws ping 回报 ready) */
  activeInfo(): { provider: string; modelId: string } | null {
    if (this.model) return { provider: this.model.provider, modelId: this.model.id };
    const active = this.settingsStore.activeProvider();
    return active ? { provider: active.provider, modelId: active.modelId } : null;
  }

  /**
   * M3c: 初始化 Communicator + Bus(在 start() 末尾调用)。
   * Communicator 永远在线 → kernel 一启动就建好。
   */
  /**
   * 最近 3 条 user/assistant 消息(供 decide 与对齐闸门消歧省略句)。
   * 读库失败返回空数组 —— 消歧只是锦上添花,不能因此让 decide/闸门失效。
   */
  private recentTurns(
    conversationId: string,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    try {
      return listMessagesByConversation(this.storage.db, conversationId)
        .filter((m): m is typeof m & { role: "user" | "assistant" } =>
          m.role === "user" || m.role === "assistant")
        .slice(-3)
        .map((m) => ({ role: m.role, content: m.content ?? "" }));
    } catch {
      return [];
    }
  }

  private ensureCommunicator(): Communicator {    if (this.communicator) return this.communicator;
    const dataDir = process.env.SANSHENG_DATA ?? this.agentDir.replace(/\/pi$/, "");
    const harness = loadHarness(dataDir);
    const active = this.settingsStore.activeProvider();
    const settings: RunnerSettings = {
      provider: active?.provider ?? "fake",
      apiKey: active?.apiKey ?? "sk-fake",
      modelId: active?.modelId ?? "fake-model",
      thinkingLevel: active?.thinkingLevel ?? "off",
    };
    const comm = new Communicator({
      bus: this.bus,
      settings,
      agentDir: `${this.agentDir}/communicator`,
      cwd: this.cwd,
      systemPrompt: harness.systemPrompts.communicator, // undefined 让 DefaultResourceLoader 走 AGENTS.md 默认
      // kernel 层拿不到模型时(无 API key)降级为 disableLlm
      disableLlm: !active?.apiKey,
      // 批次 5b-1 P1:decide 升级 LLM 分类(微型 JSON prompt,completeSimple 同款
      // makeLlmCall 模式)。无模型 / SANSHENG_DECIDE_LLM=0 / 超时 / 解析失败 →
      // 自动降级 defaultCommunicatorDecide 正则启发式(保留为 fallback,不删)。
      // recentHistory:最近 ≤3 条消息(每条截断 80 字符,工厂内再截)——
      // 消歧「继续/再跑一次」类省略句;延迟代价可忽略。
      decideFn: makeLlmCommunicatorDecide({
        getModel: () => this.getModel(),
        // B6:显式传 apiKey 给 completeSimple,不再依赖 process.env 回落。
        getApiKey: () => this.getModelApiKey(),
        ...(this.opts.decideLlmCall ? { llmCall: this.opts.decideLlmCall } : {}),
        // 批次 7-G:harness system_prompts/communicator.decide.md;空 → 内置常量回退
        systemPrompt: harness.systemPrompts["communicator.decide"],
        recentHistory: (conversationId) => this.recentTurns(conversationId),
      }),
      // 批次 7-E:对齐闸门 —— decide 判 task 后、onTask 开工前再问一次
      // 「有没有你猜错就会返工的关键信息」。与 decide 分开成独立调用,
      // 因为 decide 在四选一 + 3.5s 硬超时下稳定偏向 task(实测从不 clarify)。
      // 闸门自身失败一律放行(见 makeAlignmentCheck),不会卡住用户任务。
      // 测试可注入 alignLlmCall;不注入走生产 completeSimple。
      alignmentCheck: makeAlignmentCheck({
        getModel: () => this.getModel(),
        getApiKey: () => this.getModelApiKey(),
        ...(this.opts.alignLlmCall ? { llmCall: this.opts.alignLlmCall } : {}),
        // 批次 7-G:harness system_prompts/communicator.align.md;空 → 内置常量回退
        systemPrompt: harness.systemPrompts["communicator.align"],
        // 闸门也要看最近对话 —— 否则它会把自己上一轮问过、用户已答的问题
        // 再问一遍,陷入无限澄清循环(7-E 集成测试实测抓到)。
        recentHistory: (conversationId) => this.recentTurns(conversationId),
      }),
    });
    // M3+ B4: 若 ws 层先调 setOnTask(此时 Communicator 尚未构造),
    // pending 引用在这里应用;否则保持 undefined。
    if (this._pendingOnTask) {
      comm.setOnTask(this._pendingOnTask);
      this._pendingOnTask = undefined;
    }
    // bus 订阅:每条新 BusMessage → emit 多播(bus_event)+ 落 jsonl。
    // S1(A7):用 this.emit 而非捕获 sink —— 订阅只建立一次,连接增减靠 attachSink/detach,
    // 事件永远发给当前活连接(旧代码这里捕获首个连接的 sink,重连后永久进死 socket)。
    if (!this.busUnsubscribe) {
      this.busUnsubscribe = this.bus.subscribe((msg) => {
        this.emit({ type: "bus_event", message: msg });
        void appendBusMessage(dataDir, msg.conversationId, msg);
      });
    }
    this.communicator = comm;
    return comm;
  }

  /**
   * M3c:ws 层调这个把用户回答喂给挂起的 questionId。
   */
  answerPendingQuestion(questionId: string, payload: string): boolean {
    if (!this.communicator) return false;
    return this.communicator.answerPending(questionId, payload);
  }

  /**
   * M3+ B3/B5: 把 user 回答路由回 Orchestrator。
   * - bus.reply 清理 Communicator 内部 pending
   * - 反查 questionId → executorSessionId;若找到 → 写 decision artifact + publish executor_resume
   * 返回 {replied, resumed?}。resumed 不为空表示已经触发了 Executor 恢复。
   */
  handleUserAnswer(
    questionId: string,
    payload: string,
    conversationId: string,
  ): { replied: boolean; resumed?: { executorSessionId: string; decisionArtifactId: string } } {
    const replied = this.answerPendingQuestion(questionId, payload);
    const executorSessionId = this.pendingExecutorCallbacks.get(questionId);
    if (!executorSessionId) {
      return { replied };
    }
    this.pendingExecutorCallbacks.delete(questionId);
    // 写 decision artifact + publish executor_resume
    const decision = makeArtifact({
      kind: "decision",
      title: `User decision for ${questionId.slice(0, 8)}`,
      body: payload,
      scope: "conversation",
      conversationId,
      author: "communicator",
      status: "open",
    });
    try {
      upsertArtifact(this.storage.db, decision);
    } catch (err) {
      // 批次 UI U4(审查 §B8 遗留,4b 备案未做):落库失败即 fail-closed。
      // 旧实现只 warn 就继续 publish —— decision 没进库却广播
      // artifact_created + executor_resume,Orchestrator 按 decisionArtifactId
      // 回查拿不到用户刚做的决定(§A4 修的正是这条路),审计面还在撒谎
      // 「这个 decision 存在」。宁可 executor 继续等 watchdog,也不发悬空 id。
      log.warn(
        `handleUserAnswer: upsertArtifact failed, not publishing executor_resume: ${(err as Error).message ?? err}`,
      );
      return { replied };
    }
    artifactBus.publish({ type: "artifact_created", artifact: decision });
    artifactBus.publish({
      type: "executor_resume",
      executorSessionId,
      decisionArtifactId: decision.id,
    });
    return { replied, resumed: { executorSessionId, decisionArtifactId: decision.id } };
  }

  /**
   * M3c:ws 层调这个取消一个挂起的 question。
   *
   * 批次 4b B9(审查 §B9「cancel_question 对 executor 回调问题完全无效」):
   * 旧实现只有 `communicator.cancelPending(id)` 一条路,而 executor 升级出来的
   * 提问(`q-exec-*`)根本不在 MessageBus.pending 里 —— `bus.reply` 走到
   * 「no pending question」返回 false。用户点「取消」表面无报错,实际
   * waiting / watchdog / pendingExecutorCallbacks 一个都不清,todo 挂满 1 小时
   * failTimer。现在分三条路:
   *  1) **executor 提问**(pendingExecutorCallbacks 里有):清两张表 + 向
   *     artifactBus 发 `executor_cancel` → Orchestrator 收到后 clearWaiting +
   *     failTodo(带 reason),run 立刻闭环;
   *  2) 普通提问(Communicator 直接问用户):走原 bus.reply 路径,语义不变;
   *  3) 谁都不是 → false,不伪造成功(可重复调用,第二次必 false)。
   */
  cancelPendingQuestion(questionId: string): boolean {
    const executorSessionId = this.pendingExecutorCallbacks.get(questionId);
    if (executorSessionId) {
      this.pendingExecutorCallbacks.delete(questionId);
      this.pendingQuestions.delete(questionId);
      artifactBus.publish({
        type: "executor_cancel",
        executorSessionId,
        reason: "user cancelled the executor question (no decision was given)",
      });
      return true;
    }
    if (!this.communicator) return false;
    return this.communicator.cancelPending(questionId);
  }

  /**
   * M3+ B4: 设置 Communicator.task 触发 callback。
   * ws 层每个 connection 调用一次(runPlan 闭包依赖 connection-local state)。
   * kernel 层只做转发 — 不会验证 callback 签名(允许 undefined 以解绑)。
   * 若 Communicator 尚未构造,缓存到 _pendingOnTask,待 ensureCommunicator() 时绑定。
   */
  setOnTask(cb: ((input: { goal: string; conversationId: string }) => void) | undefined): void {
    if (this.communicator) {
      this.communicator.setOnTask(cb);
      return;
    }
    this._pendingOnTask = cb;
  }
  private _pendingOnTask: ((input: { goal: string; conversationId: string }) => void) | undefined = undefined;

  /**
   * 批次 4b B5(审查 §B5「/api/reset 后 server 变僵尸 + 密钥丢失链」):
   * 数据重置前置钩子。
   *
   * 为什么需要:reset 会删掉 sansheng.db / pi 目录,此刻**本进程内**仍可能有
   *  - 在跑的 plan(ws.ts attach 级 activeOrchestrator;退订/abort 逻辑在 ws 层);
   *  - 在飞的 chat 回合(Pi session + 模型句柄);
   *  - 挂起的 executor 提问(pendingExecutorCallbacks / pendingQuestions)。
   * 不先停掉它们,它们会在数据被删之后继续烧 token 并写库(写到刚重建的空库),
   * 或者永远挂着(提问的 watchdog 要等 1 小时)。
   *
   * 设计:与 setOnTask 同款的 attach 级桥接 —— ws.ts 持有 activeOrchestrator,
   * kernel 不知道它的存在,故由 ws.ts 注册一个回调,由 kernel 在数据重置时触发。
   */
  setOnDataReset(cb: (() => void) | undefined): void {
    this._onDataReset = cb;
  }
  private _onDataReset: (() => void) | undefined = undefined;

  /**
   * B5:数据重置前的进程内收尾(不碰磁盘,由 /api/reset 调用)。
   * 1. 触发 attach 级钩子(ws.ts → activeOrchestrator.abort():退订 bus + abort
   *    在飞 executor + 清 watchdog,run() 以 "Orchestrator aborted" 收尾);
   * 2. 清 kernel 自己的挂起态(pendingExecutorCallbacks / pendingQuestions)——
   *    这些 question id 在新库/新会话里毫无意义,留着会让用户点「回答」时
   *    触发一条指向已删除 todo 的 executor_resume;
   * 3. invalidate() 丢弃 Pi session 与 model 句柄 —— 释放旧会话文件句柄,
   *    也顺带丢掉内存里那份明文 apiKey;下一次 prompt 走惰性 start,
   *    重新从(未被删除的)settings.json 解析。
   *
   * 幂等:重复调用安全。
   */
  prepareForDataReset(): void {
    log.warn("kernel: preparing for data reset (stopping in-flight session + pending questions)");
    try {
      this._onDataReset?.();
    } catch (err) {
      log.warn("kernel: data-reset hook threw (continuing):", err);
    }
    this.pendingExecutorCallbacks.clear();
    this.pendingQuestions.clear();
    this.invalidate();
  }

  /**
   * 批次 4a C8(审查 §C8「resume/prompt 并发无互斥 → 孤儿 Pi session」):
   * session 生命周期 FIFO 串行链。
   *
   * 互斥方案论证(选「串行队列」而非「in-flight promise 复用」):
   *  1. 受损面不止 resume∥resume:ws.ts 的 load_conversation 与 send 两条链
   *     (ensureStarted→start / resume / prompt)加 reset/newConversation/restart
   *     共 6 个入口都会覆写 this.session,in-flight 复用需要按操作种类做去重键,
   *     复杂且「复用哪个 promise」语义含糊(resume(c1) 与 resume(c2) 不可复用);
   *  2. Pi session 本身单回合并发(concurrent prompt → "Agent is already
   *     processing"),旧代码 isIdle 50ms×100 轮询等 idle 正是串行化的脆弱版;
   *     FIFO 把「等 idle」升级为「等上一操作完整结束」,语义完备:prompt 排在
   *     resume 之后 → 消息不再打进正在 dispose 的 session,也不丢;
   *  3. 顺序即到达序:同 tick 并发的多条链按调用序执行,末次 resume 生效
   *     (与旧「最后覆写者赢」的可见结果一致,但不再有中间态孤儿);
   *  4. abort()/invalidate() 保持同步直调**不入队** —— 中断语义必须即时,
   *     且 abort 会让排队的长 prompt 尽快 settle,队列不阻塞「解卡」路径
   *     (reset 排在长回合后会等待该回合结束;真卡死用 interrupt 先 abort);
   *  5. 无自死锁:队列内互调一律走 *Inner(promptInner→startInner、
   *     resetInner→startInner、restartInner→startInner),不重复入队。
   *
   * 链延续:opChain 恒为「已吞错」的 promise(每个操作的 rejection 由调用方
   * 的返回值承接),前序失败不阻断后续操作。
   */
  private opChain: Promise<unknown> = Promise.resolve();

  private enqueueOp<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opChain.then(op, op);
    this.opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * M3+ B3/B5: 由 Orchestrator.routeCallback 注入调入。
   * 0. 批次 4b B9:先把合成 question 记进 MessageBus stream(**在 communicator
   *    就绪检查之前** —— 审计流记的是「executor 提了这个问题」这个事实,
   *    不该因为下游 UI 通道没就绪就丢记录)。
   * 1. 合成 BusMessage(kind="question")—— Executor 暂无 bus.ask 路径。
   * 2. 存 questionId → executorSessionId。
   * 3. Communicator.handleWorkerAsk(knowIt=false) → 发出 pending_question sink 事件
   *    (CommunicatorSink → EventSink 翻译:在这里做)。
   */
  async handleExecutorCallback(
    arg: {
      todoId: string;
      reason: "judgment" | "harness_proposal";
      hypothesisId: string;
      executorSessionId: string;
    },
    conversationId: string,
  ): Promise<void> {
    const id = `q-exec-${nanoid(8)}`;
    const msg: BusMessage = {
      id,
      ts: Date.now(),
      direction: "worker→comm",
      fromRole: "executor",
      toRole: "communicator",
      conversationId,
      kind: "question",
      payload: `Executor needs help (${arg.reason}) for todo ${arg.todoId.slice(0, 8)}`,
      context: {
        todoId: arg.todoId,
        hypothesisId: arg.hypothesisId,
        executorSessionId: arg.executorSessionId,
        reason: arg.reason,
      },
    };
    // B9(审查 §B9「合成 question 不进 MessageBus」):把合成 question 记进 bus
    // stream —— 旧实现直接手搓 BusMessage 传给 handleWorkerAsk,绕过整个 bus,
    // 于是 snapshot/bus.jsonl/ws 的 bus_event 全都没有它(timeline 与 bus_replay
    // 看不到 executor 提问,审计缺口,违背 PLAN.md 的 bus 审计设计)。
    // 走 recordExternal(而非 bus.ask):ask() 会建一个 300s 超时的 pending,但
    // executor 提问真正的等待方是 Orchestrator 的 watchdog(escalationMs/failMs,
    // 与 bus 的 300s 无关)—— 建第二个 pending 等于多一个各管各的超时源。
    // recordExternal 只记流 + 通知 listeners(→ ws bus_event + busPersister 落盘)。
    this.bus.recordExternal(msg);

    if (!this.communicator) {
      log.warn("handleExecutorCallback: communicator not ready, dropping escalation UI");
      return;
    }
    this.pendingExecutorCallbacks.set(id, arg.executorSessionId);
    // CommunicatorSink → EventSink 翻译(只为 pending_question 感兴趣)。
    // S1(A7):经 this.emit 多播到当前活连接,不再捕获调用方传入的单连接 sink。
    const commSink: CommunicatorSink = (e) => {
      if (e.type === "pending_question") {
        this.pendingQuestions.set(e.questionId, conversationId);
        this.emit({
          type: "pending_question",
          conversationId,
          questionId: e.questionId,
          payload: e.payload,
          fromRole: e.fromRole,
        });
      }
      // 其他 CommunicatorEvent 在 callback 路径下不暴露给 ws(避免噪音)
    };
    try {
      await this.communicator.handleWorkerAsk(msg, /* knowIt */ false, "", commSink);
    } catch (err) {
      log.warn(`handleExecutorCallback: handleWorkerAsk threw: ${(err as Error).message ?? err}`);
      // 出错时清掉 pending,避免悬挂
      this.pendingExecutorCallbacks.delete(id);
    }
  }

  /** M3c:ws 层调这个从 jsonl 重放 bus 流(给浏览器的 timeline)。 */
  async replayBus(conversationId: string, fromTs: number): Promise<BusMessage[]> {
    const dataDir = process.env.SANSHENG_DATA ?? this.agentDir.replace(/\/pi$/, "");
    const all = await loadBusMessages(dataDir, conversationId);
    return all.filter((m) => m.ts >= fromTs);
  }

  /** 拿到当前 kernel 的 bus(供 ws 层 / 测试用)。 */
  getBus(): MessageBus {
    return this.bus;
  }

  /** 拿到当前 kernel 的 Communicator。 */
  getCommunicator(): Communicator | null {
    return this.communicator;
  }

  /** 用当前 Settings 的 active provider 创建或重建 Session;Settings 变更后调用。
   *  S1(A7):不再接受 sink —— 事件经 this.emit 多播到 attachSink 的所有活连接。
   *  C8:入 FIFO 串行链(并发 start 由 `if (this.session) return` 天然去重)。 */
  async start(): Promise<void> {
    return this.enqueueOp(() => this.startInner());
  }

  private async startInner(): Promise<void> {
    if (this.session) return; // already started
    this.settings = this.settingsStore.load();
    const active = this.settingsStore.activeProvider();
    if (!active) {
      const msg = "尚未配置任何 provider;请到「设置」添加一个";
      this.emit({ type: "error", conversationId: this.conversationId, error: { code: "no_provider", message: msg } });
      throw new Error(msg);
    }
    const m = await this.resolveActiveModel(active);
    this.model = m;
    log.info(`kernel start: provider=${active.provider} model=${active.modelId} cwd=${this.cwd}`);

    const session = await this.createPiSession(m, active);
    this.session = session;

    // 等 session 真正 idle 后再 emit ready;createAgentSession() 返回时
    // Pi SDK 还在做内部初始化(tool 注册 / system prompt 构建),此时 prompt() 会拋
    // "Agent is already processing"。等 isIdle=true 才安全。
    await this.waitSessionIdle(session);

    this.emit({
      type: "ready",
      conversationId: this.conversationId,
      modelId: this.model?.id ?? active.modelId,
      provider: this.model?.provider ?? active.provider,
    });

    // M2:持久化当前会话元数据(以便历史列表 / API 能列出)
    try {
      upsertConversation(this.storage.db, {
        id: this.conversationId,
        cwd: this.cwd,
        modelId: this.model?.id ?? active.modelId,
        provider: this.model?.provider ?? active.provider,
      });
    } catch (err) {
      log.warn("storage: upsertConversation failed:", err);
    }

    // S1(A7):Pi subscribe 每个 session 恰好一次 —— handler 走 this.emit 动态多播,
    // 保存 unsubscribe 供 dispose 路径调用;连接增减永不重新 subscribe。
    this.sessionUnsubscribe = this.session.subscribe(this.makeHandler());
    // M3c: 初始化 Communicator + bus(走非 LLM fallback 时 no-op)
    try {
      this.ensureCommunicator();
    } catch (err) {
      log.warn("kernel: ensureCommunicator failed:", err);
    }
  }

  /**
   * M3a: 恢复一个已存在的对话
   *
   * 策略(简化):
   * - 切换 conversationId + 释放旧 session
   * - 用当前 active provider 重建 Pi session(metadata 接续)
   * - 把 agent_states 行写好(cwd/model/provider/lastActiveAt + state_json={historyCount})
   * - emit ready 让前端把 kernelReady 恢复
   *
   * Sansheng 这边不在 Pi session 里重放 messages(那是 SDK 内部 session file 的事)。
   * UI 侧 loadConversation() 已经负责把历史 messages 渲染;新 turn 用新会话上下文开始。
   *
   * C8:入 FIFO 串行链(与 start/prompt/reset 互斥,杜绝并发覆写 this.session)。
   */
  async resume(conversationId: string): Promise<void> {
    return this.enqueueOp(() => this.resumeInner(conversationId));
  }

  /**
   * 批次 6 P3:会话级 cwd 的 legacy 映射。
   *
   * `conversations.cwd` 是**会话级覆盖**,在旧出厂默认($HOME)期间被写成 `"/Users/fuyao"`。
   * 批次 6 只迁了 settings 侧(存量迁移在 load 期),已经落库的会话行里的 $HOME 还在 ——
   * 继续 `conv.cwd ?? this.cwd` 就会让 resume 老会话把 agent 拖回整个家目录,等于迁移
   * 白做。所以:空值 **或 恰好等于旧默认** → 继承 this.cwd(= createApp 注入的 settings.cwd)。
   *
   * 判据复用 store 的 isLegacyDefaultCwd(严格相等;唯一真相,不在此硬编码 "$HOME"),
   * 用户显式设过的其它目录原样保留。
   *
   * **不加写**:映射只在读侧发生,不额外 UPDATE 数据库。历史 $HOME 行由 resume 末尾
   * 两条既有 upsert 顺带治愈(写进去的已是映射后的 cwd),没有必要在热路径上再打一次
   * 写 —— 一次 resume 多一次 DB 写,收益只是把「下次读也正确」提前到「本次读也正确」,
   * 而读侧映射已经把本次读修好了。
   */
  private effectiveConvCwd(convCwd: string | null): string {
    if (!convCwd) return this.cwd;
    return isLegacyDefaultCwd(convCwd) ? this.cwd : convCwd;
  }

  private async resumeInner(conversationId: string): Promise<void> {
    log.muted(`kernel resume: ${conversationId}`);
    // C8:无条件释放旧 session —— 旧实现仅在**换会话**时 dispose,同 id 重复
    // resume(ws send/load_conversation 竞态下会发生)会直接覆写 this.session,
    // 旧 session 仍持监听器却再无人引用 = 孤儿。resume 语义本就是「重建」,
    // 无论目标会话是否相同,旧 session 都必须先退场。
    this.disposeSession();
    this.conversationId = conversationId;
    this.buf = null;
    this.pendingUserText = null;
    this.currentTurnIndex = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.kernelStartedAt = Date.now();

    const conv = getConversation(this.storage.db, conversationId);
    if (!conv) {
      const msg = `conversation ${conversationId} 不存在`;
      this.emit({ type: "error", conversationId: this.conversationId, error: { code: "not_found", message: msg } });
      throw new Error(msg);
    }

    // 从 DB 拉历史 messages(用于 state_json metadata,不在此重放给 Pi)
    const history = listMessagesByConversation(this.storage.db, conversationId);

    this.settings = this.settingsStore.load();
    const active = this.settingsStore.activeProvider();
    if (!active) {
      const msg = "尚未配置任何 provider;请到「设置」填写";
      this.emit({ type: "error", conversationId: this.conversationId, error: { code: "no_provider", message: msg } });
      throw new Error(msg);
    }
    const m = await this.resolveActiveModel(active);
    this.model = m;

    const session = await this.createPiSession(m, active);
    this.session = session;
    await this.waitSessionIdle(session);

    // M3a:写 agent_states metadata(用于 inspector / 调试 / 后续 reload)
    try {
      // 批次 6 P3:legacy $HOME 会话行不能继续当工作根(见 effectiveConvCwd)
      const convCwd = this.effectiveConvCwd(conv.cwd);
      upsertAgentState(this.storage.db, {
        conversationId,
        cwd: convCwd,
        modelId: conv.modelId ?? active.modelId,
        provider: conv.provider ?? active.provider,
        stateJson: JSON.stringify({ historyCount: history.length, resumedAt: Date.now() }),
        lastActiveAt: Date.now(),
      });
      // 同步 conversations 行的 last_active_at / message_count
      // (cwd 非 null → COALESCE 取新值,历史 $HOME 行在这里被顺带治愈)
      upsertConversation(this.storage.db, {
        id: conversationId,
        cwd: convCwd,
        modelId: conv.modelId ?? active.modelId,
        provider: conv.provider ?? active.provider,
      });
    } catch (err) {
      log.warn("resume: persist agent_state failed:", err);
    }

    this.emit({
      type: "ready",
      conversationId: this.conversationId,
      modelId: this.model?.id ?? active.modelId,
      provider: this.model?.provider ?? active.provider,
    });

    // S1(A7):新 session 恰好 subscribe 一次;handler 走 this.emit 动态多播。
    // disposeSession() 已在上方退订旧 session 的 listener(若换了会话)。
    this.sessionUnsubscribe = this.session.subscribe(this.makeHandler());
    log.info(`kernel resumed: ${conversationId} (history=${history.length})`);
  }

  /** 释放当前 Pi session 但保留 agent_states。供 resume() / invalidate() 复用。 */
  private disposeSession(): void {
    if (this.session) {
      // S1(A7):退订本 session 的 Pi listener(与 SDK dispose() 清空 _eventListeners 双保险)。
      try { this.sessionUnsubscribe?.(); } catch { /* noop */ }
      this.sessionUnsubscribe = null;
      try {
        if (isStreaming(this.session) && this.session.isStreaming) {
          try { this.session.abort(); } catch { /* noop */ }
        }
        this.session.dispose?.();
      } catch (err) {
        log.warn("disposeSession failed:", err);
      }
      this.session = null;
      this.model = null;
      this.currentMessageId = null;
      this.toolStartAt.clear();
      this.buf = null;
      this.pendingUserText = null;
      this.lastUserRawText = null;
      this.currentTurnIndex = 0;
      this.kernelStartedAt = Date.now();
    }
  }

  /** 用 active provider 解析 Pi Model;失败时 emit error + throw。 */
  private async resolveActiveModel(active: ProviderConfig): Promise<Model<any>> {
    const m = resolveModel({
      provider: active.provider,
      modelId: active.modelId,
      apiKey: active.apiKey,
      baseUrl: active.baseUrl,
    });
    if (!m) {
      const noKey = !active.apiKey;
      const code = noKey ? "no_api_key" : "no_model";
      const msg = noKey
        ? `provider=${active.provider} 需要 API Key;请到「设置」填写`
        : `model ${active.provider}/${active.modelId} 不可用;请检查 provider/model 拼写`;
      this.emit({ type: "error", conversationId: this.conversationId, error: { code, message: msg } });
      throw new Error(msg);
    }
    return m;
  }

  /**
   * 用 Pi SDK 创建 session,带 8s 硬超时防 ModelRuntime 卡死。
   *
   * 批次 5a.5 T2(5a open question #1):直答 session 消费
   * harness/system_prompts/communicator.md —— 此前 harness prompt 只注入
   * Communicator 类构造 opts(ensureSession 无生产调用方),直答 session 走
   * Pi DefaultResourceLoader 默认路径,「落地了但没人读」。
   *
   * 注入点:createAgentSession({ resourceLoader }) —
   * DefaultResourceLoader.appendSystemPromptOverride 把 harness prompt 追加在
   * SDK 默认 prompt 之后(system-prompt.js 渲染为 <addendum> 段,保留默认
   * preamble/tools/rules = append 语义,不整体替换);用 Override 而非
   * appendSystemPrompt 选项,保留 SDK 对 agentDir 内 append 文件的自身发现。
   *
   * 时效:每次 start()/resume()/reset() 重建 session 都重新 loadHarness →
   * 用户编辑 md 后重建即生效。harness prompt 为空/空白 → 不传 resourceLoader,
   * 完全走 SDK 默认路径(不注入空段,要求③)。
   */
  private async createPiSession(m: Model<any>, active: ProviderConfig): Promise<AgentSession> {
    // dataDir 派生与 ensureCommunicator()/replayBus() 同一表达式
    const dataDir = process.env.SANSHENG_DATA ?? this.agentDir.replace(/\/pi$/, "");
    // 一次读盘拿两样:prompt + 工具集合(同源同生命周期,见 harness/tools.ts)
    const harness = loadHarness(dataDir);
    const harnessPrompt = harness.systemPrompts.communicator;
    // 批次 7-E:白名单从硬编码字面量换成 harness 工具集合。
    // 批次 5b-1 P3(沟通员限权,机制层)仍然成立 —— 它现在由 tools.ts 的
    // ROLE_CEILING.communicator = 只读面承载,集合文件**突破不了**:
    // 用户往 harness/tools/communicator.json 里写 "bash" 会被解析器拒绝并
    // 记进 blockedByCeiling,而不是放行。放开写/执行是改 ROLE_CEILING 的
    // 代码动作(架构决策),不是改 JSON。
    // SDK 语义(CreateAgentSessionOptions.tools allowlist):提供时 builtin/
    // extension/custom 工具统一按名单过滤,且只有名单内工具被激活
    // (agent-session.js _refreshToolRegistry isAllowedTool)→ 机制级硬约束,
    // 不依赖 prompt 自觉。只限沟通员直答 session;Executor(plan 链路)
    // 走 llmCall 单轮补全,不经 Pi session,工具面零影响(enforced:false)。
    const communicatorTools = harness.toolSets.communicator;
    for (const w of communicatorTools.warnings) {
      log.warn(`kernel: harness/tools/communicator.json — ${w}`);
    }
    // B6(审查 §B6「明文 key 进 process.env」):这是全仓**唯一**需要把 active
    // provider 的 key 写进 process.env 的地方 —— Pi SDK 的 ModelRuntime 在
    // Sansheng 的配置形态下(不写 agentDir/auth.json)从 env 取凭据,而且
    // session 的工具执行会 spawn 子进程并继承 env。旧实现在 resolveModel 里
    // 无条件写 env,导致每次解析模型(连 decide / 沉淀这种单轮补全都算)都往
    // env 里塞一份,而且切 provider 之后旧 key 永不删除。
    // 现在收敛成「建 session 前一次性同步 active provider + 清掉上一次的」。
    syncActiveProviderApiKeyEnv(active.provider, active.apiKey);
    // 把 sansheng 自有工具搬进 session,两组数据源不同所以两个模块:
    //   7-F toolBridge  → 6 个 sandbox 工具(canvas_*/net_*),背后是
    //                     ToolRegistry + Sandbox / NetSandbox
    //   7-H nativeTools → 3 个 Blackboard / 记忆工具(board_*/memory_search),
    //                     背后是 Storage —— **任何 SDK 工具都够不着它们**
    // **这里不按 allowlist 过滤** —— SDK 的 isAllowedTool 会对 customTools 与
    // builtin 统一过滤(与 tools allowlist 同一套机制),所以下面的 `tools:`
    // 一行就是唯一的授权裁决点。
    // 桥接失败(policy 文件损坏)→ 返回空数组 + warn,只暴露 SDK 内置工具,
    // 绝不静默放宽授权面。
    const bridgedTools = [...(await createBridgedTools()), ...buildNativeTools(this.storage)];
    const createPromise = (async () => {
      let resourceLoader: DefaultResourceLoader | undefined;
      if (harnessPrompt.trim()) {
        resourceLoader = new DefaultResourceLoader({
          cwd: this.cwd,
          agentDir: this.agentDir,
          appendSystemPromptOverride: (base) => [...base, harnessPrompt],
        });
        // 外部传入 resourceLoader 时 sdk.js 不再代为 reload(只 reload 它自建的)
        // → 必须显式 reload;放进 race 的 promise 内,沿用 8s 超时保护。
        await resourceLoader.reload();
      }
      return createAgentSession({
        model: m,
        cwd: this.cwd,
        agentDir: this.agentDir,
        thinkingLevel: active.thinkingLevel,
        tools: communicatorTools.allowed,
        ...(bridgedTools.length > 0 ? { customTools: bridgedTools } : {}),
        ...(resourceLoader ? { resourceLoader } : {}),
      });
    })();
    // C8(审查 §C8):超时路径三修 ——
    //  1) 阈值可配(this.opts.createSessionTimeoutMs,生产缺省 8000):旧硬编码
    //     8s 让超时分支不可测(测试要么等 8s 要么根本不覆盖);
    //  2) 成功/失败都 clearTimeout:旧实现 start 成功后 8s 定时器仍白挂,
    //     反复 start/restart 会累积挂住 event loop 的空定时器;
    //  3) 迟到成功者孤儿处置:超时 reject 后 createPromise 仍在后台跑,
    //     完成即产出一个无人接收的 session(持文件句柄/监听器永不释放)。
    //     给它挂尾巴处理器:一产出立即 dispose。
    const timeoutMs = this.opts.createSessionTimeoutMs ?? 8000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`createAgentSession timeout (${timeoutMs}ms) — ModelRuntime refresh hung?`)),
        timeoutMs,
      );
    });
    try {
      const { session } = await Promise.race([createPromise, timeoutPromise]);
      return session;
    } catch (err) {
      void createPromise.then(
        (late) => {
          log.warn("kernel: createAgentSession resolved after timeout — disposing orphan session");
          try {
            late.session.dispose?.();
          } catch { /* noop */ }
        },
        () => { /* 迟到失败:race 已把首个错误上抛,此处静默 */ },
      );
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 等 Pi session 真正 idle(最多 5s) */
  private async waitSessionIdle(session: AgentSession): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (session.isIdle) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * 新建会话:丢弃当前 session,生成新 conversationId,重置计数。
   * 下一次 prompt 会重新 start()。M2 持久化后这里会先归档旧会话。
   * C8:入 FIFO 串行链(与 resume/prompt 互斥)。
   */
  async newConversation(): Promise<string> {
    return this.enqueueOp(() => this.newConversationInner());
  }

  private async newConversationInner(): Promise<string> {
    if (this.session) {
      try { this.sessionUnsubscribe?.(); } catch { /* noop */ }
      this.sessionUnsubscribe = null;
      try {
        if (isStreaming(this.session) && this.session.isStreaming) this.session.abort();
        this.session.dispose?.();
      } catch (err) {
        log.warn("dispose on newConversation failed:", err);
      }
      this.session = null;
    }
    this.model = null;
    this.currentMessageId = null;
    this.toolStartAt.clear();
    this.inputTokens = 0;
    this.outputTokens = 0;
    // M2:清掉上一次的 buffer / pending user text
    this.buf = null;
    this.pendingUserText = null;
    this.lastUserRawText = null;
    this.currentTurnIndex = 0;
    this.conversationId = `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    log.info(`new conversation: ${this.conversationId}`);
    this.emit({ type: "conversation_reset", conversationId: this.conversationId });
    return this.conversationId;
  }

  /**
   * 强制重置 kernel(用于 stuck 状态恢复)。
   * - 如果 session 还在 streaming,先 abort
   * - dispose 旧 session,清掉内部状态
   * - 下次 prompt 会重新 start()
   * C8:入 FIFO 串行链。语义变化:reset 排在进行中的长回合之后执行(旧实现
   * 与 prompt 链并发 dispose);真「卡死」场景先 interrupt(abort 同步直调不入队)
   * 让当前回合 settle,reset 随即执行。
   */
  async reset(): Promise<void> {
    return this.enqueueOp(() => this.resetInner());
  }

  private async resetInner(): Promise<void> {
    log.warn("kernel reset requested");
    if (this.session) {
      try { this.sessionUnsubscribe?.(); } catch { /* noop */ }
      this.sessionUnsubscribe = null;
      try {
        if (isStreaming(this.session) && this.session.isStreaming) {
          try { this.session.abort(); } catch {}
          await new Promise((r) => setTimeout(r, 500));
        }
        this.session.dispose?.();
      } catch (err) {
        log.warn("session dispose failed:", err);
      }
      this.session = null;
      this.model = null;
      this.currentMessageId = null;
      this.toolStartAt.clear();
    }
    this.emit({ type: "interrupt", conversationId: this.conversationId });
    await this.startInner(); // C8:直调 Inner(已在串行链内)
  }

  /**
   * 批次 5a.5 T1(docs/CODE-REVIEW-2026-10-01.md §B1):raw/enriched 分离。
   * - `text` 是用户原文(raw):落 sansheng messages 表(见 pendingUserText →
   *   message_start(user) handler)、喂 Communicator decide、生成会话标题。
   * - `opts.contextBlock` 是 ws 层构建的记忆富集段(fragment/profile):只拼给
   *   Pi session(`contextBlock + "\n\n---\n\nUser: " + text`,进 Pi JSONL 会话
   *   历史,用户不可见)—— 旧实现把拼接后的 enriched 全文落库,UI 历史里用户
   *   消息变成「# Relevant Memories…---User: 你好」blob。
   * 其它调用方不带 contextBlock 即可,行为与旧签名一致。
   */
  async prompt(text: string, opts?: { contextBlock?: string }): Promise<void> {
    return this.enqueueOp(() => this.promptInner(text, opts));
  }

  private async promptInner(text: string, opts?: { contextBlock?: string }): Promise<void> {
    // S1(A7):不再接受 sink 覆盖 —— 事件统一走 this.emit 多播到 attachSink 的活连接。
    // sink 为空时假设 kernel 已 start(常规路径:ws.ts 先 ensureStarted)。
    // C8:本方法体运行于 FIFO 串行链内(与 start/resume/reset 互斥)——
    // ws send 排在 load_conversation 的 resume 之后执行,消息不再打进
    // 正在被 dispose 的 session;链内互调一律走 *Inner 防自死锁。
    if (!this.session) {
      // 还没 start 过(用户改了 settings 后第一次发,或 ensureStarted 失败后的 fallback):
      // 触发一次 lazy start。start 可能 fail(如没 provider),它会 emit 错误再 throw。
      // 这里吞掉 throw,让后续 Communicator / fallback 路径仍能尝试(M3c + PI_OFFLINE 场景)。
      try {
        await this.startInner(); // C8:直调 Inner(已在串行链内,再入队会自死锁)
      } catch (err) {
        log.warn("kernel: lazy start failed (continuing to communicator):", (err as Error).message ?? err);
      }
    }

    // M3c: 先过 Communicator → decide(chat/task/feedback)
    try {
      this.ensureCommunicator();
    } catch (err) {
      log.warn("kernel: ensureCommunicator failed:", err);
    }
    const comm = this.communicator;
    // 批次 5b-1 P2:task/feedback 的交接/收录确认 = 合成 assistant turn。
    // Communicator 的 delta/done 旧代码在本层被丢弃(确认对 WS 用户不可见);
    // 现在翻译成完整 turn 事件序列(agent_start→turn_start→message_start→delta→
    // message_end→agent_end),是用户可见的**唯一一条**确认,且在 onTask→runPlan
    // 之前发出 —— plan 链路的失败错误(no_api_key 等)最后到达,前端 error
    // banner 不会被后到的 turn_start 清掉。
    let ackTurn: { messageId: string; texts: string[] } | null = null;
    let ackFinal: { messageId: string; text: string } | null = null;
    const closeAckTurn = (): void => {
      if (!ackTurn) return;
      this.emit({
        type: "message_end",
        conversationId: this.conversationId,
        messageId: ackTurn.messageId,
        usage: { input: 0, output: 0 },
      });
      this.emit({
        type: "agent_end",
        conversationId: this.conversationId,
        ts: Date.now(),
        usage: { input: 0, output: 0, costUsd: 0 },
      });
      ackFinal = { messageId: ackTurn.messageId, text: ackTurn.texts.join("") };
      ackTurn = null;
    };
    let decision: CommunicatorDecision | null = null;
    if (comm) {
      try {
        decision = await comm.routeUserMessage(text, this.conversationId, (e) => {
          // Communicator → ServerEvent 翻译(经 this.emit 多播到活连接)
          switch (e.type) {
            case "thinking":
              this.emit({
                type: "communicator_thinking",
                conversationId: this.conversationId,
                status: e.status,
              });
              break;
            case "delta": {
              // 批次 5b-1 P2:确认文本 → 合成 turn(前端渲染依赖 turn_start 建 turn)
              if (!ackTurn) {
                const turnIndex = this.currentTurnIndex + 1;
                this.currentTurnIndex = turnIndex;
                this.emit({ type: "agent_start", conversationId: this.conversationId, ts: Date.now() });
                this.emit({ type: "turn_start", conversationId: this.conversationId, turnIndex, ts: Date.now() });
                this.emit({
                  type: "message_start",
                  conversationId: this.conversationId,
                  message: { role: "assistant", id: e.messageId },
                });
                ackTurn = { messageId: e.messageId, texts: [] };
              }
              ackTurn.texts.push(e.text);
              this.emit({
                type: "delta",
                conversationId: this.conversationId,
                messageId: e.messageId,
                text: e.text,
              });
              break;
            }
            case "done":
              if (ackTurn && ackTurn.messageId === e.messageId) closeAckTurn();
              break;
            case "bus_event":
              this.emit({ type: "bus_event", message: e.message });
              break;
            case "pending_question":
              // 升级用户
              this.pendingQuestions.set(e.questionId, this.conversationId);
              this.emit({
                type: "pending_question",
                conversationId: this.conversationId,
                questionId: e.questionId,
                payload: e.payload,
                fromRole: e.fromRole,
              });
              break;
            case "error":
              log.warn(`communicator ${e.code}: ${e.message}`);
              break;
            case "user_reply":
              // Communicator 的内部标记(delta/done 已经发了)
              break;
            case "artifact_created":
              this.emit({ type: "artifact_created", artifact: e.artifact });
              break;
            default: {
              const _exhaustive: never = e;
              void _exhaustive;
            }
          }
        });
        log.muted(
          `communicator decide: kind=${decision.kind} conv=${this.conversationId}`,
        );
      } catch (err) {
        log.warn("communicator routeUserMessage failed; falling back to direct Pi:", err);
      } finally {
        // 极端情况(decide 中途抛错、done 不到达):闭合合成 turn,防 UI 卡 streaming
        closeAckTurn();
      }
    }

    // 批次 5b-1 P2(§B2 双执行根治):task/feedback 不再落到 Pi session 直答。
    // - task:onTask→runPlan 已在 routeUserMessage 内触发(goal=LLM 提炼的
    //   taskGoal,降级=raw);用户可见回复只有上方交接确认一条,后续进展走
    //   plan 事件 / plan_done broadcast(批次 3 已保证跨连接可见)。
    // - feedback:收录确认即回复(P4 记忆入库在 persistHandoff 内)。
    // 无 session / 离线时本分支先于 offline_no_session return → task 不再与
    // plan 链路自己的 no_api_key 并列重复(5a.5 open#2 收编)。
    //
    // 批次 7-C:clarify 与 task/feedback 同属「不走 Pi 直答」的一类 ——
    // 问题的正文已由 Communicator.routeUserMessage 经 delta/done 合成 turn
    // 发出(ackFinal),用户已经看到。若不在此 return,会**再**掉进下面的
    // session.prompt(text) 让 Pi 把用户原话重新答一遍 → 用户看到
    // 「沟通员问了一个问题」+「Pi 自己回答了一遍需求」两条,正是 §B2 治过的
    // 双回复病。persistHandoff 负责把 raw 原文 + 这条问题落库,刷新后历史完整。
    if (
      decision &&
      (decision.kind === "task" ||
        decision.kind === "feedback" ||
        decision.kind === "clarify")
    ) {
      this.persistHandoff(text, ackFinal, decision);
      return;
    }

    // 保险:再 poll 一次 session.isIdle,避免极端情况(刚启动有隐式后台 prompt)
    if (this.session) {
      for (let i = 0; i < 100 && !this.session.isIdle; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // M2:buffer 起来,handler 在 message_start(role=user) 时落库
    this.pendingUserText = text;
    // 批次 5b-2 T1:沉淀副本(message_end 时与 assistant 回复一起喂沉淀服务)
    this.lastUserRawText = text;
    // M3c: 只有 session 存在时才回退 Pi session(PI_OFFLINE 场景下 kernel 无 session)。
    // B2(批次 5a,docs/CODE-REVIEW-2026-10-01.md §B2):chat 路径的 canned「已收到」
    // 占位 sink 已在 Communicator 侧移除 → 这里的 Pi 直答是 chat 的唯一回复(双回复已治)。
    // 批次 5b-1:task 双执行已在上方根治(decision.kind 分支提前 return),
    // 本段现在只服务 chat(或 decide 失败兜底)—— §B2 两个形态都已闭环。
    if (this.session) {
      // 批次 5a.5 T1:Pi session 收 enriched(记忆能力保留);messages 表已在
      // pendingUserText 处固定为 raw text(上方),两条路径彻底分离。
      const full = opts?.contextBlock
        ? `${opts.contextBlock}\n\n---\n\nUser: ${text}`
        : text;
      await this.session.prompt(full);
    } else {
      // 批次 5a.5 T3(5a open question #2):离线兜底 —— 5a 删除 canned「已收到」
      // 占位后,PI_OFFLINE / 未配置 provider(无 Pi session,含 disableLlm
      // Communicator 场景)时 chat 路径完全静默,用户以为服务挂了。
      // 复用 error 事件形态 = 前端 chat.ts 现有 case "error"(status:"error"
      // + banner)直接消费的最小方案,前端零改动;code=offline_no_session 与
      // start() 的内部诊断(no_provider/no_api_key)区分 —— 这是面向用户的
      // 「本条消息没有得到直答」结论。
      // 批次 5b-1:只对 chat 生效 —— task/feedback 已在上方 return(确认 +
      // plan 链路自己的错误),不再重复 emit(5a.5 open#2)。
      this.emit({
        type: "error",
        conversationId: this.conversationId,
        error: {
          code: "offline_no_session",
          message: "当前离线(无可用 Pi session),沟通员无法直答本条消息;请到「设置」配置 provider / API Key 后重发",
        },
      });
    }
  }

  /**
   * 批次 5b-1 P2:task/feedback 交接路径落库 —— raw 用户消息 + assistant 交接确认。
   * Pi turn 不会发生(直答已被短路),messages 表由本方法直接写:刷新 / 历史 API
   * 读回后会话完整(用户 raw 原文一条 + 确认一条,顺序 = user 先 ack 后)。
   * 会话标题推导与 chat 路径 message_start(user) handler 同语义。
   */
  private persistHandoff(
    userText: string,
    ack: { messageId: string; text: string } | null,
    decision: CommunicatorDecision,
  ): void {
    const turnIndex = this.currentTurnIndex;
    const userMsgId = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    // messages 表有 FK → conversations。chat 路径由 Pi message_start handler 建会话行,
    // 但 task/feedback 路径不走 Pi turn(且离线时 start() 在建行前就 throw),
    // 所以这里先确保会话行存在(幂等 upsert),否则 insertMessage 触发 FK 失败。
    try {
      const active = this.settingsStore.activeProvider();
      upsertConversation(this.storage.db, {
        id: this.conversationId,
        cwd: this.cwd,
        modelId: this.model?.id ?? active?.modelId ?? null,
        provider: this.model?.provider ?? active?.provider ?? null,
      });
    } catch (err) {
      log.warn("storage: upsertConversation(handoff) failed:", err);
    }
    try {
      insertMessage(this.storage.db, {
        id: userMsgId,
        conversationId: this.conversationId,
        turnIndex,
        role: "user",
        content: userText, // raw 原文(5a.5 raw/enriched 分离语义与 chat 路径一致)
        toolCalls: null,
        thinking: null,
        usageInput: 0,
        usageOutput: 0,
        costUsd: 0,
        createdAt: Date.now(),
      });
      recordMessageUsage(this.storage.db, this.conversationId, 0, 0, 0);
      // 首条消息 → 会话标题(与 chat 路径一致)
      try {
        const conv = getConversation(this.storage.db, this.conversationId);
        if (conv && !conv.title && userText.trim()) {
          const t = deriveTitle(userText);
          if (t) {
            setConversationTitle(this.storage.db, this.conversationId, t);
            this.emit({ type: "title_changed", conversationId: this.conversationId, title: t });
          }
        }
      } catch (err) {
        log.warn("title: derive failed:", err);
      }
    } catch (err) {
      log.warn("storage: insertMessage(user/handoff) failed:", err);
    }
    if (ack && ack.text) {
      try {
        insertMessage(this.storage.db, {
          id: ack.messageId,
          conversationId: this.conversationId,
          turnIndex,
          role: "assistant",
          content: ack.text, // 与已发出的 delta 文本一致(刷新后历史 = 当时所见)
          toolCalls: null,
          thinking: null,
          usageInput: 0,
          usageOutput: 0,
          costUsd: 0,
          createdAt: Date.now(),
        });
        recordMessageUsage(this.storage.db, this.conversationId, 0, 0, 0);
      } catch (err) {
        log.warn("storage: insertMessage(assistant/handoff-ack) failed:", err);
      }
    }
    // 批次 5b-1 P4:feedback 收录 —— 从用户 raw 提取 fragment 入库(复用
    // extract→insert→embed 管道,role:"user" 激活 NAME_RE/LIKE_RE 用户侧模式),
    // 身份 fact「用户名字:X」同时接线 profile.name(listProfile 已在 ws 层
    // contextBlock 读回 → 记忆闭环)。只 feedback 进本分支;assistant 侧
    // extractAndStoreFragments 既有路径零改动。
    if (decision.kind === "feedback") {
      void this.extractAndStoreFragments(userText, userMsgId, "user");
      try {
        const frags = extractFragments({ role: "user", content: userText });
        for (const f of frags) {
          if (f.kind === "fact" && f.content.startsWith("用户名字:")) {
            const name = f.content.slice("用户名字:".length).trim();
            if (name) upsertProfile(this.storage.db, "name", name, 0.8);
          }
        }
      } catch (err) {
        log.warn("feedback: profile wiring failed:", err);
      }
    }
  }

  /** 主动中断当前正在进行的 run */
  abort(): void {
    if (!this.session) return;
    try {
      this.session.abort();
    } catch (err) {
      log.warn("abort failed:", err);
    }
  }

  /** 重新生成 session(M2+ 用于切模型时)。C8:入 FIFO 串行链。 */
  async restart(): Promise<void> {
    return this.enqueueOp(() => this.restartInner());
  }

  private async restartInner(): Promise<void> {
    if (this.session) {
      try { this.sessionUnsubscribe?.(); } catch { /* noop */ }
      this.sessionUnsubscribe = null;
      try {
        this.session.dispose?.();
      } catch {}
      this.session = null;
      this.inputTokens = 0;
      this.outputTokens = 0;
    }
    await this.startInner(); // C8:直调 Inner(已在串行链内)
  }

  private makeHandler(): (event: any) => void {
    // S1(A7):handler 不再捕获某个连接的 sink —— 所有事件经 this.emit 动态多播到
    // 当前 attachSink 的活连接集合。局部别名 sink 只是转发到 emit,body 逻辑不变。
    const sink: EventSink = (ev) => this.emit(ev);
    return (event: any) => {
      try {
        switch (event.type) {
          case "agent_start":
            sink({ type: "agent_start", conversationId: this.conversationId, ts: Date.now() });
            break;
          case "turn_start":
            sink({ type: "turn_start", conversationId: this.conversationId, turnIndex: event.turnIndex, ts: Date.now() });
            this.inputTokens = 0;
            this.outputTokens = 0;
            // M2:追踪 turn_index 用于消息落库。
            // 批次 5b-1:DB turn_index 必须 kernel 内单调 —— 合成 turn(交接确认)
            // 直接推进 currentTurnIndex 后,Pi 自己的计数(session 重建 / resume 会
            // 回到 1)可能落后;取 max 保证 messages 历史 ORDER BY turn_index,
            // created_at 不乱序。事件 payload 不变(仍转发 Pi 原值 = 前端 turn id 种子)。
            this.currentTurnIndex = Math.max(event.turnIndex ?? 0, this.currentTurnIndex + 1);
            break;
          case "turn_end":
            break;
          case "message_start": {
            const msg = event.message;
            const mid: string = (hasMsgShape(msg) ? msg.id : undefined) || `m_${Date.now().toString(36)}`;
            this.currentMessageId = mid;
            const role: "user" | "assistant" = (hasMsgShape(msg) ? msg.role : undefined) || "assistant";

            // M2:落库 user / assistant message
            if (role === "user") {
              const text = this.pendingUserText ?? "";
              this.pendingUserText = null;
              try {
                insertMessage(this.storage.db, {
                  id: mid,
                  conversationId: this.conversationId,
                  turnIndex: this.currentTurnIndex,
                  role: "user",
                  content: text,
                  toolCalls: null,
                  thinking: null,
                  usageInput: 0,
                  usageOutput: 0,
                  costUsd: 0,
                  createdAt: Date.now(),
                });
                recordMessageUsage(this.storage.db, this.conversationId, 0, 0, 0);

                // 自动设置标题:首个 user message 出现时,从文本前 30 字截取
                // (不调用 LLM——避免第一次发消息多走一次额外推理)。
                try {
                  const conv = getConversation(this.storage.db, this.conversationId);
                  if (conv && !conv.title && text.trim()) {
                    const t = deriveTitle(text);
                    if (t) {
                      setConversationTitle(this.storage.db, this.conversationId, t);
                      log.muted(`title: set "${t}" for ${this.conversationId}`);
                      sink({
                        type: "title_changed",
                        conversationId: this.conversationId,
                        title: t,
                      });
                    }
                  }
                } catch (err) {
                  log.warn("title: derive/set failed:", err);
                }
              } catch (err) {
                log.warn("storage: insertMessage(user) failed:", err);
              }
            } else {
              this.buf = {
                messageId: mid,
                turnIndex: this.currentTurnIndex,
                textDeltas: [],
                thinkingDeltas: [],
                toolCalls: [],
                startedAt: Date.now(),
              };
            }

            sink({
              type: "message_start",
              conversationId: this.conversationId,
              message: { role, id: mid },
            });
            break;
          }
          case "message_update": {
            const update = event.assistantMessageEvent;
            const text = update?.delta ?? update?.text ?? "";
            // assistantMessageEvent.type: "text" | "thinking" | "tool_use"
            if (update?.type === "thinking" || update?.thinking) {
              if (this.buf) this.buf.thinkingDeltas.push(update.thinking ?? text);
              sink({
                type: "thinking_delta",
                conversationId: this.conversationId,
                messageId: this.currentMessageId ?? "m",
                text: update.thinking ?? text,
              });
            } else {
              if (this.buf) this.buf.textDeltas.push(text);
              sink({
                type: "delta",
                conversationId: this.conversationId,
                messageId: this.currentMessageId ?? "m",
                text,
              });
            }
            break;
          }
          case "message_end": {
            const msg = event.message;
            const usage = msg?.usage;
            const input = usage?.input ?? 0;
            const output = usage?.output ?? 0;
            this.inputTokens += input;
            this.outputTokens += output;

            // M2:落库 assistant message
            if (this.buf) {
              const text = this.buf.textDeltas.join("");
              const thinking = this.buf.thinkingDeltas.join("");
              const toolCalls = this.buf.toolCalls.length
                ? JSON.stringify(this.buf.toolCalls)
                : null;
              const costUsd = estimateCost(this.model ?? undefined, {
                input: this.inputTokens,
                output: this.outputTokens,
              });
              try {
                insertMessage(this.storage.db, {
                  id: this.buf.messageId,
                  conversationId: this.conversationId,
                  turnIndex: this.buf.turnIndex,
                  role: "assistant",
                  content: text,
                  toolCalls,
                  thinking,
                  usageInput: input,
                  usageOutput: output,
                  costUsd,
                  createdAt: Date.now(),
                });
                recordMessageUsage(this.storage.db, this.conversationId, input, output, costUsd);
              } catch (err) {
                log.warn("storage: insertMessage(assistant) failed:", err);
              }
              // 异步 fragment 提取(不阻塞 streaming)
              const bufRef = this.buf;
              this.buf = null;
              void this.extractAndStoreFragments(text, bufRef.messageId);
              // 批次 5b-2 T1:回合后异步智能沉淀 —— 只对 Pi 真回复(chat 回合)触发:
              // task/feedback 的合成 ack turn 走 prompt() 内 closeAckTurn(直接 emit,
              // 不经本 handler),天然不触发。fire-and-forget + .catch(审查 C1 教训:
              // unhandled rejection 崩进程);sedimentTurn 自身也永不 throw(双保险)。
              this.triggerSedimentation(bufRef.messageId, text);
            }

            sink({
              type: "message_end",
              conversationId: this.conversationId,
              messageId: this.currentMessageId ?? "m",
              usage: { input, output },
            });
            break;
          }
          case "tool_execution_start":
            this.toolStartAt.set(event.toolCallId, Date.now());
            // M2:把工具调用记到 buf.toolCalls
            if (this.buf) {
              this.buf.toolCalls.push({ id: event.toolCallId, name: event.toolName, args: event.args });
            }
            sink({
              type: "tool_start",
              conversationId: this.conversationId,
              messageId: this.currentMessageId ?? "m",
              tool: { id: event.toolCallId, name: event.toolName, args: event.args },
            });
            break;
          case "tool_execution_update":
            // 可以用作 streaming 输出,先透传
            break;
          case "tool_execution_end": {
            const start = this.toolStartAt.get(event.toolCallId);
            const durationMs = start ? Date.now() - start : undefined;
            // M2:补 toolCalls 的 result / isError / durationMs
            if (this.buf) {
              const tc = this.buf.toolCalls.find((t) => t.id === event.toolCallId);
              if (tc) {
                tc.result = event.result;
                tc.isError = !!event.isError;
                if (durationMs !== undefined) tc.durationMs = durationMs;
              }
            }
            sink({
              type: "tool_end",
              conversationId: this.conversationId,
              messageId: this.currentMessageId ?? "m",
              tool: { id: event.toolCallId, name: event.toolName, result: event.result, isError: !!event.isError, durationMs },
            });
            break;
          }
          case "agent_end": {
            const cost = estimateCost(this.model ?? undefined, { input: this.inputTokens, output: this.outputTokens });
            sink({
              type: "agent_end",
              conversationId: this.conversationId,
              ts: Date.now(),
              usage: { input: this.inputTokens, output: this.outputTokens, costUsd: cost },
            });
            // M3a B9: 轻量 reflection — 只对“有意义的总账预算 / 时长”的 turn 留 trace
            const turnDurationMs = Date.now() - this.kernelStartedAt;
            if (cost > 0.005 || turnDurationMs > 30_000) {
              try {
                insertFragment(this.storage.db, {
                  id: nanoid(),
                  kind: "context",
                  content: `[reflection] turn ${this.currentTurnIndex}: cost=$${cost.toFixed(4)} duration=${turnDurationMs}ms in/out=${this.inputTokens}/${this.outputTokens}`,
                  sourceConversationId: this.conversationId,
                  sourceMessageId: null,
                  importance: Math.min(1, cost * 10 + turnDurationMs / 60_000),
                  decayFactor: 0.9,
                  accessCount: 0,
                  lastAccessedAt: null,
                  createdAt: Date.now(),
                  metadata: null,
                });
              } catch (err) {
                log.warn("reflection fragment insert failed:", err);
              }
            }
            break;
          }
          case "agent_settled":
            break;
          case "agent_before_settle":
            break;
          default:
            // ignore unknown events
            break;
        }
      } catch (err) {
        log.warn("event handler error:", err);
      }
    };
  }

  /**
   * 批次 5b-2 T1:回合后异步智能沉淀(jev 裁决 A 方案:保流式,不做 D7 字面 JSON 直答)。
   *
   * 触发点:Pi handler message_end(chat 回合 assistant 真回复完成;task/feedback 的
   * 合成 ack turn 不经该 handler → 不触发)。fire-and-forget:不 await、不阻塞流式,
   * `.catch` 守护(审查 C1 教训)—— 沉淀服务自身设计为永不 throw,这里是双保险。
   *
   * 输入:本回合 user raw(lastUserRawText,与落库 raw 同源)+ assistant 回复全文 +
   * 少量前文(DB 最近消息,剔除本回合两条;读失败 → 空前文,不阻塞)。
   * 闸门/DI:SANSHENG_SEDIMENT=0(测试卫生,tests/setup-env.ts)或无模型 → 服务内
   * 静默跳过;opts.sedimentLlmCall 注入绕过闸门(测试 seam)。
   */
  private triggerSedimentation(assistantMessageId: string, assistantText: string): void {
    if (!assistantText.trim()) return; // 空回复不沉淀
    const conversationId = this.conversationId;
    const userText = this.lastUserRawText ?? "";
    let prior: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      const msgs = listMessagesByConversation(this.storage.db, conversationId)
        .filter((m): m is typeof m & { role: "user" | "assistant" } =>
          m.role === "user" || m.role === "assistant")
        .filter((m) => m.id !== assistantMessageId);
      // 末条若正是本回合 user raw(下方已显式传递)→ 去掉,避免前文重复
      const last = msgs[msgs.length - 1];
      if (last && last.role === "user" && last.content === userText) msgs.pop();
      prior = msgs.slice(-4).map((m) => ({ role: m.role, content: m.content ?? "" }));
    } catch {
      prior = []; // 沉淀是 best-effort,DB 读失败不阻塞
    }
    void sedimentTurn(
      {
        getModel: () => this.getModel(),
        // B6:显式传 apiKey 给 completeSimple,不再依赖 process.env 回落。
        getApiKey: () => this.getModelApiKey(),
        ...(this.opts.sedimentLlmCall ? { llmCall: this.opts.sedimentLlmCall } : {}),
        // 批次 7-G:harness system_prompts/sedimentation.md;空 → 内置常量回退。
        // 每次触发都重新 loadHarness(沉淀是回合后异步触发,读盘成本可忽略),
        // 用户改完 sedimentation.md 无需重启即可生效 —— 与 prompt 单元
        // apply 字段「每次沉淀触发时读盘」的声明一致。
        systemPrompt: loadHarness(
          process.env.SANSHENG_DATA ?? this.agentDir.replace(/\/pi$/, ""),
        ).systemPrompts.sedimentation,
      },
      this.storage,
      { conversationId, userText, assistantText, assistantMessageId, recentTranscript: prior },
    ).catch((err) => {
      // 双保险:sedimentTurn 契约永不 throw;万一(编程错误)也只 muted,不影响主路径
      log.muted(`sedimentation: skipped (${(err as Error)?.message ?? err})`);
    });
  }

  /**
   * 启发式提取 fragment → 写 fragments 表 → 异步 embed。
   * 不抛错:embed 失败只 warn,不影响 streaming。
   * 批次 5a.5 T1:仅剩「记住:」触发词 fact 提取(assistant 全文 summary 提取已删,
   * 见 extractor.ts);thinking 参数随之无用,已清理。智能提取属 M3+/批次 5b。
   * 批次 5b-1 P4:`role` 参数(默认 assistant 不变)—— feedback 路径以 role:"user"
   * 复用同一套「提取→入库→embed」管道(assistant 侧调用点零改动)。
   */
  private async extractAndStoreFragments(
    text: string,
    messageId: string,
    role: "user" | "assistant" = "assistant",
  ): Promise<void> {
    if (!text) return;
    let frags;
    try {
      frags = extractFragments({ role, content: text });
    } catch (err) {
      log.warn("fragment: extractor failed:", err);
      return;
    }
    for (const f of frags) {
      const id = nanoid();
      try {
        insertFragment(this.storage.db, {
          id,
          kind: f.kind,
          content: f.content,
          sourceConversationId: this.conversationId,
          sourceMessageId: messageId,
          importance: f.importance,
          decayFactor: 0.95,
          accessCount: 0,
          lastAccessedAt: null,
          createdAt: Date.now(),
          metadata: null,
        });
      } catch (err) {
        log.warn(`fragment: insert failed (${f.kind}):`, err);
        continue;
      }
      // 异步 embed,不阻塞主流程
      void (async () => {
        const provider = this.settingsStore.activeProvider();
        if (!provider?.apiKey) return;
        try {
          const emb = await embedText(f.content, {
            baseUrl: provider.baseUrl ?? "",
            apiKey: provider.apiKey,
            model: "text-embedding-3-small",
          });
          if (emb) {
            try {
              upsertFragmentEmbedding(this.storage.db, id, emb);
            } catch (err) {
              log.warn(`fragment: upsert embedding failed:`, err);
            }
          }
        } catch (err) {
          log.warn(`fragment: embedText threw:`, err);
        }
      })();
    }
  }
}

/**
 * 从用户首条消息提取会话标题:
 * - 合并所有换行 / 多余空白为单个空格
 * - 取前 30 个“视觉”字符(汉字计 1,标点不计超过原限)
 * - 限制总长度 30 个 unicode 字符
 * - 末尾如果截断,加省略号
 */
export function deriveTitle(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  // 合并空白,去掉换行
  const collapsed = t.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const max = 30;
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max).trimEnd() + "…";
}