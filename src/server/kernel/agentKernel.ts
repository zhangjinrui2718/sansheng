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
import { resolveModel } from "../providers/registry.js";
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
  | { type: "conversation_reset"; conversationId: string };

export type EventSink = (e: ServerEvent) => void;

export class AgentKernel {
  private session: AgentSession | null = null;
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
   * 使当前 session 失效(不重建)。用于 settings 变更后:
   * 下一次 ensureStarted/prompt 会用新的 active provider 重新 start()。
   */
  invalidate(): void {
    if (this.session) {
      try {
        if ((this.session as any).isStreaming) this.session.abort();
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

  /** 用当前 Settings 的 active provider 创建或重建 Session;Settings 变更后调用 */
  async start(sink: EventSink): Promise<void> {
    if (this.session) return; // already started
    this.settings = this.settingsStore.load();
    const active = this.settingsStore.activeProvider();
    if (!active) {
      const msg = "尚未配置任何 provider;请到「设置」添加一个";
      sink({ type: "error", conversationId: this.conversationId, error: { code: "no_provider", message: msg } });
      throw new Error(msg);
    }
    const m = await this.resolveActiveModel(active, sink);
    this.model = m;
    log.info(`kernel start: provider=${active.provider} model=${active.modelId} cwd=${this.cwd}`);

    const session = await this.createPiSession(m, active);
    this.session = session;

    // 等 session 真正 idle 后再 emit ready;createAgentSession() 返回时
    // Pi SDK 还在做内部初始化(tool 注册 / system prompt 构建),此时 prompt() 会拋
    // "Agent is already processing"。等 isIdle=true 才安全。
    await this.waitSessionIdle(session);

    sink({
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

    // subscribe 把 Pi 事件翻译成 ServerEvent
    this.session.subscribe(this.makeHandler(sink));
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
  async resume(conversationId: string, sink: EventSink): Promise<void> {
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
      sink({ type: "error", conversationId: this.conversationId, error: { code: "not_found", message: msg } });
      throw new Error(msg);
    }

    // 从 DB 拉历史 messages(用于 state_json metadata,不在此重放给 Pi)
    const history = listMessagesByConversation(this.storage.db, conversationId);

    this.settings = this.settingsStore.load();
    const active = this.settingsStore.activeProvider();
    if (!active) {
      const msg = "尚未配置任何 provider;请到「设置」填写";
      sink({ type: "error", conversationId: this.conversationId, error: { code: "no_provider", message: msg } });
      throw new Error(msg);
    }
    const m = await this.resolveActiveModel(active, sink);
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

    sink({
      type: "ready",
      conversationId: this.conversationId,
      modelId: this.model?.id ?? active.modelId,
      provider: this.model?.provider ?? active.provider,
    });

    this.session.subscribe(this.makeHandler(sink));
    log.info(`kernel resumed: ${conversationId} (history=${history.length})`);
  }

  /** 释放当前 Pi session 但保留 agent_states。供 resume() / invalidate() 复用。 */
  private disposeSession(): void {
    if (this.session) {
      try {
        if ((this.session as any).isStreaming) {
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
  private async resolveActiveModel(active: ProviderConfig, sink: EventSink): Promise<Model<any>> {
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
      sink({ type: "error", conversationId: this.conversationId, error: { code, message: msg } });
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
  async newConversation(sink: EventSink): Promise<string> {
    if (this.session) {
      try {
        if ((this.session as any).isStreaming) this.session.abort();
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
    sink({ type: "conversation_reset", conversationId: this.conversationId });
    return this.conversationId;
  }

  /**
   * 强制重置 kernel(用于 stuck 状态恢复)。
   * - 如果 session 还在 streaming,先 abort
   * - dispose 旧 session,清掉内部状态
   * - 下次 prompt 会重新 start()
   */
  async reset(sink: EventSink): Promise<void> {
    log.warn("kernel reset requested");
    if (this.session) {
      try {
        if ((this.session as any).isStreaming) {
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
    sink({ type: "interrupt", conversationId: this.conversationId });
    await this.start(sink);
  }

  async prompt(text: string, sink?: EventSink): Promise<void> {
    // sink 可选;为空时假设 kernel 已 start(常规路径)。
    if (!this.session) {
      if (sink) {
        // 还没 start 过,可能是用户改了 settings 后第一次发 — 触发一次 start
        await this.start(sink);
      } else {
        throw new Error("kernel not started");
      }
    }
    // 保险:再 poll 一次 session.isIdle,避免极端情况(刚启动有隐式后台 prompt)
    for (let i = 0; i < 100 && !this.session!.isIdle; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // M2:buffer 起来,handler 在 message_start(role=user) 时落库
    this.pendingUserText = text;
    await this.session!.prompt(text);
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
  async restart(sink: EventSink): Promise<void> {
    if (this.session) {
      try {
        this.session.dispose?.();
      } catch {}
      this.session = null;
      this.inputTokens = 0;
      this.outputTokens = 0;
    }
    await this.start(sink);
  }

  private makeHandler(sink: EventSink) {
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
            const mid: string = (msg && (msg as any).id) || `m_${Date.now().toString(36)}`;
            this.currentMessageId = mid;
            const role: "user" | "assistant" = (msg && (msg as any).role) || "assistant";

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
              void this.extractAndStoreFragments(text, bufRef.messageId, thinking);
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
   */
  private async extractAndStoreFragments(text: string, messageId: string, thinking?: string): Promise<void> {
    if (!text && !thinking) return;
    let frags;
    try {
      frags = extractFragments({ role: "assistant", content: text, thinking });
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