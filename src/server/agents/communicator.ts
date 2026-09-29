/**
 * Sansheng Communicator · M3c
 *
 * Singleton,常驻,跨 turn 复用。每会话 1 个,新会话重建。
 *
 * 职责:
 *   1. 接收用户文本,落到 `decide()` 判 chat / task / feedback
 *      - chat   : 直接通过 sink 流式答用户(自管 Pi session)
 *      - task   : bus.broadcast 给 planner,等 worker 回报
 *      - feedback: 写 profile
 *   2. Worker 提问时回答(`handleWorkerAsk`)
 *      - 知道:reply 自己答
 *      - 不知道:emit pending_question 升级,等用户回话
 *
 * 设计点:
 *   - decide() 抽象为独立函数,可被测试覆盖(FakeCommunicator / decideFn 注入)
 *   - 默认 decide 是 LLM 驱动(PI_OFFLINE=1 时通过 mock answer / 显式 prompt 解析)
 *   - Communicator 不读写 Blackboard,只通过 bus 与 worker 沟通
 *   - 默认 prompt 通过 harness/loader 加载 ~/.sansheng/harness/system_prompts/communicator.md
 */
import { nanoid } from "nanoid";
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { resolveModel } from "../providers/registry.js";
import type { RunnerSettings } from "./runner.js";
import type {
  BusMessage,
  CommunicatorDecision,
  RoleId,
} from "@shared/types/agents";
import type { MessageBus } from "./messageBus.js";
import { log } from "../../shared/log.js";

export type CommunicatorSink = (e: CommunicatorEvent) => void;

export type CommunicatorEvent =
  | { type: "thinking"; status: "idle" | "thinking" | "tool_use" }
  | { type: "delta"; messageId: string; text: string }
  | { type: "done"; messageId: string }
  | { type: "error"; code: string; message: string }
  | { type: "bus_event"; message: BusMessage }
  | {
      type: "pending_question";
      questionId: string;
      payload: string;
      fromRole: RoleId;
    };

export interface CommunicatorDecideFn {
  (input: { userText: string; conversationId: string }): Promise<CommunicatorDecision>;
}

/**
 * 默认 decide:用 Communicator 自身的 Pi session 跑一次轻量判断。
 * PI_OFFLINE=1 / 没模型时降级为启发式(闲聊 = chat,含动作关键词 = task)。
 */
export async function defaultCommunicatorDecide(
  input: { userText: string; conversationId: string },
): Promise<CommunicatorDecision> {
  const t = input.userText.trim();
  if (!t) return { kind: "chat", reply: "（空消息）" };
  // 极简启发式:含明显动作词 → task
  if (/重构|修复|实现|添加|删除|迁移|部署|写代码|测试|跑一下|安装|配置|查一下|分析|总结/.test(t)) {
    return { kind: "task", goal: t };
  }
  if (/^(我叫|我是|我喜欢|我讨厌|记住:)/.test(t)) {
    return {
      kind: "feedback",
      profileDelta: { preference: t },
    };
  }
  return { kind: "chat", reply: `已收到:${t.slice(0, 80)}` };
}

export interface CommunicatorOptions {
  bus: MessageBus;
  settings: RunnerSettings;
  agentDir: string;
  cwd: string;
  systemPrompt: string;
  decideFn?: CommunicatorDecideFn;
  /** 不打开真实 Pi session(测试用)。 */
  disableLlm?: boolean;
}

/**
 * Communicator 主类。
 *
 * 用法:
 *   const comm = new Communicator({ bus, settings, ... });
 *   await comm.routeUserMessage("你好", conversationId, sink);
 */
export class Communicator {
  private session: AgentSession | null = null;
  private model: Model<string> | null = null;
  private readonly decideFn: CommunicatorDecideFn;
  private readonly disableLlm: boolean;

  constructor(private readonly opts: CommunicatorOptions) {
    this.decideFn = opts.decideFn ?? defaultCommunicatorDecide;
    this.disableLlm = opts.disableLlm ?? false;
  }

  /**
   * 处理一条用户消息 → decide → 路由。
   * sink 用于向前端流式推 assistant delta / done。
   */
  async routeUserMessage(
    userText: string,
    conversationId: string,
    sink: CommunicatorSink,
  ): Promise<CommunicatorDecision> {
    sink({ type: "thinking", status: "thinking" });
    try {
      const decision = await this.decideFn({ userText, conversationId });

      if (decision.kind === "chat") {
        // chat:不阻塞 bus,但仍 emit assistant delta 让 UI 有回复
        const messageId = nanoid();
        sink({ type: "delta", messageId, text: decision.reply });
        sink({ type: "done", messageId });
        // 同时落一条 bus broadcast 让 timeline 可见
        const msg = this.opts.bus.broadcast({
          fromRole: "communicator",
          toRole: "user",
          conversationId,
          payload: decision.reply,
          context: { source: "decide_chat" },
        });
        sink({ type: "bus_event", message: msg });
      } else if (decision.kind === "task") {
        // task:转发给 planner(走 M3b 的 Orchestrator 由 ws 层负责 trigger)
        // 这里只 emit 一条 broadcast 表示「已接收任务」
        const msg = this.opts.bus.broadcast({
          fromRole: "communicator",
          toRole: "planner",
          conversationId,
          payload: decision.goal,
          context: { source: "decide_task" },
        });
        sink({ type: "bus_event", message: msg });
        // 给用户一个简短确认
        const messageId = nanoid();
        sink({ type: "delta", messageId, text: `收到任务:${decision.goal.slice(0, 60)}` });
        sink({ type: "done", messageId });
      } else {
        // feedback:写 profile(M3c 占位 — 实际由 storage 层接管,这里只 emit 提示)
        const messageId = nanoid();
        sink({
          type: "delta",
          messageId,
          text: `已记录偏好:${Object.values(decision.profileDelta).join("; ").slice(0, 60)}`,
        });
        sink({ type: "done", messageId });
        const msg = this.opts.bus.broadcast({
          fromRole: "communicator",
          toRole: "memory",
          conversationId,
          payload: JSON.stringify(decision.profileDelta),
          context: { source: "decide_feedback" },
        });
        sink({ type: "bus_event", message: msg });
      }
      return decision;
    } catch (err) {
      sink({
        type: "error",
        code: "decide_failed",
        message: (err as Error).message ?? String(err),
      });
      throw err;
    } finally {
      sink({ type: "thinking", status: "idle" });
    }
  }

  /**
   * 处理 worker 提问:reply 自己答,或 escalate 给用户。
   * - knowIt=true:直接 reply(payload)
   * - knowIt=false:emit pending_question;返回 questionId,等待 ws 层 answer_question 事件调 bus.reply()
   *
   * knowIt 默认由 decideFn 判断;实际产品中可以走 LLM 自查(读代码 / 调工具)。
   */
  async handleWorkerAsk(
    questionMessage: BusMessage,
    knowIt: boolean,
    replyPayload: string,
    sink: CommunicatorSink,
  ): Promise<{ replied: boolean; questionId?: string }> {
    if (questionMessage.kind !== "question") {
      log.warn(`handleWorkerAsk: not a question, got kind=${questionMessage.kind}`);
      return { replied: false };
    }
    if (knowIt) {
      this.opts.bus.reply(questionMessage.id, replyPayload);
      const replyMsg = this.opts.bus
        .snapshot()
        .reverse()
        .find((m) => m.questionId === questionMessage.id);
      if (replyMsg) sink({ type: "bus_event", message: replyMsg });
      return { replied: true };
    }
    // escalate:自己答不了,问用户
    const pendingId = questionMessage.id;
    sink({
      type: "pending_question",
      questionId: pendingId,
      payload: questionMessage.payload,
      fromRole: questionMessage.fromRole as RoleId,
    });
    return { replied: false, questionId: pendingId };
  }

  /** 直接给一个 pending question(由外层 answer_question 事件驱动)reply,用于测试 + ws 桥接。 */
  answerPending(questionId: string, payload: string): boolean {
    return this.opts.bus.reply(questionId, payload);
  }

  /** 取消一个 pending question(timeout-reject)。 */
  cancelPending(questionId: string): boolean {
    const replied = this.opts.bus.reply(questionId, "(用户取消)");
    return replied;
  }

  /**
   * 启动 communicator 的 Pi session(用于流式 chat 回复 / decide)。
   * 测试通常用 disableLlm=true 不走这里。
   */
  async ensureSession(): Promise<AgentSession | null> {
    if (this.disableLlm) return null;
    if (this.session) return this.session;
    const model = resolveModel(
      this.opts.settings as unknown as Parameters<typeof resolveModel>[0],
    );
    if (!model) {
      log.warn("Communicator: no model resolved, falling back to non-LLM mode");
      return null;
    }
    this.model = model as Model<string>;
    const result = await createAgentSession({
      model: this.model,
      agentDir: this.opts.agentDir,
      cwd: this.opts.cwd,
    });
    this.session = result.session;
    return this.session;
  }

  dispose(): void {
    try {
      this.session?.dispose();
    } catch {
      /* ignore */
    }
    this.session = null;
  }
}