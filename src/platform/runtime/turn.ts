/**
 * 平台运行时 · 一个回合(BC6 执行层的地基)
 *
 * ── 为什么把它单独抽出来 ────────────────────────────────────────
 *
 * 「跑一个回合」在三处都要用:执行一个工作项(BC6)、对一次提问作出答复、
 * 以及将来的周期对焦。它们的形式完全一样:
 *
 *   收集待办 → 拼进消息 → 发给模型 → 等它收敛 → 收集它做了什么
 *
 * 分开写就会写成三份,而每份都会漏掉点什么 —— 通常是「留现场」那部分。
 *
 * ── 待办注入为什么拼在 user 消息里,而不是重建会话 ──────────────────
 *
 * 待办每回合都在变(有人刚问了你、会议刚开)。拼进系统提示意味着每回合重建
 * 会话 —— 那会丢掉会话历史,而历史正是「它已经查过什么」的来源(7-N:每轮
 * 重拼 transcript 导致模型原地打转)。
 *
 * 拼在 user 消息前部则不动会话历史,且模型能看到「这是系统替我列的待办,
 * 下面才是我该干的事」这个层次。
 *
 * ── 留现场(7-N 的教训)────────────────────────────────────────
 *
 *   「7-N 之前 executor 未收敛的 note 只有一句「未收敛」,**零现场**,
 *    根因是另写探针才复现出来的。**新写任何失败分支前先问:事后能不能从
 *    产物里看出当时发生了什么?** 见不到的现场等于没有现场。」
 *
 * 所以 `TurnResult` 必须带回 `toolCalls`(名字 / 参数摘要 / 是否失败)与
 * `timedOut`。一个超时的回合如果只返回空字符串,事后无从判断它卡在哪。
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type Database from "better-sqlite3";
import {
  collectPendingWork, renderPendingWork, summarizePendingWork,
} from "./pendingWork.js";

/** 一次工具调用的现场记录。 */
export interface ToolCallRecord {
  readonly name: string;
  /** 参数的可读摘要(截断) */
  readonly argsSummary: string;
  readonly isError: boolean;
  /** 结果的简短摘要(截断) */
  readonly resultSummary: string;
  readonly durationMs: number;
}

export interface TurnResult {
  /** 助手说出的正文 */
  readonly text: string;
  /** 内部推理(与正文分开 —— 7-I 的现场是两者混在一起被当成回复展示) */
  readonly thinking: string;
  /** **现场**:这一回合调了哪些工具、哪些失败了 */
  readonly toolCalls: readonly ToolCallRecord[];
  /**
   * 这一回合里**新立项的项目 id**(按调用顺序)。
   *
   * 来源是工具结果的结构化 `details.data.projectId`(见 `project_open` 与
   * `sdkAdapter.ts`),**不是正则抠文本** —— 文案改一个字就会让文本解析静默失效,
   * 而这条通道本来就是判工具成败用的(见下面的 `toolCallFailed`)。
   *
   * 宿主靠它把接待会话切到新项目。空数组 = 这一回合没有立项。
   */
  readonly openedProjectIds: readonly string[];
  readonly pending: {
    readonly injected: boolean;
    readonly summary: string;
  };
  /** 是否收到了 agent_settled / agent_end */
  readonly settled: boolean;
  /** 超时收尾(不等于失败,但必须让调用方知道) */
  readonly timedOut: boolean;
}

export interface RunTurnOptions {
  readonly session: AgentSession;
  readonly db: Database.Database;
  readonly agentId: string;
  /**
   * 当前项目。**`null` = 接待会话**(还没有项目,见 migrations/012)。
   *
   * 接待会话没有项目可查待办,所以此时**不注入**待办段(而不是拼一个空壳)。
   */
  readonly projectId: string | null;
  /** 本次要它做的事 */
  readonly message: string;
  /** 是否把待办拼进消息(默认 true;接待会话下强制不注入) */
  readonly injectPending?: boolean;
  readonly timeoutMs?: number;
  /** 逐事件观察(调试/日志)。抛错会被吞掉,不影响回合 */
  readonly onEvent?: (ev: AgentSessionEvent) => void;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/** 事件类型收窄 —— 避免为读字段而上宽断言。 */
function isMessageUpdate(
  ev: AgentSessionEvent,
): ev is Extract<AgentSessionEvent, { type: "message_update" }> {
  return ev.type === "message_update";
}
function isToolStart(
  ev: AgentSessionEvent,
): ev is Extract<AgentSessionEvent, { type: "tool_execution_start" }> {
  return ev.type === "tool_execution_start";
}
function isToolEnd(
  ev: AgentSessionEvent,
): ev is Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
  return ev.type === "tool_execution_end";
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
}

/**
 * 判断一次工具调用是否失败。
 *
 * **优先读结构化 details** —— `ToolExecutionEndEvent.isError` 只在 `execute` 抛异常
 * 时为 true,而我们的工具把失败作为文本返回(好让模型能读到并自纠),所以那个
 * 字段恒为 false。首跑实测:一次外键失败被日志标成了 ✓。
 *
 * 退路是读文本前缀(格式由适配壳固定),这样即便 details 缺席也不至于漏判。
 */
function toolCallFailed(ev: { isError?: unknown; result?: unknown }): boolean {
  if (ev.isError === true) return true;
  const details = (ev.result as { details?: unknown } | null | undefined)?.details;
  if (details !== null && typeof details === "object" && "ok" in details) {
    return (details as { ok?: unknown }).ok === false;
  }
  return resultText(ev.result).startsWith("[工具失败:");
}

/**
 * 从一次工具调用的结果里取出它声明的「新立项项目 id」。
 *
 * **只在 `project_open` 上读**:`ToolResult.data` 是通用逃逸口,它的含义由工具自己
 * 决定 —— 别的工具完全可能带一个 `projectId`(比如「我刚读的是哪个项目」)。
 * 不按工具名过滤的话,那种数据会被当成立项,而宿主会据此**迁移接待会话**。
 * 这里宁可写死一个工具名,也不留下那个误判面。
 *
 * **读结构化 details,不解析文本** —— 理由见 `TurnResult.openedProjectIds`。
 * 形状不认识时返回 null(不抛):一个读不出来的结果不该让整轮对话崩掉。
 */
function openedProjectIdOf(ev: { toolName?: unknown; result?: unknown }): string | null {
  if (ev.toolName !== "project_open") return null;
  const details = (ev.result as { details?: unknown } | null | undefined)?.details;
  if (details === null || typeof details !== "object") return null;
  const data = (details as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return null;
  const id = (data as { projectId?: unknown }).projectId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** 从工具结果里抠出文本。形状不认识就退化成 JSON,不抛。 */
function resultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c !== null && typeof c === "object" && "text" in c) {
        const t = (c as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "(无法序列化的工具结果)";
  }
}

/** 参数摘要:id 之类的短字段保留,长文本截断。 */
function argsSummary(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return truncate(String(args), 120);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  return truncate(
    entries
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" "),
    160,
  );
}

/**
 * 拼出这一回合真正发给模型的内容。
 *
 * 待办在前、任务在后,并用一条分隔线明确层次 —— 否则模型会把「待办清单里的
 * 某一条」当成它这回合要做的事。
 */
export function composeTurnMessage(
  pendingBlock: string,
  message: string,
): string {
  if (pendingBlock.trim() === "") return message;
  return `${pendingBlock}\n\n---\n\n# 本次要做的事\n\n${message}`;
}

/**
 * 跑一个回合。
 *
 * **不 dispose 会话** —— 一个回合只是一次交互,会话的生死由调用方决定。
 * (smoke 命令那种「问一句就关」是一次性用法,不是这里的形态。)
 */
export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const openedProjectIds: string[] = [];
  // toolCallId → 开始时间 + 参数摘要。**参数必须在 start 时抓** ——
  // end 事件只给结果,不回头带参数,而「它拿什么参数调的」正是排查时最需要的现场。
  const inflight = new Map<string, { startedAt: number; argsSummary: string }>();
  let settled = false;

  // ── 待办注入 ──
  // 接待会话(projectId === null)**不注入**:还没有项目,没有项目内的待办可列;
  // 拼一个空壳只会白占 context 并让模型以为「系统替我列过了」。
  const pid = opts.projectId;
  const work =
    opts.injectPending !== false && pid !== null
      ? collectPendingWork(opts.db, opts.agentId, pid, Date.now())
      : null;
  const pendingBlock = work !== null ? renderPendingWork(opts.db, work) : "";
  const pendingSummary =
    work !== null
      ? summarizePendingWork(work)
      : pid === null
        ? "(接待会话:没有项目待办)"
        : "(未注入)";
  const payload = composeTurnMessage(pendingBlock, opts.message);

  const unsub = opts.session.subscribe((ev: AgentSessionEvent) => {
    try {
      opts.onEvent?.(ev);
    } catch {
      // 观察者出错不该毁掉回合一 —— 但也不能静默:记进 thinking 之外的地方
      // 会污染语义,所以只保证不影响主流程。
    }

    if (isMessageUpdate(ev)) {
      const u = ev.assistantMessageEvent;
      // 7-I 的现场:thinking 增量曾被当成正文展示(判据写成了不存在的
      // "thinking")。这里**显式分开**,两者永不混流。
      if (u.type === "text_delta" && typeof u.delta === "string") text.push(u.delta);
      else if (u.type === "thinking_delta" && typeof u.delta === "string") thinking.push(u.delta);
      return;
    }

    if (isToolStart(ev)) {
      inflight.set(ev.toolCallId, {
        startedAt: Date.now(),
        argsSummary: argsSummary(ev.args),
      });
      return;
    }

    if (isToolEnd(ev)) {
      const started = inflight.get(ev.toolCallId);
      toolCalls.push({
        name: ev.toolName,
        argsSummary: started?.argsSummary ?? "",
        isError: toolCallFailed(ev),
        resultSummary: truncate(resultText(ev.result), 300),
        durationMs: started !== undefined ? Date.now() - started.startedAt : 0,
      });
      // 立项是**流程状态变更**,必须单独留痕:宿主靠它做「接待会话 → 新项目」
      // 的切换。失败的结果不会带 data(见 sdkAdapter 的失败分支)。
      const opened = openedProjectIdOf(ev);
      if (opened !== null) openedProjectIds.push(opened);
      inflight.delete(ev.toolCallId);
      return;
    }

    if (ev.type === "agent_settled" || ev.type === "agent_end") settled = true;
  });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    settled = true;
  }, timeoutMs);

  try {
    await opts.session.prompt(payload);
    while (!settled) await new Promise((r) => setTimeout(r, 50));
  } finally {
    clearTimeout(timer);
    unsub();
  }

  return {
    text: text.join(""),
    thinking: thinking.join(""),
    toolCalls,
    openedProjectIds,
    pending: { injected: pendingBlock.trim() !== "", summary: pendingSummary },
    settled: !timedOut,
    timedOut,
  };
}

/**
 * 把回合结果渲染成可读报告(CLI / 日志用)。
 *
 * 含**现场**:调了哪些工具、哪些失败。一个只有回答的日志在排查时等于没有日志。
 */
export function renderTurnReport(r: TurnResult): string {
  const lines: string[] = [];
  lines.push(`待办注入: ${r.pending.injected ? r.pending.summary : "无"}`);
  if (r.toolCalls.length > 0) {
    lines.push(`工具调用 ${r.toolCalls.length} 次:`);
    for (const t of r.toolCalls) {
      lines.push(
        `  ${t.isError ? "✖" : "✓"} ${t.name} (${t.durationMs}ms)` +
          (t.argsSummary !== "" ? `\n      参数:${t.argsSummary}` : "") +
          (t.resultSummary !== "" ? `\n      结果:${t.resultSummary}` : ""),
      );
    }
  } else {
    lines.push("工具调用: 无");
  }
  if (r.openedProjectIds.length > 0) {
    lines.push(`本回合立项: ${r.openedProjectIds.join(", ")}`);
  }
  if (r.thinking !== "") lines.push(`(另有 ${r.thinking.length} 字符内部推理,未混入正文)`);
  if (r.timedOut) lines.push("⚠️ 回合超时收尾 —— 结果可能不完整");
  return lines.join("\n");
}
