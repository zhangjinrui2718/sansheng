/**
 * Sansheng AgentKernel · 单 agent 模式(M1)
 *
 * 包一层 Pi `createAgentSession`,负责:
 * - Settings → Model 解析
 * - Pi AgentSession 生命周期
 * - Pi AgentSessionEvent → WS ServerEvent 翻译
 * - token usage 累积 + cost 估算
 */
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { nanoid } from "nanoid";
import { SettingsStore, type Settings, type ProviderConfig } from "../settings/store.js";
import { estimateCost } from "../providers/cost.js";
import { log } from "../../shared/log.js";
import { MessageBus } from "../agents/messageBus.js";
import { Communicator, type CommunicatorSink } from "../agents/communicator.js";
import type { BusMessage as BusMessageFromTypes } from "@shared/types/agents";
import type { RunnerSettings } from "../agents/runner.js";
import { loadHarness } from "../harness/loader.js";
import { appendBusMessage, loadBusMessages } from "../agents/busPersister.js";

/** 本文件用到 BusMessage 类型 */
type BusMessage = BusMessageFromTypes;
import { resolveModel } from "../providers/registry.js";
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
  private ensureCommunicator(): Communicator {
    if (this.communicator) return this.communicator;
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
      log.warn(`handleUserAnswer: upsertArtifact failed: ${(err as Error).message ?? err}`);
    }
    artifactBus.publish({ type: "artifact_created", artifact: decision });
    artifactBus.publish({
      type: "executor_resume",
      executorSessionId,
      decisionArtifactId: decision.id,
    });
    return { replied, resumed: { executorSessionId, decisionArtifactId: decision.id } };
  }

  /** M3c:ws 层调这个取消一个挂起的 question。 */
  cancelPendingQuestion(questionId: string): boolean {
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
   * M3+ B3/B5: 由 Orchestrator.routeCallback 注入调入。
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
    if (!this.communicator) {
      log.warn("handleExecutorCallback: communicator not ready, dropping");
      return;
    }
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
   *  S1(A7):不再接受 sink —— 事件经 this.emit 多播到 attachSink 的所有活连接。 */
  async start(): Promise<void> {
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
   */
  async resume(conversationId: string): Promise<void> {
    log.muted(`kernel resume: ${conversationId}`);
    if (this.conversationId !== conversationId) {
      this.disposeSession();
    }
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
      upsertAgentState(this.storage.db, {
        conversationId,
        cwd: conv.cwd ?? this.cwd,
        modelId: conv.modelId ?? active.modelId,
        provider: conv.provider ?? active.provider,
        stateJson: JSON.stringify({ historyCount: history.length, resumedAt: Date.now() }),
        lastActiveAt: Date.now(),
      });
      // 同步 conversations 行的 last_active_at / message_count
      upsertConversation(this.storage.db, {
        id: conversationId,
        cwd: conv.cwd ?? this.cwd,
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

  /** 用 Pi SDK 创建 session,带 8s 硬超时防 ModelRuntime 卡死。 */
  private async createPiSession(m: Model<any>, active: ProviderConfig): Promise<AgentSession> {
    const createPromise = createAgentSession({
      model: m,
      cwd: this.cwd,
      agentDir: this.agentDir,
      thinkingLevel: active.thinkingLevel,
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("createAgentSession timeout (8s) — ModelRuntime refresh hung?")), 8000),
    );
    const { session } = await Promise.race([createPromise, timeoutPromise]);
    return session;
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
   */
  async newConversation(): Promise<string> {
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
   */
  async reset(): Promise<void> {
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
    await this.start();
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
    // S1(A7):不再接受 sink 覆盖 —— 事件统一走 this.emit 多播到 attachSink 的活连接。
    // sink 为空时假设 kernel 已 start(常规路径:ws.ts 先 ensureStarted)。
    if (!this.session) {
      // 还没 start 过(用户改了 settings 后第一次发,或 ensureStarted 失败后的 fallback):
      // 触发一次 lazy start。start 可能 fail(如没 provider),它会 emit 错误再 throw。
      // 这里吞掉 throw,让后续 Communicator / fallback 路径仍能尝试(M3c + PI_OFFLINE 场景)。
      try {
        await this.start();
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
    if (comm) {
      try {
        const decision = await comm.routeUserMessage(text, this.conversationId, (e) => {
          // Communicator → ServerEvent 翻译(经 this.emit 多播到活连接)
          switch (e.type) {
            case "thinking":
              this.emit({
                type: "communicator_thinking",
                conversationId: this.conversationId,
                status: e.status,
              });
              break;
            case "delta":
            case "done":
            case "bus_event":
            case "error":
            case "pending_question":
            case "user_reply":
              // done/delta:不直接喂给 session.prompt(),只 log 或 bus_event
              // pending_question:升级用户
              // user_reply: Communicator 的内部标记(delta/done 已经发了)
              if (e.type === "bus_event") {
                this.emit({ type: "bus_event", message: e.message });
              } else if (e.type === "pending_question") {
                this.pendingQuestions.set(e.questionId, this.conversationId);
                this.emit({
                  type: "pending_question",
                  conversationId: this.conversationId,
                  questionId: e.questionId,
                  payload: e.payload,
                  fromRole: e.fromRole,
                });
              } else if (e.type === "error") {
                log.warn(`communicator ${e.code}: ${e.message}`);
              }
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
        // 如果 Communicator 决定 task,降级让 kernel Pi session 负责答(产品化:转 M3b Orchestrator)
        // M3c 简化实现:task 也走 Pi session 直答 — 完整 Orchestrator 在 M3b 由 /plan 显式触发
        log.muted(
          `communicator decide: kind=${decision.kind} conv=${this.conversationId}`,
        );
      } catch (err) {
        log.warn("communicator routeUserMessage failed; falling back to direct Pi:", err);
      }
    }
    // 保险:再 poll 一次 session.isIdle,避免极端情况(刚启动有隐式后台 prompt)
    if (this.session) {
      for (let i = 0; i < 100 && !this.session.isIdle; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    // M2:buffer 起来,handler 在 message_start(role=user) 时落库
    this.pendingUserText = text;
    // M3c: 只有 session 存在时才回退 Pi session(PI_OFFLINE 场景下 kernel 无 session)。
    // B2(批次 5a,docs/CODE-REVIEW-2026-10-01.md §B2):chat 路径的 canned「已收到」
    // 占位 sink 已在 Communicator 侧移除 → 这里的 Pi 直答是 chat 的唯一回复(双回复已治)。
    // 已知边界:task 路径 onTask→runPlan 与本行 session.prompt 仍并行(双执行),
    // 本批次刻意不动 —— 留待批次 5b decide 升级为 LLM 判断时一并根治(§B2);
    // 现在提前 return 会让正则误判 task 时用户连 Pi 直答都失去,反而更糟。
    if (this.session) {
      // 批次 5a.5 T1:Pi session 收 enriched(记忆能力保留);messages 表已在
      // pendingUserText 处固定为 raw text(上方),两条路径彻底分离。
      const full = opts?.contextBlock
        ? `${opts.contextBlock}\n\n---\n\nUser: ${text}`
        : text;
      await this.session.prompt(full);
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

  /** 重新生成 session(M2+ 用于切模型时) */
  async restart(): Promise<void> {
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
    await this.start();
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
            // M2:追踪 turn_index 用于消息落库
            this.currentTurnIndex = event.turnIndex ?? this.currentTurnIndex;
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
   * 启发式提取 fragment → 写 fragments 表 → 异步 embed。
   * 不抛错:embed 失败只 warn,不影响 streaming。
   * 批次 5a.5 T1:仅剩「记住:」触发词 fact 提取(assistant 全文 summary 提取已删,
   * 见 extractor.ts);thinking 参数随之无用,已清理。智能提取属 M3+/批次 5b。
   */
  private async extractAndStoreFragments(text: string, messageId: string): Promise<void> {
    if (!text) return;
    let frags;
    try {
      frags = extractFragments({ role: "assistant", content: text });
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