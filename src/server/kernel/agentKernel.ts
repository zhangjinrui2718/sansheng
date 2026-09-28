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
import { getBuiltinModel, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import { SettingsStore, type Settings } from "../settings/store.js";
import { estimateCost } from "../providers/cost.js";
import { log } from "../../shared/log.js";
import { resolveModel } from "../providers/registry.js";

export type ServerEvent =
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
  | { type: "interrupt"; conversationId: string };

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

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly agentDir: string,
    private readonly cwd: string,
  ) {
    this.settings = settingsStore.load();
  }

  isReady(): boolean {
    return this.session !== null;
  }

  getConversationId(): string {
    return this.conversationId;
  }

  /** 用当前 Settings 创建或重建 Session;Settings 变更后调用 */
  async start(sink: EventSink): Promise<void> {
    if (this.session) return; // already started
    this.settings = this.settingsStore.load();
    const m = resolveModel({
      provider: this.settings.provider,
      modelId: this.settings.modelId,
      apiKey: this.settings.apiKey,
      baseUrl: this.settings.baseUrl,
    });
    if (!m) {
      const msg = `model not configured: provider=${this.settings.provider} model=${this.settings.modelId}; set API key in Settings`;
      sink({ type: "error", conversationId: this.conversationId, error: { code: "no_model", message: msg } });
      throw new Error(msg);
    }
    this.model = m;
    log.info(`kernel start: provider=${this.settings.provider} model=${this.settings.modelId} cwd=${this.cwd}`);

    const { session } = await createAgentSession({
      model: m,
      cwd: this.cwd,
      agentDir: this.agentDir,
      thinkingLevel: this.settings.thinkingLevel,
    });

    this.session = session;
    sink({
      type: "ready",
      conversationId: this.conversationId,
      modelId: this.settings.modelId,
      provider: this.settings.provider,
    });

    // subscribe 把 Pi 事件翻译成 ServerEvent
    this.session.subscribe(this.makeHandler(sink));
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("kernel not started");
    await this.session.prompt(text);
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
            break;
          case "turn_end":
            break;
          case "message_start": {
            const msg = event.message;
            const mid: string = (msg && (msg as any).id) || `m_${Date.now().toString(36)}`;
            this.currentMessageId = mid;
            sink({
              type: "message_start",
              conversationId: this.conversationId,
              message: { role: (msg && (msg as any).role) || "assistant", id: mid },
            });
            break;
          }
          case "message_update": {
            const update = event.assistantMessageEvent;
            const text = update?.delta ?? update?.text ?? "";
            // assistantMessageEvent.type: "text" | "thinking" | "tool_use"
            if (update?.type === "thinking" || update?.thinking) {
              sink({
                type: "thinking_delta",
                conversationId: this.conversationId,
                messageId: this.currentMessageId ?? "m",
                text: update.thinking ?? text,
              });
            } else {
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
}