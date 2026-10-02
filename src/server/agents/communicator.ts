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
import { resolveModel, syncActiveProviderApiKeyEnv } from "../providers/registry.js";
import type { RunnerSettings } from "./runner.js";
import type {
  BusMessage,
  CommunicatorDecision,
  RoleId,
} from "@shared/types/agents";
import type { MessageBus } from "./messageBus.js";
import { log } from "../../shared/log.js";
import { parseJsonLenient } from "../../shared/jsonRepair.js";
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
const DECIDE_SYSTEM_PROMPT = `你是三生系统的消息分类器。把用户消息分成四类之一,只输出一个 JSON 对象,不要任何解释或代码块围栏:
- chat:闲聊 / 提问 / 讨论,可由对话助手直接回答,无需改动系统或执行多步动作。
- task:需要多步执行 / 修改文件 / 运行命令 / 部署 / 调研并产出结果的明确动作请求,且关键信息已经说清。
- clarify:用户想要一件**明确的活**,但关键信息没说清 —— 你不问清就做,大概率做出来不是他要的。
- feedback:用户自我披露或要求记住的偏好 / 事实(我叫… / 我是… / 我喜欢… / 我讨厌… / 记住…)。
输出格式(严格 JSON):
{"kind":"chat"|"task"|"clarify"|"feedback","taskGoal":"kind=task 时给规划器的一句话目标;否则空串","ack":"kind=task/feedback 时给用户的一句交接/收录确认(≤40字);chat/clarify 时空串","question":"kind=clarify 时问用户的那一个关键问题"}
判别要点:含明显动作词(重构/修复/实现/添加/删除/迁移/部署/写代码/测试/跑一下/安装/配置/查一下/分析/总结)通常是 task;拿不准的寒暄 / 讨论归 chat。

## 什么时候用 clarify(这一条最重要,别滥用)

只在**同时**满足这两条时才用:
① 用户确实要一件明确的活(是 task,不是闲聊);
② 存在一个**你猜错就会整份返工**的关键信息没给。

判定②的信号:目标/范围有歧义、用了一个你不敢确定的说法、交付形态没讲、
评判标准没有、"等等/之类/差不多"后面跟着大范围、或者这个任务的规模分档
差一个数量级。

**绝对不要**为了保险而问:用户已经把「做什么、做成什么样」说清楚了;
或者缺的只是偏好(颜色/措辞/风格)——那种直接做;或者一次能问完的小事。

## 怎么问

- **只问一个**问题,问最关键的那个。一次问三个等于没问。
- 说清楚你为什么需要这个信息,一句话带过即可,别长篇铺垫。
- 给出你的猜测供用户点头或否定,例如「你说的『百外』是指面向百万人规模的
  业务场景吗?如果是,我就按这个口径来调研。」
- 绝对不要用 clarify 来推迟干活 —— 能开工就 task,别拿问题当缓冲。`;

/** decide LLM 分类调用超时(ms)。主路径,超时即降级正则。 */
const DECIDE_LLM_TIMEOUT_MS = 3500;
/**
 * 分类输出上限(token)。JSON 很短,限制它避免模型跑飞拉长延迟。
 *
 * 批次 7-C:120 → 320。clarify 分支要多带一个 `question`(中文问题约 80-120 字,
 * 中文 token 密度高于英文,120 会把它截断 → JSON 解析失败 → 静默降级回
 * task,新功能等于没加)。maxTokens 是**上限不是目标**,模型写完就停,
 * 放宽上限不增加正常路径延迟。
 */
const DECIDE_LLM_MAX_TOKENS = 320;
/** 最近上下文:条数 / 单条截断长度。消歧「继续 / 再跑一次」类省略句,代价可忽略。 */
const DECIDE_HISTORY_MAX = 3;
const DECIDE_HISTORY_CHARS = 80;

export interface LlmDecideDeps {
  /** 返回当前 resolved Model;null → 无模型 → 降级正则(不触网)。 */
  getModel: () => Model<any> | null;
  /**
   * B6(审查 §B6):active provider 的明文 apiKey,显式传给 completeSimple。
   * 旧实现在 resolveModel 里把它写进 process.env,任何解析模型的动作(包括
   * 这条 decide 单轮补全)都会让明文 key 留在进程 env 里;现在 decide 走显式
   * 传参(kernel.getModelApiKey() 注入),env 只在 Pi session 建之前同步一次。
   */
  getApiKey?: () => string | undefined;
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
  if (kind === "clarify") {
    // question 为空 → 当作没问出来,降级正则(宁可 task 也不要空问一句)
    const question = str(o.question);
    if (!question) return null;
    return { kind: "clarify", question, ...(str(o.context) ? { context: str(o.context) } : {}) };
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
    const apiKey = deps.getApiKey?.();
    const result = await completeSimple(model as Parameters<typeof completeSimple>[0], {
      systemPrompt: input.systemPrompt,
      messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
    }, { maxTokens: DECIDE_LLM_MAX_TOKENS, ...(apiKey ? { apiKey } : {}) });
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

/* ─────────────────────────────────────────────────────────
 * 批次 7-E · 对齐闸门(开工前先确认「这是不是他想要的」)
 * ───────────────────────────────────────────────────────── */

/**
 * 对齐提问 prompt。**刻意与 decide 分开成一次独立调用**,而不是给 decide 再加一类:
 *
 * - decide 已经是四选一 + 3.5s 硬超时,再塞一个「要不要问」的判断进去,它会
 *   倾向于选省事的那条(实测 7-C 之后仍稳定判 task,从不 clarify);
 * - 单一职责的提示词可靠得多 —— 只问「开工前最该确认的一件事是什么」;
 * - 有明确的 `NONE` 出口,「别烦用户」这件事可以被显式表达;
 * - 只在 task 分支跑,chat 路径延迟不受影响。
 */
const ALIGN_SYSTEM_PROMPT = `你在开工前做一次对齐检查。用户提了一个要执行的任务,你的唯一职责是:判断**有没有一件你猜错就会整份返工的关键信息**,用户没给。

有的话,问**一个**问题(用户一次只想回答一件事),带上你的猜测让他点头或否定。
没有的话,只输出 NONE,一个字都不要多。

只在下面这些情况才提问:
- 目标或范围有歧义(用了一个你不敢确定的说法、缩写、圈内黑话)
- 交付形态没讲(要文档?代码?数据?还是就要个结论)
- 评判标准没有(怎么算做好了)
- 这个任务跑起来很贵 / 很不可逆,而需求边界又不清楚

**不要**问这些(它们不值得打断用户):
- 措辞、风格、颜色这类偏好 —— 你自己定就行
- 你可以从上下文合理推断的东西
- 一次问三个问题(那等于没问)
- 已经说清楚的任务(用户把「做什么、做成什么样」都讲了)
- **已经问过并且用户已经回答过的**(见「最近对话」)—— 换个说法再问一遍就是骚扰,
  用户会陷入无限澄清循环。已回答就输出 NONE,直接开工。

输出格式(严格 JSON,不要代码块围栏):
{"question":"要问的那一个问题,或字符串 NONE"}`;

const ALIGN_MAX_TOKENS = 256;
const ALIGN_TIMEOUT_MS = 6000;

export interface AlignCheckDeps {
  getModel: () => Model<any> | null;
  getApiKey?: () => string | undefined;
  /** DI seam(测试注入):替换 completeSimple。注入时绕过模型/开关闸门。 */
  llmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /**
   * 开工前检查会把问题**重复问一遍** —— 因为它看不到自己上一轮问了什么、
   * 用户答了什么,于是对着同一个 goal 重新发现「百外」不确定,再问一次。
   * 无限澄清循环就是这么来的。
   *
   * 这里提供最近对话(同 decide 的 recentHistory 语义:≤3 条、每条截断)让闸门
   * 知道自己问过什么;ALIGN_SYSTEM_PROMPT 里也有对应约束。
   */
  recentHistory?: (conversationId: string) => Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  /** 覆盖超时(ms);默认 6000。 */
  timeoutMs?: number;
}

/**
 * 对齐检查:返回**要问的问题**,或 null(不用问,直接开工)。
 * 任何失败(无模型 / 超时 / 解析失败 / 抛错)都返回 null —— 宁可开工,
 * 也不能因为闸门本身出错把用户的任务卡死。
 */
export function makeAlignmentCheck(deps: AlignCheckDeps): AlignmentCheckFn {
  const timeoutMs = deps.timeoutMs ?? ALIGN_TIMEOUT_MS;
  return async (input: { goal: string; userText: string; conversationId: string }) => {
    // 卫生闸门(与 SANSHENG_DECIDE_LLM / SANSHENG_SEDIMENT 同款):显式关闭,
    // 或测试环境全局置 0,避免集成测试每条 task 消息都发起一次真实 HTTP 对齐请求。
    // 注入 llmCall 时绕过(显式注入 = 显式测试意图)。
    if (!deps.llmCall) {
      if (process.env.SANSHENG_ALIGN === "0") return null;
      if (!deps.getModel()) return null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: string;
    try {
      const buildPrompt = () =>
        buildAlignUserPrompt(input.goal, input.userText, readRecent(deps, input.conversationId));
      const call = async (): Promise<string> => {
        if (deps.llmCall) {
          return deps.llmCall({ systemPrompt: ALIGN_SYSTEM_PROMPT, userPrompt: buildPrompt() });
        }
        const model = deps.getModel();
        if (!model) return "";
        const apiKey = deps.getApiKey?.();
        const result = await completeSimple(
          model as Parameters<typeof completeSimple>[0],
          {
            systemPrompt: ALIGN_SYSTEM_PROMPT,
            messages: [
              { role: "user", content: buildPrompt(), timestamp: Date.now() },
            ],
          },
          { maxTokens: ALIGN_MAX_TOKENS, ...(apiKey ? { apiKey } : {}) },
        );
        if (result.stopReason === "error" || result.errorMessage) return "";
        const parts: string[] = [];
        for (const c of result.content) if (c.type === "text") parts.push(c.text);
        return parts.join("");
      };

      // 硬超时:llmCall 不可中断(签名里没有 AbortSignal),不设上限的话
      // provider 挂住会连带把用户的 task 一起卡死 —— 闸门绝不能比它守的门更慢。
      raw = await Promise.race([
        call(),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(""), timeoutMs);
        }),
      ]);
    } catch (err) {
      log.muted(`align: 调用失败(${(err as Error).message ?? err}),不拦,直接开工`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!raw) return null;
    const parsed = parseJsonLenient<{ question?: unknown }>(raw);
    if (!parsed.ok) return null;
    const q = (parsed.value?.question ?? "").toString().trim();
    // NONE / 空 / 「无」等占位 → 不用问
    if (!q || /^(none|n\/a|null|无|不需要|不用)$/i.test(q)) return null;
    return q;
  };
}

function buildAlignUserPrompt(
  goal: string,
  userText: string,
  history: Array<{ role: "user" | "assistant"; content: string }> | undefined,
): string {
  const parts: string[] = [];
  if (history && history.length > 0) {
    parts.push("[最近对话]");
    for (const h of history.slice(-DECIDE_HISTORY_MAX)) {
      const body = (h.content ?? "").replace(/\s+/g, " ").trim().slice(0, DECIDE_HISTORY_CHARS);
      parts.push(`${h.role}: ${body}`);
    }
    parts.push("");
  }
  parts.push("[任务目标]");
  parts.push(goal);
  parts.push("");
  parts.push("[用户原话]");
  parts.push(userText);
  parts.push("");
  parts.push(
    "开工前,有没有一件你猜错就会整份返工的关键信息,用户没给?有就问一个,没有就输出 NONE。",
  );
  return parts.join("\n");
}

/** 读最近对话;读取失败视作没有历史(闸门不能因为取历史失败就失效)。 */
function readRecent(
  deps: AlignCheckDeps,
  conversationId: string,
): Array<{ role: "user" | "assistant"; content: string }> | undefined {
  if (!deps.recentHistory) return undefined;
  try {
    return deps.recentHistory(conversationId);
  } catch {
    return undefined;
  }
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
  /**
   * 批次 7-E:对齐闸门 —— decide 判 task 后、真正开工**之前**问一次
   * 「有没有你猜错就会返工的关键信息」。返回问题字符串 = 先问用户;
   * 返回 null = 不用问,直接开工。不提供则完全跳过该闸门(旧行为)。
   */
  alignmentCheck?: AlignmentCheckFn;
}

export type AlignmentCheckFn = (input: {
  goal: string;
  userText: string;
  conversationId: string;
}) => Promise<string | null>;

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
  /**
   * 批次 7-E:已提问但用户还没回答的任务。
   *
   * 为什么必须存:用户在 clarify 里回的那句话(「是,面向百万级外呼,交付文档」)
   * **单独看不像一个 task** —— decide 拿到它多半会判 chat,任务就丢了。
   * 存住原 goal,下一轮把它和用户补充拼起来再 decide,任务才接得上。
   *
   * 带 conversationId 是防御:Communicator 实例虽然按 kernel(=按会话)创建,
   * 但 kernel 切会话时未必重建 Communicator,不校验就可能把 A 会话的任务
   * 接到 B 会话上。
   */
  private pendingTask: { goal: string; question: string; conversationId: string } | null = null;

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
      // 批次 7-E:若上一轮刚问过对齐问题而用户在回答,把原 goal 和这句补充
      // 拼起来再 decide —— 否则「是,面向百万级外呼」这种回答会被判成 chat,
      // 任务凭空消失。落库/回显仍用 userText 原文,拼接过的东西不污染消息。
      const carried =
        this.pendingTask && this.pendingTask.conversationId === conversationId
          ? this.pendingTask.goal
          : null;
      const decideText = carried ? `${carried}\n\n【用户补充】${userText}` : userText;

      const decision = await this.decideFn({ userText: decideText, conversationId });

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
      } else if (decision.kind === "clarify") {
        // 批次 7-C:需求没说清 → 先问一个关键问题,**不委派**。
        //
        // 语义与 chat 相同(普通 assistant 回复,用户看得见),但**必须**走
        // 显式 sink:chat 的回复来自 Pi session 直答,clarify 没有 Pi turn
        // —— kernel 侧对 clarify 与 task 一样提前 return(见 agentKernel
        // promptInner),不会 fallback 到 session.prompt。所以这条问题
        // 完全由这里发出。
        //
        // 不调 onTask:用户还没确认要什么,派下去就是在赌。
        const messageId = nanoid();
        const text = decision.context
          ? `${decision.context}\n\n${decision.question}`
          : decision.question;
        sink({ type: "delta", messageId, text });
        sink({ type: "done", messageId });
        const msg = this.opts.bus.broadcast({
          fromRole: "communicator",
          toRole: "user",
          conversationId,
          payload: text,
          context: { source: "decide_clarify" },
        });
        sink({ type: "bus_event", message: msg });
        log.muted(`decide: clarify asked, awaiting user answer (conv=${conversationId})`);
      } else if (decision.kind === "task") {
        // 批次 7-E:对齐闸门 —— 开工**之前**先确认「这是不是他想要的」。
        //
        // 用户 2026-10-02 原话:「在 plan 模式下我觉得他需要和我对齐我想要什么」。
        // decide 已经在四选一 + 3.5s 硬超时下稳定偏向 task(7-C 之后仍从不
        // clarify),所以对齐不能继续压在 decide 上 —— 单独问一次。
        //
        // 闸门自身任何失败都放行(见 makeAlignmentCheck),不能因为闸门出错
        // 把用户的任务卡死;这里再兜一层 catch 防御注入方抛错。
        let question: string | null = null;
        if (this.opts.alignmentCheck) {
          try {
            question = await this.opts.alignmentCheck({
              goal: decision.goal,
              userText,
              conversationId,
            });
          } catch (err) {
            log.warn(
              `align: threw(${(err as Error).message ?? err}),放行直接开工`,
            );
            question = null;
          }
        }
        if (question) {
          // 存住原 goal:用户回答的那句本身不像 task,要带着 goal 再 decide
          this.pendingTask = { goal: decision.goal, question, conversationId };
          const qid = nanoid();
          const qtext = `开工前先跟你对一下:${question}`;
          sink({ type: "delta", messageId: qid, text: qtext });
          sink({ type: "done", messageId: qid });
          const qmsg = this.opts.bus.broadcast({
            fromRole: "communicator",
            toRole: "user",
            conversationId,
            payload: qtext,
            context: { source: "align_check" },
          });
          sink({ type: "bus_event", message: qmsg });
          log.muted(`align: 拦下开工,已向用户提问 (conv=${conversationId})`);
          // 语义上返回 clarify:kernel 会 persistHandoff(落库 raw + 这条提问)
          // 并**不**走 Pi 直答,也不会触发 onTask。
          return { kind: "clarify", question: qtext, context: decision.goal };
        }
        this.pendingTask = null;

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
    // B6(审查 §B6):resolveModel 已改成不碰 process.env 的纯函数,凡是建 Pi
    // session 的调用方都要显式同步一次 active provider 的 env(见
    // registry.ts syncActiveProviderApiKeyEnv 注释与 kernel.createPiSession)。
    syncActiveProviderApiKeyEnv(this.opts.settings.provider, this.opts.settings.apiKey);
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