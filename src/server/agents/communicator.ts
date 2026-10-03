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
// 批次 7-G:两个提示词搬进 harness 版本链(promptUnits.ts),此处 re-export 保持
// 既有 import 路径可用;消费方的回退值来自 deps.systemPrompt ?? 内置常量。
import {
  DECIDE_SYSTEM_PROMPT,
  ALIGN_SYSTEM_PROMPT,
  WORKER_ASK_SYSTEM_PROMPT,
} from "../harness/promptUnits.js";
export { DECIDE_SYSTEM_PROMPT, ALIGN_SYSTEM_PROMPT, WORKER_ASK_SYSTEM_PROMPT };
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
import { isSedimentForm, type SedimentForm } from "../../../shared/types/blackboard.js";

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
  (input: {
    userText: string;
    conversationId: string;
    /**
     * 批次 8-E:「用户正在回答一个对齐问题」的状态位。
     *
     * 存在的理由是一次**实机事故**(2026-10-03,conv_murrw192_wxbg):
     * 闸门问了「C 端还是 B 端?」,用户答「C 端个人逾期用户」,decide 却判了 chat ——
     * 因为这句话本身没有任何指令性动词,四选一里天然偏向 chat。于是系统**永远等不到
     * 那句「开始吧」**,用户只能眼看着「需求已交接给规划链路」的承诺落空(全程 0 工件)。
     * 把状态显式喂给 decide,让它知道「这不是一句闲聊,这是对我上一个问题的回答」。
     */
    alignment?: { question: string; goal: string };
  }): Promise<CommunicatorDecision>;
}

/**
 * 批次 8-E:用户「收回」对齐回答的关键词。
 *
 * 这是「答完即开工」的**逃生舱**:闸门问过之后,绝大多数回答都该直接开工;
 * 但用户也可能说「算了,先不做了」。没有这个舱,强制开工会变成另一种骚扰。
 * 刻意收得很窄 —— 只认明确的放弃语义,「停一下/等等」这种半途改主意的话不在内,
 * 因为它们更可能是「补一句条件」而不是「取消任务」。
 */
const DECLINE_ANSWER_RE =
  /(?:算了|不做了|先不做(?:了)?|先不搞了|不搞了|放弃(?:了)?|取消(?:任务|计划)?|这个不做了|不需要了)/;

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
  /**
   * 批次 7-G:harness `system_prompts/communicator.decide.md` 的内容。
   * 空/未注入 → 回退 `DECIDE_SYSTEM_PROMPT`(编译内置)。
   * **sensitivity=contract**:改坏了会破坏 classify JSON 的解析,靠回退兜底。
   */
  systemPrompt?: string;
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
  alignment?: { question: string; goal: string },
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
  if (alignment) {
    // 批次 8-E:把「这是在回答我的问题」这件事写进 decide 的输入。
    // 放在[当前消息]之前 —— decide 是四选一分类器,不给它这个前提,
    // 「C 端个人逾期用户」这种纯答案必然被判成 chat(实机事故,见 CommunicatorDecideFn.alignment)。
    parts.push("[当前状态] 你上一轮为了开工前对齐,问了用户一个问题。");
    parts.push("你问的:" + alignment.question);
    parts.push("用户正在回答这个问题。");
    parts.push("除非用户的回答明确表示「不做了 / 算了 / 取消」,否则这一轮应判为 task。");
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

  return async (input: {
    userText: string;
    conversationId: string;
    alignment?: { question: string; goal: string };
  }): Promise<CommunicatorDecision> => {
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
    const userPrompt = buildDecideUserPrompt(input.userText, history, input.alignment);
    const call = injected ?? productionCall;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        call({ systemPrompt: deps.systemPrompt?.trim() ? deps.systemPrompt : DECIDE_SYSTEM_PROMPT, userPrompt }),
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

const ALIGN_MAX_TOKENS = 256;
const ALIGN_TIMEOUT_MS = 6000;

export interface AlignCheckDeps {
  getModel: () => Model<any> | null;
  getApiKey?: () => string | undefined;
  /** DI seam(测试注入):替换 completeSimple。注入时绕过模型/开关闸门。 */
  llmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /**
   * 批次 7-G:harness `system_prompts/communicator.align.md` 的内容。
   * 空/未注入 → 回退 `ALIGN_SYSTEM_PROMPT`。**sensitivity=contract**。
   */
  systemPrompt?: string;
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
      // 批次 7-G:harness 值优先,空则回退编译内置(与 decide 同款语义)
      const alignPrompt = deps.systemPrompt?.trim() ? deps.systemPrompt : ALIGN_SYSTEM_PROMPT;
      const call = async (): Promise<string> => {
        if (deps.llmCall) {
          return deps.llmCall({ systemPrompt: alignPrompt, userPrompt: buildPrompt() });
        }
        const model = deps.getModel();
        if (!model) return "";
        const apiKey = deps.getApiKey?.();
        const result = await completeSimple(
          model as Parameters<typeof completeSimple>[0],
          {
            systemPrompt: alignPrompt,
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

/* ─────────────────────────────────────────────────────────
 * 批次 7-L · worker 提问的判断轮(总线真正的收件人是沟通员,不是用户)
 * ───────────────────────────────────────────────────────── */

/** 判断轮输入:执行者递上来的完整求助内容。 */
export interface WorkerAskInput {
  /** 执行者写的完整问题(hypothesis 标题 + 正文,不是一句摘要)。 */
  question: string;
  /** judgment | harness_proposal —— 决定判断轮用什么口径。 */
  reason: string;
  conversationId: string;
  fromRole: RoleId;
  todoId?: string;
}

/**
 * 判断轮结论。
 * - `answer`  :沟通员自己答 —— answer 会作为 decision 直接下发给执行者,
 *               **不惊动用户**。这是 7-L 之后绝大多数提问的归宿。
 * - `escalate`:沟通员答不了 —— question 是**沟通员自己写的**问法,
 *               且必须带上 lean(我的倾向)与 ruledOut(我已排除什么)。
 */
export type WorkerAskVerdict =
  | { kind: "answer"; answer: string; basis: string }
  | { kind: "escalate"; question: string; lean?: string; ruledOut?: string };

export type WorkerAskAdjudicateFn = (input: WorkerAskInput) => Promise<WorkerAskVerdict | null>;

/**
 * `handleWorkerAsk` 的宿主侧钩子。Communicator 不认识 executorSessionId、
 * 也不写 Blackboard —— 它只负责「判断」,解阻塞执行者由 kernel 做。
 */
export interface WorkerAskHooks {
  /** 覆盖 `opts.workerAskAdjudicate`(测试可单点注入)。 */
  adjudicate?: WorkerAskAdjudicateFn | null;
  /** 升级用户时**先**回调:登记 questionId → executorSessionId。 */
  onEscalate?: (questionId: string) => void;
  /** 沟通员自己答完时回调:写 decision artifact + 恢复执行者。 */
  onAnswer?: (questionId: string, answer: string) => void;
}

const WORKER_ASK_MAX_TOKENS = 400;
const WORKER_ASK_TIMEOUT_MS = 8000;

export interface WorkerAskAdjudicateDeps {
  getModel: () => Model<any> | null;
  getApiKey?: () => string | undefined;
  /** DI seam(测试注入):替换 completeSimple。注入时绕过模型/开关闸门。 */
  llmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /** 批次 7-G:harness `system_prompts/communicator.worker_ask.md`;空 → 内置常量。 */
  systemPrompt?: string;
  /**
   * 最近对话 —— 「已经与用户对齐过的信息」就是判断轮的弹药。
   * 与 align 闸门同款理由:看不到自己问过什么,就会把同一个问题再问一遍用户。
   */
  recentHistory?: (conversationId: string) => Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  /** 覆盖超时(ms);默认 8000。 */
  timeoutMs?: number;
}

/**
 * 构造判断轮:执行者卡住时,沟通员**先自己判一轮**。
 *
 * 失败语义与 align 闸门**故意相反**:
 * - align 失败 → 放行(宁可开工,别把用户卡在闸门上);
 * - 判断轮失败 → 返回 null = **照旧升级用户**。
 *
 * 理由:升级是 7-L 之前**一直存在**的安全路径(用户至少还能拍板),
 * 而「沟通员自己答」是新增能力 —— 判不出来时退回旧路径,最坏结果是
 * 「还是问了用户」,即今天的行为,不会更差。反过来 fail-open 到 answer
 * 则可能让沟通员在没判断成的情况下替用户拍板,那才是真事故。
 */
export function makeWorkerAskAdjudicate(deps: WorkerAskAdjudicateDeps): WorkerAskAdjudicateFn {
  const timeoutMs = deps.timeoutMs ?? WORKER_ASK_TIMEOUT_MS;
  return async (input) => {
    // 卫生闸门(与 SANSHENG_DECIDE_LLM / SANSHENG_ALIGN 同款)
    if (!deps.llmCall) {
      if (process.env.SANSHENG_WORKER_ASK === "0") return null;
      if (!deps.getModel()) return null;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: string;
    try {
      const buildPrompt = () => buildWorkerAskUserPrompt(input, readRecent(deps, input.conversationId));
      // 批次 7-G:harness 值优先,空则回退编译内置(与 decide / align 同款语义)
      const sys = deps.systemPrompt?.trim() ? deps.systemPrompt : WORKER_ASK_SYSTEM_PROMPT;
      const call = async (): Promise<string> => {
        if (deps.llmCall) return deps.llmCall({ systemPrompt: sys, userPrompt: buildPrompt() });
        const model = deps.getModel();
        if (!model) return "";
        const apiKey = deps.getApiKey?.();
        const result = await completeSimple(
          model as Parameters<typeof completeSimple>[0],
          {
            systemPrompt: sys,
            messages: [{ role: "user", content: buildPrompt(), timestamp: Date.now() }],
          },
          { maxTokens: WORKER_ASK_MAX_TOKENS, ...(apiKey ? { apiKey } : {}) },
        );
        if (result.stopReason === "error" || result.errorMessage) return "";
        const parts: string[] = [];
        for (const c of result.content) if (c.type === "text") parts.push(c.text);
        return parts.join("");
      };

      // 硬超时:执行者在 waiting_for_decision 上等着,判断轮不能无限期占着
      raw = await Promise.race([
        call(),
        new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve(""), timeoutMs);
        }),
      ]);
    } catch (err) {
      log.warn(`worker_ask: 判断轮调用失败(${(err as Error).message ?? err}),退回升级用户`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!raw.trim()) return null;
    return parseWorkerAskVerdict(raw);
  };
}

/**
 * 解析判断轮输出。返回 null = 解析不出来 → 调用方退回升级用户。
 * 单独导出便于直接单测(不必起一次假 LLM)。
 */
export function parseWorkerAskVerdict(raw: string): WorkerAskVerdict | null {
  const parsed = parseJsonLenient<Record<string, unknown>>(raw);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") return null;
  const v = parsed.value;
  const verdict = String(v["verdict"] ?? "").trim().toLowerCase();
  if (verdict === "answer") {
    const answer = String(v["answer"] ?? "").trim();
    if (!answer) return null;
    return { kind: "answer", answer, basis: String(v["basis"] ?? "").trim() };
  }
  if (verdict === "escalate") {
    const question = String(v["question"] ?? "").trim();
    if (!question) return null;
    const lean = String(v["lean"] ?? "").trim();
    const ruledOut = String(v["ruledOut"] ?? "").trim();
    return {
      kind: "escalate",
      question,
      ...(lean ? { lean } : {}),
      ...(ruledOut ? { ruledOut } : {}),
    };
  }
  return null;
}

function buildWorkerAskUserPrompt(
  input: WorkerAskInput,
  history: Array<{ role: "user" | "assistant"; content: string }> | undefined,
): string {
  const parts: string[] = [];
  if (history && history.length > 0) {
    parts.push("[最近对话(已与用户对齐过的信息)]");
    for (const h of history.slice(-DECIDE_HISTORY_MAX)) {
      const body = (h.content ?? "").replace(/\s+/g, " ").trim().slice(0, DECIDE_HISTORY_CHARS);
      parts.push(`${h.role}: ${body}`);
    }
    parts.push("");
  }
  parts.push(`[发起方] ${input.fromRole}`);
  parts.push(`[理由] ${input.reason}`);
  parts.push("");
  parts.push("[执行者的问题(全文)]");
  parts.push(input.question || "(执行者没写正文)");
  parts.push("");
  parts.push("先判断一轮:你能自己拍板就答,只有真的需要用户拍板才升级。");
  return parts.join("\n");
}

/**
 * 把升级结论拼成给用户看的一段话。
 *
 * lean / ruledOut 是**必带**的:用户是被叫来拍板的,不是被叫来替沟通员干活的。
 * 只把执行者的原话转述一遍(7-L 之前的样子),用户既不知道该选什么,
 * 也不知道你已经替他排除了什么 —— 那不是省事,是把成本原样转嫁。
 */
function buildEscalationText(v: Extract<WorkerAskVerdict, { kind: "escalate" }>): string {
  const parts = [v.question];
  if (v.lean) parts.push(`我的倾向:${v.lean}`);
  if (v.ruledOut) parts.push(`我已经排除:${v.ruledOut}`);
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
  /**
   * 批次 7-L:worker 提问的**判断轮**。执行者卡住时总线上的问题是问沟通员的,
   * 沟通员先自己判一轮:能答就答(不惊动用户),答不了才升级给用户。
   * 不提供 = 跳过判断轮,恢复 7-L 之前「一律直接问用户」的行为。
   */
  workerAskAdjudicate?: WorkerAskAdjudicateFn | null;
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
      const pending =
        this.pendingTask && this.pendingTask.conversationId === conversationId
          ? this.pendingTask
          : null;
      const carried = pending ? pending.goal : null;
      const decideText = carried ? `${carried}\n\n【用户补充】${userText}` : userText;

      // 批次 8-E:把「用户正在回答我刚问的对齐问题」这件事**显式**喂给 decide。
      // 7-E 只做了「把原 goal 拼进 decideText」,于是 decide 看到的是一句
      // 「C 端个人逾期用户」—— 纯答案、无指令动词,四选一里必然落到 chat,
      // 系统永远等不到那句「开始吧」(实机事故:conv_murrw192_wxbg 全程 0 工件)。
      let decision = await this.decideFn({
        userText: decideText,
        conversationId,
        ...(pending ? { alignment: { question: pending.question, goal: pending.goal } } : {}),
      });

      // 批次 8-E(E1):答完即开工。decide 仍然说话(逃生舱在下面),但**用户既然回答了
      // 我问的问题,就不该让任务原地消失** —— 除非他明确说不要了。
      // 这条规则是确定性兜底,不依赖模型「这次应该判对了」。
      if (pending && DECLINE_ANSWER_RE.test(userText)) {
        // 逃生舱:用户**明说不要了** → 无条件不开工,连 decide 说什么都不听。
        // 「算了」之后还把活派出去,比多问一句恶劣得多。reply 留空 = 不 sink,
        // 由 Pi 直答(与既有 chat 语义一致)。
        log.muted("decide: 用户收回了对齐回答,不开工");
        this.pendingTask = null;
        decision = { kind: "chat", reply: "" };
      } else if (pending && decision.kind !== "task") {
        log.muted(
          `decide: 用户正在回答对齐问题(${decision.kind}→task 强制),goal=${pending.goal.slice(0, 40)}`,
        );
        decision = {
          kind: "task",
          goal: `${pending.goal}\n\n【用户对齐回答】${userText}`,
        };
      }

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
        // 批次 8-E(E2):**已经问过就不问第二次**。这是代码层去重,不靠模型自觉 ——
        // 实机事故里同一个问题被换了个措辞又问了一遍(用户当场质问「上下文清空了吗」)。
        // ALIGN_SYSTEM_PROMPT 里那条「已经问过就别再问」对人有效、对模型不可靠。
        if (this.opts.alignmentCheck && !pending) {
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
   * 处理 worker 提问 —— 批次 7-L 起,这条链路的收件人是**沟通员**,不是用户。
   *
   * 三条路径:
   * 1. `knowIt=true`(显式已知 / 老测试):直接 reply,与 7-L 之前一致;
   * 2. **判断轮**(`opts.workerAskAdjudicate`):先让沟通员自己判一轮。
   *    - verdict=answer  → 记一条 comm→worker 的 reply,`hooks.onAnswer` 让 kernel
   *      写 decision artifact + `executor_resume`。**用户完全不知情,零打扰。**
   *    - verdict=escalate → 沟通员**自己**重新起一个 `q-comm-*` 问题问用户
   *      (带 lean / ruledOut),`hooks.onEscalate` 让 kernel 立刻登记
   *      questionId → executorSessionId;
   * 3. 没有判断轮 / 判断轮失败:退回 7-L 之前的行为(原样升级)。
   *
   * 为什么 escalate 要**换一个新 id**:审计流要如实记录两级交互 ——
   * `worker→comm` 是执行者问沟通员,`comm→user` 才是沟通员问用户。
   * 沿用 q-exec-* 会让 timeline 上看起来像执行者直接找用户,那正是本批次
   * 要修的病。
   */
  async handleWorkerAsk(
    questionMessage: BusMessage,
    knowIt: boolean,
    replyPayload: string,
    sink: CommunicatorSink,
    hooks?: WorkerAskHooks,
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

    // 批次 7-L:判断轮。先问自己「我能答吗」,再决定要不要惊动用户。
    const adjudicate = hooks?.adjudicate ?? this.opts.workerAskAdjudicate ?? null;
    let verdict: WorkerAskVerdict | null = null;
    if (adjudicate) {
      try {
        verdict = await adjudicate({
          question: questionMessage.payload,
          reason: String(questionMessage.context?.["reason"] ?? "judgment"),
          conversationId: questionMessage.conversationId,
          fromRole: questionMessage.fromRole as RoleId,
          ...(questionMessage.context?.["todoId"]
            ? { todoId: String(questionMessage.context["todoId"]) }
            : {}),
        });
      } catch (err) {
        // 判不出来不是事故 —— 退回升级即可(见 makeWorkerAskAdjudicate 的失败语义)
        log.warn(`worker_ask: 判断轮抛错(${(err as Error).message ?? err}),退回升级用户`);
        verdict = null;
      }
    }

    // 路径 2-A:沟通员自己答 —— 不打扰用户,直接把决定下发给执行者。
    if (verdict?.kind === "answer") {
      const replyMsg = this.recordWorkerReply(questionMessage, verdict.answer);
      sink({ type: "bus_event", message: replyMsg });
      try {
        hooks?.onAnswer?.(questionMessage.id, verdict.answer);
      } catch (err) {
        log.warn(`worker_ask: onAnswer threw: ${(err as Error).message ?? err}`);
      }
      log.muted(
        `worker_ask: 沟通员自己答了(${questionMessage.fromRole} 的问题),不惊动用户 (${questionMessage.id.slice(0, 12)})`,
      );
      return { replied: true, questionId: questionMessage.id };
    }

    // 路径 2-B / 3:升级给用户。有判断轮结论就用**沟通员自己写的问法**。
    const escalate = verdict?.kind === "escalate" ? verdict : null;
    const pendingId = escalate ? `q-comm-${nanoid(8)}` : questionMessage.id;
    const payload = escalate ? buildEscalationText(escalate) : questionMessage.payload;
    if (escalate) {
      // 记一条 comm→user 的 question:用户看到的是**沟通员在问**,不是执行者在问
      this.opts.bus.recordExternal({
        id: pendingId,
        ts: Date.now(),
        direction: "comm→user",
        fromRole: "communicator",
        toRole: "user",
        conversationId: questionMessage.conversationId,
        kind: "question",
        payload,
        context: {
          source: "worker_ask_escalate",
          workerQuestionId: questionMessage.id,
          workerRole: questionMessage.fromRole,
          ...(escalate.lean ? { lean: escalate.lean } : {}),
          ...(escalate.ruledOut ? { ruledOut: escalate.ruledOut } : {}),
        },
      });
    }
    // 先登记再通知:用户的回答随时可能到达(ws 与 sink 是异步的),
    // 顺序反了就会有一小段「问题已发出但 server 端查无此题」的窗口。
    try {
      hooks?.onEscalate?.(pendingId);
    } catch (err) {
      log.warn(`worker_ask: onEscalate threw: ${(err as Error).message ?? err}`);
    }
    sink({
      type: "pending_question",
      questionId: pendingId,
      payload,
      fromRole: escalate ? "communicator" : (questionMessage.fromRole as RoleId),
    });
    if (escalate) {
      log.muted(
        `worker_ask: 沟通员答不了,已升级用户 (${questionMessage.id.slice(0, 12)} → ${pendingId})`,
      );
    }
    return { replied: false, questionId: pendingId };
  }

  /**
   * 把「沟通员自己答」记成一条 comm→worker 的 reply。
   *
   * 为什么不用 `bus.reply()`:executor 的提问是 kernel 用 `recordExternal`
   * 记进来的(MessageBus.pending 里**没有**它 —— 那个通道的等待方是
   * Orchestrator 的 watchdog,不是 bus 的 300s)。所以这里显式造一条 reply
   * 进流,让 timeline / bus.jsonl 看得见「worker 问 → 沟通员答」这一段,
   * 而真正解阻塞执行者的是 hooks.onAnswer(kernel 侧写 decision + resume)。
   */
  private recordWorkerReply(questionMessage: BusMessage, answer: string): BusMessage {
    return this.opts.bus.recordExternal({
      id: nanoid(),
      ts: Date.now(),
      direction: "comm→worker",
      fromRole: "communicator",
      toRole: questionMessage.fromRole,
      conversationId: questionMessage.conversationId,
      kind: "reply",
      questionId: questionMessage.id,
      payload: answer,
    });
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
    // 覆盖或内置沟通员提示词 fallback(undefined → loader 用默认 AGENTS.md)
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
/**
 * 批次 7-J:旧 D7 四形态 → `SedimentForm` 的兼容映射。
 *
 * 沉淀提示词换版后模型应该发 `{"kind":"insight","form":...}`;但提示词下发是
 * **异步**的(有的会话用的是缓存文件、有的模型在途),所以解析层必须容忍旧形状 ——
 * 直接丢弃会导致升级窗口内沉淀静默归零,那比「多一个字段」糟糕得多。
 * 这张表让旧输出**无损**落到新词汇上。
 */
const LEGACY_SEDIMENT_FORM: Partial<Record<ArtifactKind, SedimentForm>> = {
  intent: "goal",
  decision: "decision",
  hypothesis: "hypothesis",
  note: "fact",
};

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

    // ── 批次 7-J:沉淀认知状态与工作流 kind 拆开 ──────────────────────────
    // 模型发 `{"kind":"insight","form":"goal"}` → 直接用。
    // 模型仍在发旧四形态(intent/decision/hypothesis/note)→ **映射**而不是丢弃:
    // 沉淀是 fire-and-forget 的单轮调用,提示词换新到模型跟上是**异步**的,
    // 直接丢会让升级期间的所有沉淀归零(拿不到新 prompt 的在途模型就哑了)。
    // 映射后一律落 `insight`,认知状态进 form。
    let finalKind = kind;
    let downgraded: "imperative-missing" | undefined;
    let form: SedimentForm | undefined;
    if (kind === "insight") {
      form = isSedimentForm(a.form) ? a.form : "fact";
    } else {
      const mapped = LEGACY_SEDIMENT_FORM[kind];
      if (mapped !== undefined) {
        finalKind = "insight";
        form = mapped;
      }
    }
    // 旧语义保留:「声称是目标(旧 intent)但标题没有动作词、也没挂 refs」
    // → 不是真目标,降级成「推测」。7-J 之后作用于 form=goal 的 insight。
    if (form === "goal") {
      const title = typeof a.title === "string" ? a.title : "";
      const verbOk = hasImperativeVerb(title);
      const refsOk = !!(refs && refs.length > 0);
      if (!verbOk && !refsOk) {
        form = "hypothesis";
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
      intentValid: (kind === "intent" || form === "goal") ? !downgraded : true,
      downgraded,
      form,
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