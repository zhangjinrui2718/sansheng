/**
 * Sansheng Communicator · M3+ (3 重身份)
 *
 * Singleton,常驻,跨 turn 复用。每会话 1 个,新会话重建。
 *
 * M3+ 三重身份:
 *   1. Reactive Input — 接 user message / executor_callback(bus)
 *   2. Plan Producer  — 每次响应输出 JSON `{userReply?, artifacts[]}` 结构
 *   3. Observer      — 订阅 bus `artifact_status_changed`,仅 `newStatus ∈ {resolved, failed}` 触发
 *
 * 保留 v4 兼容 API(`routeUserMessage` / `handleWorkerAsk` / `answerPending` / `cancelPending`)，
 * v4 测试不受影响。
 *
 * 设计点:
 *   - decide() 抽象为独立函数,可被测试覆盖(FakeCommunicator / decideFn 注入)
 *   - 默认 decide 是 LLM 驱动(PI_OFFLINE=1 时通过 mock answer / 显式 prompt 解析)
 *   - Communicator 不读写 Blackboard,只通过 bus 与 worker 沟通
 *   - 默认 prompt 通过 harness/loader 加载 ~/.sansheng/harness/system_prompts/communicator.md
 *   - 结构化输出 parse 失败 → emit 单 note artifact(降级)
 *   - Intent 验证失败 → kind 强制改为 hypothesis
 */
import { nanoid } from "nanoid";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
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
import {
  IMPERATIVE_VERBS,
  type BlackboardArtifact,
  type ArtifactKind,
  type ArtifactStatus,
  type CommunicatorResponse,
  type ParsedCommunicatorResponse,
  type ValidatedArtifact,
  type ArtifactStatusChangedEvent,
  type ExecutorCallbackEvent,
} from "../../../shared/types/bus.js";
import { artifactBus, makeArtifact } from "../bus/index.js";

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
    }
  // M3+ 新增
  | { type: "user_reply"; messageId: string; text: string }
  | { type: "artifact_created"; artifact: BlackboardArtifact };

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
  /** M3+ respond 函数(产 JSON output);默认使用 LLM 或离线 fallback */
  respondFn?: CommunicatorRespondFn;
  /**
   * M3+ B4: 当 decide 判定为 task 时,Communicator 触发此 callback
   * (通常是 ws 层挂入的「启动 Orchestrator」)。
   * 若未提供,Communicator 仅 emit bus broadcast + 给用户确认,不主动触发 plan。
   */
  onTask?: (input: { goal: string; conversationId: string }) => void;
}

/**
 * M3+ respond 函数 — 把 input 转换成 `{userReply?, artifacts[]}`。
 * 默认实现跑 LLM;offline / test 注入 fake。
 */
export interface CommunicatorRespondFn {
  (input: ReactiveInput): Promise<CommunicatorResponse>;
}

/** M3+ reactive input — 来自 user 或 executor_callback */
export type ReactiveInput =
  | {
      kind: "user_message";
      userText: string;
      conversationId: string;
    }
  | {
      kind: "executor_callback";
      callback: ExecutorCallbackEvent;
      conversationId: string;
    };

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
        // M3+ B4:触发 Orchestrator(由 ws 层注入的 onTask callback)。
        // 若未注入则保持 v3 行为(只 emit broadcast)。
        try {
          this.opts.onTask?.({ goal: decision.goal, conversationId });
        } catch (err) {
          sink({
            type: "error",
            code: "onTask_failed",
            message: (err as Error).message ?? String(err),
          });
          log.warn(`Communicator.onTask threw: ${(err as Error).message ?? err}`);
        }
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
   * M3+ B4: 注入/更新 task 触发 callback。
   * Communicator 的 opts 是 readonly ref,但 object 内部属性可变 — 所以这里直接 mutate。
   * 设计为 setter 而非 options.onTask 一次性传入,是因为 Communicator 在
   * kernel.ensureCommunicator() 内构造,此时 ws 层的 runPlan closure 还没建好。
   */
  setOnTask(cb: ((input: { goal: string; conversationId: string }) => void) | undefined): void {
    this.opts.onTask = cb;
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
    // 注入 user-customized systemPrompt:用户 ~/.sansheng/system_prompts/communicator.md
    // 覆盖或 DEFAULT_PROMPTS.communicator fallback(undefined → loader 用默认 AGENTS.md)
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.opts.cwd,
      agentDir: this.opts.agentDir,
      systemPrompt: this.opts.systemPrompt || undefined,
    });
    const result = await createAgentSession({
      model: this.model,
      agentDir: this.opts.agentDir,
      cwd: this.opts.cwd,
      resourceLoader,
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

/* ─────────────────────────────────────────────────────────
 * M3+ · Helpers & 3 重身份 helper 函数
 * ───────────────────────────────────────────────────────── */

/** 检测 imperative verb(中英均包括) */
export function hasImperativeVerb(title: string): boolean {
  if (!title) return false;
  const tokens = title
    .split(/[\s,，。；;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const tok of tokens) {
    if (IMPERATIVE_VERBS.has(tok)) return true;
    const lower = tok.toLowerCase();
    if (IMPERATIVE_VERBS.has(lower)) return true;
  }
  return false;
}

/** parse 失败 → 单 note artifact 降级 */
export function fallbackToNote(
  parseError: string,
  userReply?: string,
): ParsedCommunicatorResponse {
  const note = makeArtifact({
    kind: "note",
    title: "Communicator 输出解析失败",
    body: `${parseError}\n\n降级为单 note artifact;请 Communicator 重新输出纯 JSON。`,
    author: "communicator",
    scope: "global",
  });
  return {
    userReply,
    artifacts: [{ artifact: note, intentValid: true }],
    parseError,
  };
}

/**
 * 解析 LLM raw 输出 → ParsedCommunicatorResponse
 *
 * 行为:
 *   - 提取 ```json ... ``` 或首个 {...}
 *   - parse 失败 → { parseError, artifacts: [note 降级], userReply: undefined }
 *   - parse 成功 → Intent 验证(无 imperative verb 且无 refs → 降级 hypothesis)
 */
export function parseStructuredOutput(raw: string): ParsedCommunicatorResponse {
  const trimmed = raw.trim();
  if (!trimmed) return fallbackToNote("empty output");

  let jsonText = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1]) {
    jsonText = fenceMatch[1].trim();
  } else {
    const braceIdx = jsonText.indexOf("{");
    if (braceIdx >= 0) jsonText = jsonText.slice(braceIdx);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return fallbackToNote(
      `JSON parse failed: ${(err as Error).message}; raw first 200 chars: ${trimmed.slice(0, 200)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    return fallbackToNote("not an object");
  }

  const obj = parsed as Record<string, unknown>;
  const userReply =
    typeof obj.userReply === "string" ? obj.userReply : undefined;

  if (!Array.isArray(obj.artifacts)) {
    return fallbackToNote(
      `artifacts must be array; got ${typeof obj.artifacts}`,
      userReply,
    );
  }

  const artifacts: ValidatedArtifact[] = [];
  for (const raw of obj.artifacts) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const kind = typeof a.kind === "string" ? (a.kind as ArtifactKind) : null;
    const body = typeof a.body === "string" ? a.body : null;
    const author =
      typeof a.author === "string"
        ? (a.author as BlackboardArtifact["author"])
        : "communicator";
    if (!kind || !body) continue;
    const refs = Array.isArray(a.refs)
      ? a.refs.filter((r): r is string => typeof r === "string")
      : undefined;

    let finalKind = kind;
    let downgraded: "imperative-missing" | undefined;
    if (kind === "intent") {
      const title = typeof a.title === "string" ? a.title : "";
      const verbOk = hasImperativeVerb(title);
      const refsOk = !!(refs && refs.length > 0);
      if (!verbOk && !refsOk) {
        finalKind = "hypothesis";
        downgraded = "imperative-missing";
      }
    }

    const artifact = makeArtifact({
      kind: finalKind,
      title: typeof a.title === "string" ? a.title : "(untitled)",
      body,
      author,
      refs,
      dependsOn: Array.isArray(a.dependsOn)
        ? a.dependsOn.filter((d): d is string => typeof d === "string")
        : undefined,
      parentIntent:
        typeof a.parentIntent === "string" ? a.parentIntent : undefined,
      metadata:
        a.metadata && typeof a.metadata === "object"
          ? (a.metadata as BlackboardArtifact["metadata"])
          : undefined,
      scope:
        typeof a.scope === "string"
          ? (a.scope as BlackboardArtifact["scope"])
          : "global",
      conversationId:
        typeof a.conversationId === "string"
          ? a.conversationId
          : undefined,
      status:
        typeof a.status === "string"
          ? (a.status as BlackboardArtifact["status"])
          : "open",
    });

    artifacts.push({
      artifact,
      intentValid: kind === "intent" ? !downgraded : true,
      downgraded,
    });
  }

  return { userReply, artifacts };
}

/* ─────────────────────────────────────────────────────────
 * M3+ Communicator · 3 重身份 类扩展
 * 动态粘附在原 class prototype(避免双 class 定义冲突)
 * ───────────────────────────────────────────────────────── */

// 存储原 constructor 引用
type CommunicatorProto = Communicator & {
  __observerUnsub?: (() => void) | null;
  __respondFn?: CommunicatorRespondFn;
};

// 仅在第一次 require 时 patch 一次
const _patched = (() => {
  const Ctor = Communicator as unknown as {
    prototype: CommunicatorProto;
  };
  const proto = Ctor.prototype;

  if ((proto as { __m3Patched?: boolean }).__m3Patched) {
    return true;
  }

  // 重新记录原 dispose(原 v4 dispose 不取消 observer — 我们手动接管)
  // 这里不重写 dispose;M3+ observer 由下面的 isObserverActive + 全局 artifactBus 管理。
  // 为了避免内存泄漏,expose 一个手动 stopObserver。

  (proto as { __m3Patched?: boolean }).__m3Patched = true;
  return true;
})();

/** Communicator M3+ 扩展方法,挂在原型上 */
declare module "./communicator.js" {
  // 让 TS 知道这些方法存在
}

// 在 class 后面用 prototype 注入 — 这样 ES2022 target 下属性查找仍然能找到
(Communicator.prototype as unknown as {
  startObserver: () => () => void;
  onArtifactFinalized: (id: string, status: ArtifactStatus) => void;
  isObserverActive: () => boolean;
  respond: (input: ReactiveInput) => Promise<ParsedCommunicatorResponse>;
  emitResponse: (
    parsed: ParsedCommunicatorResponse,
    sink: CommunicatorSink,
  ) => void;
}).startObserver = function (this: CommunicatorProto): () => void {
  const self = this as unknown as Communicator;
  return artifactBus.subscribe(
    "artifact_status_changed",
    (event: ArtifactStatusChangedEvent) => {
      const { newStatus, artifactId } = event;
      if (newStatus !== "resolved" && newStatus !== "failed") {
        return;
      }
      const verb = newStatus === "resolved" ? "已完成" : "失败";
      const noteId = `obs-${nanoid(8)}`;
      const note = makeArtifact({
        kind: "note",
        title: `Observer · ${verb} ${artifactId.slice(0, 8)}`,
        body: `Artifact ${artifactId.slice(0, 8)} ${verb}。`,
        author: "communicator",
        scope: "global",
        status: newStatus,
        metadata: { relatedArtifacts: [artifactId] },
      });
      artifactBus.publish({ type: "artifact_created", artifact: note });
      log.info(`[Communicator.observer] artifact ${artifactId} → ${newStatus}`);
    },
  );
};

(Communicator.prototype as unknown as {
  isObserverActive: () => boolean;
}).isObserverActive = function (this: CommunicatorProto): boolean {
  return this.__observerUnsub != null;
};

/**
 * Identity 1+2: Reactive Input + Plan Producer
 * 接受 user_message 或 executor_callback → 产出 JSON 响应 → 写 BlackboardArtifact。
 */
(Communicator.prototype as unknown as {
  respond: (input: ReactiveInput) => Promise<ParsedCommunicatorResponse>;
}).respond = async function (
  this: CommunicatorProto,
  input: ReactiveInput,
): Promise<ParsedCommunicatorResponse> {
  // resolve respondFn(lazy,避免 bind 问题)
  let fn = this.__respondFn;
  if (!fn) {
    fn = (async (i: ReactiveInput): Promise<CommunicatorResponse> => {
      // offline / LLM-not-ready fallback
      if (i.kind === "user_message") {
        return { userReply: `已收到:${i.userText.slice(0, 80)}`, artifacts: [] };
      }
      return {
        userReply: `收到 executor 回调 (${i.callback.reason})`,
        artifacts: [],
      };
    }) as CommunicatorRespondFn;
    this.__respondFn = fn;
  }

  try {
    const raw = await fn(input);
    const parsed = parseStructuredOutput(JSON.stringify(raw));
    for (const v of parsed.artifacts) {
      artifactBus.publish({ type: "artifact_created", artifact: v.artifact });
    }
    return parsed;
  } catch (err) {
    const fb = fallbackToNote(`respondFn threw: ${(err as Error).message}`);
    for (const v of fb.artifacts) {
      artifactBus.publish({ type: "artifact_created", artifact: v.artifact });
    }
    return fb;
  }
};

/** emit response 到 sink */
(Communicator.prototype as unknown as {
  emitResponse: (
    parsed: ParsedCommunicatorResponse,
    sink: CommunicatorSink,
  ) => void;
}).emitResponse = function (
  parsed: ParsedCommunicatorResponse,
  sink: CommunicatorSink,
): void {
  if (parsed.userReply) {
    const messageId = nanoid();
    sink({ type: "user_reply", messageId, text: parsed.userReply });
    sink({ type: "delta", messageId, text: parsed.userReply });
    sink({ type: "done", messageId });
  }
  for (const v of parsed.artifacts) {
    sink({ type: "artifact_created", artifact: v.artifact });
  }
};

/** 手动启动 observer(也可在构造时自动启动) */
(Communicator.prototype as unknown as {
  enableObserver: () => void;
}).enableObserver = function (this: CommunicatorProto): void {
  if (this.__observerUnsub) return;
  const subFn = (this as unknown as {
    startObserver: () => () => void;
  }).startObserver.bind(this);
  this.__observerUnsub = subFn();
};

/** 手动停止 observer */
(Communicator.prototype as unknown as {
  disableObserver: () => void;
}).disableObserver = function (this: CommunicatorProto): void {
  if (this.__observerUnsub) {
    try {
      this.__observerUnsub();
    } catch {
      /* ignore */
    }
    this.__observerUnsub = null;
  }
};

/** answerPending / cancelPending 已在 v4 中提供(薄包装 bus.reply) */