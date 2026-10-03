/**
 * Sansheng · 终态播报器(批次 8-B)
 *
 * ── 为什么有这个文件 ────────────────────────────────────────────────
 * 沟通员的出厂提示词写明它有三重身份,第三条是 Observer:
 * 「关注任务状态变化,只在终态(完成 / 失败)时主动向用户播报一句话结果」。
 * 代码侧确实有一整套 `startObserver` / `onArtifactFinalized` / `enableObserver`
 * 挂在 Communicator.prototype 上(agents/communicator.ts:1342-1501),
 * **但全仓没有任何调用方**,agentKernel 构造 Communicator 时也没开 —— 死接线。
 * 后果:用户交办一件事,跑完只看到一张 plan_done 卡片,没有任何人跟他说话。
 * 核查记录见 docs/AGENT-AUDIT-2026-10-03.md §1.1 第 5 条。
 *
 * 本文件给那第三重身份补上执行点,并且**不复用**那套死掉的 mixin:
 *   · mixin 走的是「订阅 artifact_status_changed」—— 那条路要求 communicator
 *     进程内长期订阅全局 bus,当初就是这么写的,而它从没跑起来;
 *   · 这里走「run settle 之后主动播报一次」—— 终态是**已知的同步事实**
 *     (orchestrator.run() 返回或抛错),不需要订阅、不需要去重、不会漏。
 *     少一个订阅就少一类僵尸/重复播报,这是本实现与 mixin 的核心差别。
 *
 * ── 失败语义(全链路 fail-safe,绝不拖慢用户)────────────────────────
 *  · LLM 超时(8s)/抛错/输出不是一句话 → 退回 `fallbackReportText()` 的确定性文案,
 *    **内容同样来自真实事实**(完成几项、失败几项、第一条交付物标题)。
 *  · 播报**永不抛**:它是一个「锦上添花」,不能把已经成功的 plan 变成失败。
 *  · 播报本身不落黑板、不改任何工件状态 —— 它只是「说一句话」。
 */
import { log } from "../../shared/log.js";
import { completeSimple } from "@earendil-works/pi-ai/compat";

/** 播报超时。8s 与沉淀器同量级:够一次短补全,又不会让用户盯着空白等。 */
export const REPORT_TIMEOUT_MS = 8_000;

/** 播报输出预算。一到两句,300 token 足够,超了就是模型在写小作文。 */
export const REPORT_MAX_TOKENS = 400;

export type RunOutcome = "completed" | "failed" | "aborted";

export interface RunReportInput {
  /** 播报发到哪个会话(ws.ts 侧用来选广播目标 + 落库) */
  conversationId: string;
  goal: string;
  outcome: RunOutcome;
  /** todo 终态快照(标题 + 状态),只给标题,不给正文 */
  todos: Array<{ title: string; status: string }>;
  /** 已完成的交付物(标题 + 正文前 200 字),取自 pickDeliveries */
  deliveries: Array<{ title: string; preview: string }>;
  /** 失败/取消原因(有就带) */
  reason?: string;
}

export interface RunReporterDeps {
  getModel: () => unknown;
  getApiKey: () => string | undefined;
  /** harness 的 communicator.report 提示词(空串 → 用内置常量) */
  systemPrompt?: string;
  /** 测试可注入 */
  llmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 确定性降级文案。**只用输入里的事实**,一句一句数出来,不做任何推断。
 * 它必须与 LLM 版本一样诚实 —— 「报告失败」不能变成「什么都没发生」。
 */
export function fallbackReportText(input: RunReportInput): string {
  const done = input.todos.filter((t) => t.status === "resolved").length;
  const failed = input.todos.filter((t) => t.status === "failed").length;
  const total = input.todos.length;
  const head = input.deliveries[0]?.title?.trim();
  if (input.outcome === "aborted") {
    return `任务已中止:完成 ${done}/${total}${failed > 0 ? `,失败 ${failed}` : ""}。${input.reason ? `原因:${input.reason}` : ""}`;
  }
  if (input.outcome === "failed" || failed > 0) {
    const why = input.reason ?? (failed > 0 ? `${failed} 个步骤失败` : "未知原因");
    return `任务没能全部完成:完成 ${done}/${total},${why}。${head ? `已产出的部分:${head}` : "没有可交付的产物"}`;
  }
  if (done === 0 && total === 0) {
    return `任务「${input.goal.slice(0, 40)}」已结束,但没有产生任何步骤结果。`;
  }
  return `任务完成:${done}/${total}${head ? `,主要成果:${head}` : ""}。`;
}

/** 给模型看的事实清单。**刻意做成好读的纯文本**,不给模型 JSON 方言。 */
function buildReportUserPrompt(input: RunReportInput): string {
  const lines: string[] = [];
  lines.push(`用户交办的目标:${input.goal}`);
  lines.push(`终态:${input.outcome}`);
  if (input.reason) lines.push(`原因:${input.reason}`);
  if (input.todos.length > 0) {
    lines.push("步骤:");
    for (const t of input.todos) lines.push(`- [${t.status}] ${t.title}`);
  }
  if (input.deliveries.length > 0) {
    lines.push("交付物:");
    for (const d of input.deliveries) {
      lines.push(`- ${d.title}:${d.preview.replace(/\s+/g, " ").slice(0, 200)}`);
    }
  }
  return lines.join("\n");
}

/** 输出清洗:去掉 markdown 围栏/标题/编号,压成一句话到两句。 */
function normalizeReport(raw: string): string | null {
  let text = raw.trim();
  if (text.length === 0) return null;
  // 模型爱加 ``` 围栏与「播报:」前缀 —— 去掉,别让噪音进聊天流
  text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
  text = text.replace(/^(播报|总结|汇报)[:：]\s*/, "").trim();
  // markdown 标题/列表符号只在行首,逐行剥
  text = text
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*+]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  if (text.length === 0) return null;
  // 上限 400 字:再长就不是「一句话播报」了
  return text.length > 400 ? text.slice(0, 400) : text;
}

export interface RunReportResult {
  text: string;
  /** llm = 模型写的;fallback = 降级文案(用户看到的仍然是真的) */
  source: "llm" | "fallback";
}

/**
 * 造一个播报函数。**永不抛、永不返回空** —— 最差情况返回降级文案。
 */
export function makeRunReporter(deps: RunReporterDeps): (input: RunReportInput) => Promise<RunReportResult> {
  return async (input: RunReportInput): Promise<RunReportResult> => {
    const fallback = (): RunReportResult => ({ text: fallbackReportText(input), source: "fallback" });
    if (deps.llmCall) {
      try {
        const raw = await deps.llmCall({
          systemPrompt: deps.systemPrompt ?? "",
          userPrompt: buildReportUserPrompt(input),
        });
        const text = normalizeReport(raw);
        return text ? { text, source: "llm" } : fallback();
      } catch (err) {
        log.muted(`runReport: 注入的 llmCall 失败,降级文案播报(${errMessage(err)})`);
        return fallback();
      }
    }
    const model = deps.getModel() as Parameters<typeof completeSimple>[0] | null;
    if (!model) return fallback();
    const apiKey = deps.getApiKey();
    if (!apiKey) return fallback();
    try {
      const result = await withTimeout(
        completeSimple(
          model,
          {
            systemPrompt: deps.systemPrompt ?? "",
            messages: [
              {
                role: "user",
                content: buildReportUserPrompt(input),
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey, maxTokens: REPORT_MAX_TOKENS },
        ),
        REPORT_TIMEOUT_MS,
      );
      if (result.stopReason === "error" || result.errorMessage) {
        log.muted(`runReport: LLM 报错,降级文案播报(${result.errorMessage ?? "unknown"})`);
        return fallback();
      }
      const raw = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("");
      const text = normalizeReport(raw);
      if (!text) {
        log.muted("runReport: 模型输出为空/不可用,降级文案播报");
        return fallback();
      }
      return { text, source: "llm" };
    } catch (err) {
      log.muted(`runReport: 播报失败,降级文案(${errMessage(err)})`);
      return fallback();
    }
  };
}

/** 超时包装。completeSimple 不接 AbortSignal(与 ExecutorLlmCall 同一约束),
 *  所以用「不等了」的语义:Promise.race + unref 定时器,迟到的结果被丢弃。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    if (typeof timer.unref === "function") timer.unref();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}