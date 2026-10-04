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
 *
 * ── 两个「超时」是两件事(别把它们合并)──────────────────────────
 *
 * 真机现场:一个 worker 回合**跑了 16 分钟还没完**,watcher 15 分钟窗口里
 * 它一直在用 `bash` curl 阿里云文档。而 `timeoutMs` 完全没拦住它 ——
 * 那个定时器只把 `settled` 置真,而 `settled` 只在
 * `await session.prompt(payload)` **resolve 之后**被读到。`session.prompt()`
 * 自己不会被打断,于是「回合的时长」从来没有任何上界。后果不只是烧钱:
 * 排空器下它一直占着那个项目的 busy 闩,该项目后续**所有**待办都推不动。
 *
 * 于是现在有两个上界,职责不同、都必须存在:
 *
 *   `timeoutMs`(缺省 5 分钟)**现有语义,未改** —— 它护的是
 *     「`prompt()` resolve 之后,等 `agent_settled` / `agent_end` 那段收尾等待」。
 *     `prompt()` 已经返回、而收敛事件迟迟不来时,不让这个 `while` 永不退出。
 *     它**不打断**任何东西(此时也没什么可打断的)。
 *
 *   `wallClockTimeoutMs`(缺省 10 分钟)**新墙钟上界** —— 从发出去那一刻起
 *     算真实墙钟时间,到点**调 `AgentSession.abort()` 真的把回合打断**,
 *     并把现场(跑了多久 / 打断瞬间在跑哪个工具 / abort 有没有失败)带回。
 *     这才是「一个回合最多花多久」的上界。
 *
 * 登记(`setTimeout` + 它到点时对 `session.abort()` 的调用)必须发生在
 * **第一次 `await` 之前** —— 批次 19 的教训原话:「放在 `await runTurn(...)`
 * 之后等于永远登记不上」。前端中断按钮曾在同一个缝隙里死接线过。
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { log } from "../../shared/log.js";
import type Database from "better-sqlite3";
import {
  collectPendingWork, renderPendingWork, summarizePendingWork,
} from "./pendingWork.js";
import { renderProjectContext } from "./projectContext.js";

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
  /**
   * **我在哪个项目** —— 与 `pending` 同级的现场记录。
   *
   * 没有它,「业务经理说当前没有在跑的项目」这类事故在事后只能靠翻库复原
   * (而那正是它第一次发生时没人看出来的原因)。接待会话下 `injected` 为 false。
   *
   * **可选**:手工构造 `TurnResult` 字面量的地方(测试、`emptyTurn`)可以不带它,
   * 渲染侧按「未记录」如实呈现 —— 不假装有一份空的项目上下文。
   */
  readonly projectContext?: {
    readonly injected: boolean;
    readonly summary: string;
  };
  /** 是否收到了 agent_settled / agent_end */
  readonly settled: boolean;
  /**
   * 有超时收尾(不等于失败,但必须让调用方知道)。
   *
   * **两条路都会置真**:① `timeoutMs` 的收尾等待到点(旧语义);
   * ② 新的墙钟上界到点、真的打断并 abort 了会话。哪一条看 `timeout` 有没有值:
   * 有 = 墙钟上界打断的,那一份现场在 `timeout` 里。
   */
  readonly timedOut: boolean;
  /**
   * **墙钟上界的现场**(7-N:「见不到的现场等于没有现场」)。
   *
   * 只有 `wallClockTimeoutMs` 到点、`abort()` 真的发出去过时才存在。
   * `timedOut` 只说「超时了」;这一份才说得出「跑了多久、打断瞬间在跑哪个工具、
   * abort 有没有失败、SDK 有没有在宽限内收尾」—— 一个卡了 16 分钟的回合,
   * 事后要能看出它当时在干什么。
   *
   * **可选**:手工构造 `TurnResult` 的地方不带它;没有它 = 这一回合不是被
   * 墙钟上界打断的。
   */
  readonly timeout?: TurnTimeoutScene;
}

/**
 * 墙钟上界到点时的现场。
 *
 * 它存在的唯一理由是 7-N:超时如果没有现场,「模型在原地打转」与「某个工具
 * 真的跑了很久」在事后完全无法区分 —— 而这决定了该改提示词还是该改工具超时。
 */
export interface TurnTimeoutScene {
  /** 到点的那个上界(毫秒)—— 现场要能自证判据 */
  readonly limitMs: number;
  /** 从 `prompt()` 发出到打断,实际跑了多久(毫秒) */
  readonly elapsedMs: number;
  /** `session.abort()` 有没有真的被调到。**false 才是异常**(死接线的形态) */
  readonly abortRequested: boolean;
  /**
   * `abort()` 自己失败时的错误文本。
   *
   * ⚠️ 尽力而为:`abort()` 是异步的,若它的失败是在本回合**返回之后**才报出来,
   * 这里会是 `null` —— 那条现场在 ERROR 日志里(不静默,见 `runTurn` 的实现)。
   */
  readonly abortError: string | null;
  /** 打断瞬间**正在跑**的那个工具(还没收到 tool_execution_end 的) */
  readonly interruptedTool: {
    readonly name: string;
    readonly argsSummary: string;
    /** 它已经跑了多久(毫秒) */
    readonly runningMs: number;
  } | null;
  /** 打断时已经**完成**的工具调用次数 */
  readonly completedToolCalls: number;
  /** abort 之后 `session.prompt()` 有没有在宽限内返回(false = SDK 没收敛) */
  readonly promptReturned: boolean;
  /** 打断让 `prompt()` 以错误收尾时的错误文本(中断不等于故障,但要留痕) */
  readonly promptError: string | null;
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
  /**
   * **收尾等待**的上界(毫秒,默认 {@link DEFAULT_TIMEOUT_MS} = 5 分钟)。
   *
   * ⚠️ **这不是「一个回合最多跑多久」** —— 它护的是
   * 「`session.prompt()` resolve 之后,等 `agent_settled` / `agent_end` 那段
   * 等待」,而且它**不打断** `prompt()` 自己。真要给回合一个时长上界,用
   * {@link RunTurnOptions.wallClockTimeoutMs}。两者的区别见文件头。
   */
  readonly timeoutMs?: number;
  /**
   * **一个回合的墙钟上界**(毫秒,默认 {@link DEFAULT_WALL_CLOCK_TIMEOUT_MS}
   * = 10 分钟)。到点**调 `AgentSession.abort()` 真的打断这个回合**,
   * 而不是继续等一个不会收敛的 `prompt()`。
   *
   * 非正数一律退化成默认值(与 CLI 的 `--max-cascade-rounds` 同一条规矩:
   * 坏值取默认,而不是「0 = 不设上界」—— 那等于把唯一的上界悄悄拆掉)。
   */
  readonly wallClockTimeoutMs?: number;
  /**
   * `abort()` 发出之后,再等 `session.prompt()` 收尾的**宽限**上界(毫秒,
   * 默认 {@link DEFAULT_ABORT_GRACE_MS})。
   *
   * 存在的理由:排空器下「一个卡死的回合」会一直占着该项目的 busy 闩
   * (这正是本缺陷的后果之一)。宽限到点还没返回就不再等它 —— 宁可如实报
   * 「abort 之后没收敛」,也不让整条流水线被一个回合钉住。
   *
   * 暴露出来是为了可测:测试里传几十毫秒就能穷举「abort 之后 prompt 永不返回」
   * 这条路径,而不必真等 15 秒。
   */
  readonly abortGraceMs?: number;
  /** 逐事件观察(调试/日志)。抛错会被吞掉,不影响回合 */
  readonly onEvent?: (ev: AgentSessionEvent) => void;
}

/**
 * `timeoutMs` 的缺省值(5 分钟)—— **收尾等待**的上界,不是回合时长。
 * 导出是为了让文档与 CLI/宿主接线有个单一真相,不必各自抄一个数字。
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * **一个回合的墙钟上界**的缺省值(10 分钟)。
 *
 * 为什么是 10 分钟(判据是真机观测,不是拍脑袋):
 *   - 正常回合 **2–3 分钟**(worker 读代码 / 跑命令 / 写工件);
 *     10 分钟 ≈ 它的 3–5 倍,不会误杀正常回合;
 *   - 真机那条卡死的回合跑了 **16 分钟**还在 `bash` curl 文档 ——
 *     10 分钟把它砍掉约 40%,而且**打断**而不是「等它自己结束」;
 *   - 它同时是排空器下 busy 闩的最长持有时间:一个项目不会被一个回合
 *     无限期锁住。
 *
 * 保守方向是刻意的:上界太紧会杀掉**真正在做长活**的合法回合(跑一次全量
 * 测试、装依赖),那类误杀比多花几分钟贵得多。真需要更长的项目由调用方显式调大。
 */
export const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 600_000;

/**
 * `abort()` 之后等 `prompt()` 收尾的宽限(15 秒)。
 * 只用于「宽限之后不再等」的判定,不参与回合时长上界。
 */
export const DEFAULT_ABORT_GRACE_MS = 15_000;

/**
 * 打断一个会话 —— 与批次 19 接在宿主 `interrupt` 上的那一套语义**同一份**:
 *
 *   - SDK 的取消入口是 `AgentSession.abort()`,**没有**别的路
 *     (`AbortController` 传不进 `session.prompt()`);
 *   - 它是 async 且会等到 agent 真正 idle,所以调用方**不 await** 它
 *     (但 `abort()` 在调用本函数的那一刻就被发起了:async 函数体同步执行到
 *     第一个 `await` 为止);
 *   - 但它失败**必须留现场**(7-N),所以错误文本被返回而不是吞掉 ——
 *     前端中断按钮曾经在「没人 set 的 inflight」里静默了整条链路。
 *
 * 返回 `null` = 已经发出且没有失败(或还在收尾中)。
 */
export async function requestSessionAbort(session: AgentSession): Promise<string | null> {
  try {
    await session.abort();
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  // 名字也在这里留一份:超时打断时「哪个工具正在跑」只能从这张表里看(7-N)。
  const inflight = new Map<
    string,
    { name: string; startedAt: number; argsSummary: string }
  >();
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

  // ── 项目上下文注入(A)──
  // **与待办同一个位置、同一条理由**:都是「每回合现算的现场」。拼进系统提示
  // 会把建立那一刻的快照当成永久事实(理由全文见 projectContext.ts 文件头)。
  // 接待会话返回空串,这里无脑拼接 —— 那条路径的行为与改动前完全一致。
  const ctx = renderProjectContext(opts.db, opts.agentId, pid);
  const body = composeTurnMessage(pendingBlock, opts.message);
  const payload = ctx.text === "" ? body : `${ctx.text}\n\n${body}`;

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
        name: ev.toolName,
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
  // 非正数 → 默认值(坏值取默认;「0 = 不设上界」等于把唯一的上界悄悄拆掉)
  const wallClockMs =
    opts.wallClockTimeoutMs !== undefined && opts.wallClockTimeoutMs > 0
      ? opts.wallClockTimeoutMs
      : DEFAULT_WALL_CLOCK_TIMEOUT_MS;
  const abortGraceMs =
    opts.abortGraceMs !== undefined && opts.abortGraceMs > 0
      ? opts.abortGraceMs
      : DEFAULT_ABORT_GRACE_MS;

  let timedOut = false;
  const startedAt = Date.now();

  // ── 墙钟超时的现场(7-N)────────────────────────────────────────
  // 到点那一刻抓,而不是返回时抓:「跑了多久」指的是**被打断时**跑了多久。
  let wallClockExceeded = false;
  let abortRequested = false;
  let abortError: string | null = null;
  let interruptedTool: TurnTimeoutScene["interruptedTool"] = null;
  let elapsedAtInterruptMs = 0;
  let completedAtInterrupt = 0;
  let promptReturned = false;
  let promptErrorValue: unknown = undefined;
  let promptErrorMessage: string | null = null;
  let releaseWallClock: () => void = () => {};
  const wallClockReached = new Promise<void>((resolve) => {
    releaseWallClock = resolve;
  });

  // ⚠️ **登记必须发生在第一次 `await` 之前。** 放在 `await opts.session.prompt()`
  // 之后等于永远登记不上:到点时回合早就结束了(或者早就该被打断了)——
  // 批次 19 修前端中断时,死接线正是藏在这个缝隙里(一个从来没人 `set` 的
  // `inflight`,于是 `get()` 恒 undefined、可选链把整条链路吞得一声不响)。
  const wallClockTimer = setTimeout(() => {
    wallClockExceeded = true;
    timedOut = true;
    elapsedAtInterruptMs = Date.now() - startedAt;
    completedAtInterrupt = toolCalls.length;

    // 打断瞬间**正在跑**的那个工具就是现场:只写一句「超时了」,
    // 事后分不清「模型在原地打转」与「某个工具真的跑了很久」(7-N)。
    let running: { name: string; startedAt: number; argsSummary: string } | null = null;
    for (const rec of inflight.values()) {
      if (running === null || rec.startedAt > running.startedAt) running = rec;
    }
    interruptedTool =
      running === null
        ? null
        : {
            name: running.name,
            argsSummary: running.argsSummary,
            runningMs: Date.now() - running.startedAt,
          };

    // **WARN 级日志 + 现场**:超时不许静默(见文件头与 7-N)
    log.warn(
      `turn: 墙钟上界 ${wallClockMs}ms 到点 —— 正在打断 ${opts.agentId} 的回合` +
        `(已跑 ${elapsedAtInterruptMs}ms · 已完成工具 ${completedAtInterrupt} 次 · ` +
        (interruptedTool === null
          ? "打断瞬间没有正在跑的工具"
          : `打断瞬间在跑 ${interruptedTool.name}(${interruptedTool.runningMs}ms)` +
            (interruptedTool.argsSummary !== "" ? ` 参数:${interruptedTool.argsSummary}` : "")) +
        ")",
    );

    // 与宿主 `interrupt` 完全同一套语义:SDK 的取消入口就是 `AgentSession.abort()`。
    // **不 await**(它是 async 且会等到 agent 真正 idle,定时器回调不该被阻塞),
    // 但失败要留现场 —— 前端中断曾经因为「没人 set 的 inflight」静默失效过。
    abortRequested = true;
    void requestSessionAbort(opts.session).then((err) => {
      if (err === null) return;
      abortError = err;
      log.error(`turn: 打断 ${opts.agentId} 的回合失败(abort 报错):${err}`);
    });

    // 收尾等待立刻结束:不再等一个已经被我们打断的回合收敛
    settled = true;
    releaseWallClock();
  }, wallClockMs);

  // `timeoutMs` 的定时器**保持原样**:它护的是「prompt() 返回之后等收敛事件」
  // 那段等待。它与上面那个墙钟上界是两件事,不合并(见文件头)。
  const timer = setTimeout(() => {
    timedOut = true;
    settled = true;
  }, timeoutMs);

  try {
    // `prompt()` 的结局显式接住(而不是直接 `await`),因为两条路都可能有错:
    // 普通失败要照旧抛给调用方;而**墙钟打断时它抛错是预期结果**,不是回合故障
    // (宿主 `interrupt` 那条路同样是「中断不是故障」)。不接住的话,
    // 一次超时会被上层报成「回合失败」,处置与落点就都变了。
    const promptPromise = opts.session.prompt(payload).then(
      () => {
        promptReturned = true;
      },
      (err: unknown) => {
        promptReturned = true;
        promptErrorValue = err;
        promptErrorMessage = err instanceof Error ? err.message : String(err);
      },
    );

    await Promise.race([promptPromise, wallClockReached]);

    // `prompt()` 自己失败(不是我们打断的)→ **立刻**抛给调用方。
    // 不能拖到收尾等待到点:那会把「provider 报错」变成「卡满 timeoutMs 才报错」,
    // 而且会先把 settled 置真、把错误伪装成一次超时收尾。
    if (promptErrorMessage !== null && !wallClockExceeded) throw promptErrorValue;

    if (wallClockExceeded && !promptReturned) {
      // abort 已经发出,给 SDK 一个**有界**的收尾宽限。绝不无限等:
      // 一个卡死的回合会把排空器的 busy 闩一直握住(本缺陷的后果之一)。
      await Promise.race([promptPromise, delay(abortGraceMs)]);
      if (!promptReturned) {
        log.warn(
          `turn: abort 之后 ${abortGraceMs}ms 内 session.prompt() 仍未返回 —— ` +
            `不再等它(回合按超时收尾;排空器不会被一个回合钉住)`,
        );
      }
    }
    if (wallClockExceeded && promptErrorMessage !== null) {
      // 中断不是故障(与宿主 `interrupt` 同一条判断),但要留痕:错误文本进现场
      log.muted(
        `turn: ${opts.agentId} 的回合被墙钟上界打断,prompt() 以错误收尾:${promptErrorMessage}`,
      );
    }

    while (!settled) await new Promise((r) => setTimeout(r, 50));
  } finally {
    clearTimeout(wallClockTimer);
    clearTimeout(timer);
    unsub();
  }

  const timeout: TurnTimeoutScene | undefined = wallClockExceeded
    ? {
        limitMs: wallClockMs,
        elapsedMs: elapsedAtInterruptMs,
        abortRequested,
        abortError,
        interruptedTool,
        completedToolCalls: completedAtInterrupt,
        promptReturned,
        promptError: promptErrorMessage,
      }
    : undefined;

  return {
    text: text.join(""),
    thinking: thinking.join(""),
    toolCalls,
    openedProjectIds,
    pending: { injected: pendingBlock.trim() !== "", summary: pendingSummary },
    projectContext: { injected: ctx.text.trim() !== "", summary: ctx.summary },
    settled: !timedOut,
    timedOut,
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

/**
 * 把墙钟超时的现场渲染成几行(7-N:见不到的现场等于没有现场)。
 *
 * 单独导出,因为两处报告都要它:`renderTurnReport`(一个回合)与
 * `execution.ts` 的 `renderExecutionReport`(一个工作项)。超时的现场
 * 恰好是「事后最想看到、而最容易只写一句『超时』」的那部分。
 */
export function renderTimeoutScene(s: TurnTimeoutScene): string[] {
  const lines: string[] = [
    `⏱ 墙钟上界 ${s.limitMs}ms 到点 → 已${s.abortRequested ? "" : "**未**"}调用 session.abort() 打断` +
      `(实际跑了 ${s.elapsedMs}ms,已完成工具 ${s.completedToolCalls} 次)`,
  ];
  lines.push(
    s.interruptedTool === null
      ? "  打断瞬间没有正在跑的工具"
      : `  打断瞬间在跑:${s.interruptedTool.name}(${s.interruptedTool.runningMs}ms)` +
        (s.interruptedTool.argsSummary !== "" ? ` 参数:${s.interruptedTool.argsSummary}` : ""),
  );
  if (!s.abortRequested) lines.push("  ⚠️ abort() 没有被调到 —— 这个回合没有被真正打断");
  if (s.abortError !== null) lines.push(`  ⚠️ abort() 自己失败了:${s.abortError}`);
  if (!s.promptReturned) {
    lines.push("  ⚠️ abort() 之后 session.prompt() 在宽限内没有返回(SDK 未收敛)");
  }
  if (s.promptError !== null) lines.push(`  打断让 prompt() 以错误收尾:${s.promptError}`);
  return lines;
}

/**
 * 把回合结果渲染成可读报告(CLI / 日志用)。
 *
 * 含**现场**:调了哪些工具、哪些失败。一个只有回答的日志在排查时等于没有日志。
 */
export function renderTurnReport(r: TurnResult): string {
  const lines: string[] = [];
  const pc = r.projectContext;
  lines.push(
    `项目上下文: ${
      pc === undefined ? "未记录" : pc.injected ? pc.summary : "无(接待会话)"
    }`,
  );
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
  if (r.timeout !== undefined) lines.push(...renderTimeoutScene(r.timeout));
  if (r.timedOut) lines.push("⚠️ 回合超时收尾 —— 结果可能不完整");
  return lines.join("\n");
}
