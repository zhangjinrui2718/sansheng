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
import { completeSimple } from "@earendil-works/pi-ai/compat";
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
 * 降级兜底 decide(正则启发式):闲聊 = chat,含动作关键词 = task,自我披露 = feedback。
 *
 * 批次 5a(B2 修复,docs/CODE-REVIEW-2026-10-01.md §B2):chat 分支不再产
 * canned「已收到:…」占位回复 —— chat 的唯一回复来自 Pi session 直答。
 *
 * 批次 5b-1(P1):本函数**保留为降级兜底**(正则启发式),生产 decide 由
 * makeLlmCommunicatorDecide 包装 —— 有模型时先跑一次微型 LLM 分类,失败/
 * 超时/离线/无模型/显式关闭(SANSHENG_DECIDE_LLM=0)时降级回这里。
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
  // B2:空 reply = 「chat 交由 Pi session 直答」;不再 sink 占位文本
  return { kind: "chat", reply: "" };
}

/* ─────────────────────────────────────────────────────────
 * 批次 5b-1 · P1 — decide 升级 LLM(正则启发式降级兜底)
 * ───────────────────────────────────────────────────────── */

/** 微型分类 prompt(system)。极简、限制输出长度 → 控制 decide 主路径延迟。 */
const DECIDE_SYSTEM_PROMPT = `你是三生系统的消息分类器。把用户消息分成三类之一,只输出一个 JSON 对象,不要任何解释或代码块围栏:
- chat:闲聊 / 提问 / 讨论,可由对话助手直接回答,无需改动系统或执行多步动作。
- task:需要多步执行 / 修改文件 / 运行命令 / 部署 / 调研并产出结果的明确动作请求。
- feedback:用户自我披露或要求记住的偏好 / 事实(我叫… / 我是… / 我喜欢… / 我讨厌… / 记住…)。
输出格式(严格 JSON):
{"kind":"chat"|"task"|"feedback","taskGoal":"kind=task 时给规划器的一句话目标;否则空串","ack":"kind=task/feedback 时给用户的一句交接/收录确认(≤40字);chat 时空串"}
判别要点:含明显动作词(重构/修复/实现/添加/删除/迁移/部署/写代码/测试/跑一下/安装/配置/查一下/分析/总结)通常是 task;拿不准的寒暄 / 讨论归 chat。`;

/** decide LLM 分类调用超时(ms)。主路径,超时即降级正则。 */
const DECIDE_LLM_TIMEOUT_MS = 3500;
/** 分类输出上限(token)。JSON 很短,限制它避免模型跑飞拉长延迟。 */
const DECIDE_LLM_MAX_TOKENS = 120;
/** 最近上下文:条数 / 单条截断长度。消歧「继续 / 再跑一次」类省略句,代价可忽略。 */
const DECIDE_HISTORY_MAX = 3;
const DECIDE_HISTORY_CHARS = 80;

export interface LlmDecideDeps {
  /** 返回当前 resolved Model;null → 无模型 → 降级正则(不触网)。 */
  getModel: () => Model<any> | null;
  /**
   * DI seam(测试注入):替换默认的 completeSimple 调用。注入时绕过模型/开关闸门
   * (显式注入 = 显式测试意图)。生产不传 → 走 completeSimple(getModel())。
   */
  llmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /** 覆盖超时(ms);默认 3500。 */
  timeoutMs?: number;
  /** 降级函数;默认 defaultCommunicatorDecide(正则启发式,保留不删)。 */
  fallback?: CommunicatorDecideFn;
  /**
   * 可选:返回最近少量对话上下文(user/assistant + content)。
   * 工厂内部再截断到 DECIDE_HISTORY_MAX 条 / DECIDE_HISTORY_CHARS 字符。
   */
  recentHistory?: (conversationId: string) => Array<{ role: "user" | "assistant"; content: string }>;
}

/** 从 raw LLM 输出宽容提取首个 JSON 对象(容忍 ```json fence / 前后噪音)。 */
function extractJson(raw: string): unknown | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let jsonText = trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) {
    jsonText = fence[1].trim();
  } else {
    const start = jsonText.indexOf("{");
    const end = jsonText.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    jsonText = jsonText.slice(start, end + 1);
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

/**
 * 把 LLM 分类 JSON 解析成 CommunicatorDecision;非法 → null(调用方降级正则)。
 * - task:goal=taskGoal(空则回退用户 raw);ack 透传(空则 undefined)
 * - chat:reply="" (直答仍由 Pi session 负责,不产 canned 文本)
 * - feedback:profileDelta={preference:raw}(占位,实际入库走 P4 kernel 侧);ack 透传
 */
function parseDecide(
  raw: string,
  userText: string,
): CommunicatorDecision | null {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const kind = o.kind;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const ack = str(o.ack) || undefined;
  if (kind === "task") {
    return { kind: "task", goal: str(o.taskGoal) || userText.trim(), ...(ack ? { ack } : {}) };
  }
  if (kind === "chat") {
    return { kind: "chat", reply: "" };
  }
  if (kind === "feedback") {
    return {
      kind: "feedback",
      profileDelta: { preference: userText.trim() },
      ...(ack ? { ack } : {}),
    };
  }
  return null;
}

/** 组装分类 userPrompt:[最近对话](可选,截断)+ [当前消息]。 */
function buildDecideUserPrompt(
  userText: string,
  history: Array<{ role: "user" | "assistant"; content: string }> | undefined,
): string {
  const parts: string[] = [];
  const hist = (history ?? []).slice(-DECIDE_HISTORY_MAX);
  if (hist.length > 0) {
    parts.push("[最近对话]");
    for (const h of hist) {
      const body = (h.content ?? "").replace(/\s+/g, " ").trim().slice(0, DECIDE_HISTORY_CHARS);
      parts.push(`${h.role}: ${body}`);
    }
    parts.push("");
  }
  parts.push("[当前消息]");
  parts.push(userText);
  return parts.join("\n");
}

/**
 * 批次 5b-1 · P1:decide 升级 LLM 分类的工厂。返回一个 CommunicatorDecideFn,
 * 语义与 defaultCommunicatorDecide 完全兼容(降级时就是它),但优先用一次微型
 * LLM 分类调用产出 {kind, taskGoal, ack}。
 *
 * 降级(返回正则启发式结果)触发条件——全部落到 `fallback`,绝不抛错:
 *   - 显式关闭:SANSHENG_DECIDE_LLM=0(测试 / 离线卫生闸门;注入 llmCall 时绕过)
 *   - 无模型:getModel() → null(未配置 provider / 未 start)
 *   - LLM 调用抛错 / stopReason=error(离线、网络、鉴权失败)
 *   - 超时(timeoutMs,默认 3500ms)
 *   - 输出解析失败 / kind 非法
 *
 * 延迟控制:system prompt 极简 + maxTokens=120 + 硬超时;decide 在 routeUserMessage
 * 主路径上,超时即降级,不阻塞 WS 其它命令(整体在既有 async 结构内)。
 */
export function makeLlmCommunicatorDecide(deps: LlmDecideDeps): CommunicatorDecideFn {
  const fallback = deps.fallback ?? defaultCommunicatorDecide;
  const timeoutMs = deps.timeoutMs ?? DECIDE_LLM_TIMEOUT_MS;

  // 生产 LLM 出口:completeSimple(ws.ts makeLlmCall 同款模式)。
  const productionCall = async (input: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string> => {
    const model = deps.getModel();
    if (!model) throw new Error("decide: no resolved model");
    const result = await completeSimple(model as Parameters<typeof completeSimple>[0], {
      systemPrompt: input.systemPrompt,
      messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
    }, { maxTokens: DECIDE_LLM_MAX_TOKENS });
    if (result.stopReason === "error" || result.errorMessage) {
      throw new Error(result.errorMessage ?? "completeSimple error");
    }
    const out: string[] = [];
    for (const c of result.content) {
      if (c.type === "text") out.push(c.text);
    }
    return out.join("");
  };

  return async (input: { userText: string; conversationId: string }): Promise<CommunicatorDecision> => {
    const t = input.userText.trim();
    if (!t) return { kind: "chat", reply: "（空消息）" };

    const injected = deps.llmCall;
    // 闸门:未注入 llmCall 时,显式关闭 / 无模型 → 直接降级(不触网)。
    if (!injected) {
      if (process.env.SANSHENG_DECIDE_LLM === "0") return fallback(input);
      if (!deps.getModel()) return fallback(input);
    }

    let history: Array<{ role: "user" | "assistant"; content: string }> | undefined;
    if (deps.recentHistory) {
      try {
        history = deps.recentHistory(input.conversationId);
      } catch {
        history = undefined;
      }
    }
    const userPrompt = buildDecideUserPrompt(input.userText, history);
    const call = injected ?? productionCall;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        call({ systemPrompt: DECIDE_SYSTEM_PROMPT, userPrompt }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("decide timeout")), timeoutMs);
        }),
      ]);
      const decision = parseDecide(raw, input.userText);
      if (!decision) {
        log.muted(`decide: LLM 输出解析失败,降级正则(raw 前 80: ${String(raw).slice(0, 80)})`);
        return fallback(input);
      }
      return decision;
    } catch (err) {
      log.muted(`decide: LLM 分类失败(${(err as Error).message ?? err}),降级正则`);
      return fallback(input);
    } finally {
      // 正常路径也要清 timer,避免悬挂 handle 拖住事件循环(测试/常驻进程)
      if (timer) clearTimeout(timer);
    }
  };
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
 * 批次 5b-2 T3:随 respond() 管道同判 —— 无生产调用方(沉淀职责已由
 * agents/sedimentation.ts 取代),保留供测试与 5b-3 评估。
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
        // B2 修复(批次 5a,docs/CODE-REVIEW-2026-10-01.md §B2):
        // 旧代码无条件 sink decide 的 canned「已收到:…」占位回复(delta/done +
        // broadcast),而 kernel.prompt 随后总会 await session.prompt(text) 产生
        // Pi 真回复 → 用户看到两条(chat 双回复)。
        // 现在:reply 为空(defaultCommunicatorDecide / LLM decide 的 chat 路径)
        // → 不 sink、不 broadcast,chat 回复只来自 Pi session;仅当注入了自定义
        // decideFn 且返回非空 reply(测试)时保留原 sink 行为。
        // 批次 5b-1(P2):task 分支双执行已根治(kernel 对 task/feedback 不再走
        // session.prompt);chat 直答语义不变。
        if (decision.reply) {
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
        }
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
        // 批次 5b-1 P2(§B2 双执行根治):给用户 sink 一条**交接确认**——语义是
        // 交接不是回答,且只此一条(kernel 不再对本消息走 session.prompt 直答;
        // 后续进展走 plan 事件 / plan_done broadcast,批次 3 已保证跨连接可见)。
        // 文案:decide LLM 的 ack 字段优先;降级正则路径用固定简短确认。
        const messageId = nanoid();
        const ackText =
          decision.ack && decision.ack.trim()
            ? decision.ack.trim()
            : "收到任务,已转入规划执行链路。";
        sink({ type: "delta", messageId, text: ackText });
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
        // feedback:批次 5b-1 P4 — sink 一条**收录确认**(LLM decide 的 ack 字段;
        // 正则降级 = 固定文案),语义是「已收下,记忆入库」,不是回答。
        // 记忆本体(fragments/profile)由 kernel.persistHandoff 从用户 raw 提取
        // —— 确认与入库分离,Communicator 保持无存储依赖。
        const messageId = nanoid();
        const ackText = decision.ack && decision.ack.trim() ? decision.ack.trim() : "已记下。";
        sink({ type: "delta", messageId, text: ackText });
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
   *
   * 批次 5b-2 T3 处置标注:**无生产调用方**(5a 关键发现,审查 §B1 实锤)——
   * 生产直答 session 由 kernel.createPiSession 建立并经 DefaultResourceLoader
   * .appendSystemPromptOverride 注入 harness prompt(5a.5 T2);本方法自建的
   * session(含旧路径 ~/.sansheng/system_prompts/communicator.md 读取)不在
   * 任何生产链路上。保留原因:既有测试引用 + respond 管道同判(5b-3 评估)。
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
 *
 * 批次 5b-2 T1 起**脱离死代码**:生产消费方 = agents/sedimentation.ts(回合后
 * 沉淀服务,拆用本函数的 JSON 提取 + artifact 构建 + intent 降级,避免重复实现)。
 * 注意沉淀路径对 parseError 的处置与本文件的 respond 管道不同:沉淀检查
 * parseError 即整轮跳过(宁缺毋滥),**不采用** fallbackToNote 降级产物。
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
 *
 * 批次 5b-2 T3 处置标注(死代码盘点,不删类 —— 有既有测试与 5b-3 评估价值):
 * **无生产调用方**。D7 字面 JSON 直答管道被 jev 裁决 A 方案否决(保流式):
 * 直答 session 由 kernel 拥有(createPiSession,批次 5a.5 T2 经 resourceLoader
 * 注入 harness prompt);「Plan Producer(沉淀)」职责由 sedimentation 服务取代
 * (5b-2 T1:回合后异步提取 D7 artifacts → blackboard,agents/sedimentation.ts)。
 * 本 respond/emitResponse 管道仅测试引用;若 5b-3 评估后仍无消费方,可整段移除。
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

/**
 * emit response 到 sink。
 * 批次 5b-2 T3:随 respond() 管道同判 —— 无生产调用方(仅测试引用);
 * 沉淀产物走 sedimentation 服务的 artifactBus 广播,不经本 sink 管道。
 */
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