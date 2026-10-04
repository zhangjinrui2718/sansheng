/**
 * BC6 执行层 · 让一个 worker 把工作项做掉
 *
 * ── BC6 的核心变化:不再有 `{outcome}` ───────────────────────────
 *
 * 旧系统里执行者要交一个信封:`{outcome:"ok"|"failed", evidence|hypothesis|note}`,
 * 框架再解析它、落库、推进 todo。这个设计连踩三次(7-D / 7-M / 7-N):
 *
 *   「模型知道自己交的是什么,只是把外层包装摆错了;拿「解析不出来」惩罚它,
 *    等于因为信封没贴邮票就把信烧了。」
 *
 * 三次修的都是**解码器**。BC6 换掉的是**信使本身**:
 *
 *   旧:模型 → 交 JSON 信封 → 框架解析 → 落库
 *   新:模型 → **直接调 board_write** → 工件就是产出
 *
 * 没有信封就没有信封偏差。而且「它到底做了什么」不再依赖解析成功 ——
 * 工件表本身就是现场。
 *
 * ── 完成判定 ────────────────────────────────────────────────────
 *
 * 旧系统靠解析 `outcome` 判定成败。新系统靠**两个可查的事实**:
 *   ① 工作项状态被谁改成了终态(worker 有 `work.update`)
 *   ② 这一回合写了哪些工件
 *
 * 如果回合结束了而工作项还是 `in_progress`,**不猜**、不替它判成功 ——
 * 如实记为「未收敛」并把现场带回。7-N 的现场原则在这里的落点就是这件事:
 * 调用方要能看出「它调了 6 次工具都没卒」而不是只看到一句「未收敛」。
 *
 * ── 墙钟超时是一个**例外**,它必须由平台处置(不能只报「未收敛」)──────
 *
 * 一个回合被墙钟上界打断时,「未收敛」这个如实描述**不够**:真机现场是
 * 一个 worker 回合跑了 16 分钟还在 curl 文档,而它留在 `in_progress` ——
 * 而 `in_progress` 的工作项在排空器里有两条死路:
 *
 *   1. 它**不在**任何 outbox 事件里(`updateWorkStatus` 只对 done/failed/blocked
 *      写事件),所以业务经理永远不会向甲方交代「这条活没做完」;
 *   2. 它会作为 `execute_work` 待办被反复叫醒,直到尝试预算(`dispatch_attempts`,
 *      默认 3 次)用尽 —— 每次叫醒都可能再烧掉一个完整的墙钟上界,
 *      然后那条待办**再也不会被叫醒**,工作项就永久停在 `in_progress`:
 *      不在待办里、没有事件、没有人重试。
 *
 * 所以超时由平台显式处置(见 `disposeTimeout`):记 `failed`(终态)。
 * 终态的选择不是「替模型判失败」,而是「**不再自动重跑**」—— 被打断的回合
 * 拼不出可信的产出,自动重跑只会把同一段卡死行为再买一遍;而 `failed`
 * 会经 `updateWorkStatus` 写出 `work_failed` 事件 → 业务经理的汇报待办 →
 * 甲方可见。要人(项目经理)介入才能继续,这是对的失效方向。
 */
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  getWork, updateWorkStatus, isTerminalWorkStatus, type WorkRow,
} from "../storage/repo/works.js";
import { listArtifacts, type ArtifactRow } from "../storage/repo/artifacts.js";
import { listBlockers } from "../storage/repo/blockers.js";
import { getAgent } from "../storage/repo/agents.js";
import {
  runTurn, renderTimeoutScene, type TurnResult, type TurnTimeoutScene,
} from "./turn.js";
import { log } from "../../shared/log.js";

export type ExecutionOutcome =
  /** 工作项被推到了终态(done / failed / cancelled) */
  | "converged"
  /** 回合结束但工作项仍在进行中 —— **不替它判成功** */
  | "unconverged"
  /** 工作项状态是 blocked —— 它如实登记了阻塞,这是合法结局 */
  | "blocked"
  /** 工作项根本不该被执行(状态/归属不对) */
  | "refused"
  /**
   * 回合被**墙钟上界**打断,工作项由平台记为 `failed`(见文件头与
   * `disposeTimeout`)。与 `converged` 分开,是因为「到达终态」与
   * 「被强制中止后再记为终态」在事后必须能区分 —— 后者才需要人介入。
   */
  | "timed_out";

/**
 * 墙钟超时之后工作项被怎么处置了。**必须回报**,否则调用方看不出
 * 「超时了但工作项还活着」与「超时了且已经收口」的区别。
 */
export type TimeoutDisposition =
  /** 平台把它记成了 failed(终态,写出 `work_failed` 事件) */
  | "marked_failed"
  /** 超时前它已经自己到达终态(done/failed/cancelled)—— 不覆盖它 */
  | "left_terminal"
  /** 它自己登记了阻塞(blocked)—— 那是合法结局,不覆盖它 */
  | "left_blocked";

export interface ExecutionResult {
  readonly outcome: ExecutionOutcome;
  readonly work: WorkRow;
  /** 回合原始结果(回答、工具调用现场) */
  readonly turn: TurnResult;
  /** 这一回合新写的工件 —— 这才是真正的产出 */
  readonly producedArtifacts: readonly ArtifactRow[];
  /** 这一回合新登记的阻塞 */
  readonly raisedBlockers: readonly string[];
  /** outcome=refused 时说明原因 */
  readonly refusalReason?: string;
  /**
   * 墙钟超时后的处置。**可选**:非超时的执行结果不带它
   * (与 `TurnResult.projectContext` 同一个理由 —— 手工构造的地方不必假装
   * 记录过一份处置)。
   */
  readonly timeoutDisposition?: TimeoutDisposition;
}

export interface RunWorkOptions {
  readonly session: AgentSession;
  readonly db: Database.Database;
  readonly workId: string;
  /** 收尾等待的上界(透传给 `runTurn.timeoutMs`)。**不是**回合时长上界 */
  readonly timeoutMs?: number;
  /**
   * **一个工作项回合的墙钟上界**(透传给 `runTurn.wallClockTimeoutMs`)。
   * 缺省交给 `runTurn` 的 `DEFAULT_WALL_CLOCK_TIMEOUT_MS`(10 分钟)。
   *
   * 宿主/CLI 要调它,只需把这个字段接出去 —— 判定与打断逻辑都在这条调用链上,
   * 不需要另写一份超时。
   */
  readonly wallClockTimeoutMs?: number;
  /** `abort()` 之后等 SDK 收尾的宽限(透传;测试 seam) */
  readonly abortGraceMs?: number;
  readonly injectPending?: boolean;
  /**
   * 逐事件观察(宿主用来把这一回合**流式**推给前端)。
   *
   * ⚠️ 这个参数是真机跑出来才补上的:在此之前 `runWorkItem` 内部调 `runTurn`
   * 时**没有传 onEvent**,于是 worker 干活的那几分钟在前端是**全黑**的 ——
   * 只有回合结束时的 `work_changed` 与一条消息。CLI 那条路看不出来(它本来就
   * 是跑完打印报告),但常驻宿主下它意味着用户盯着一个没有反应的屏幕。
   * 抛错的处理与 `runTurn` 一致:观察者出错不影响回合。
   */
  readonly onEvent?: (ev: AgentSessionEvent) => void;
}

/** 工作项的可执行性前置检查。**不满足就拒绝,不硬跑。** */
function checkRunnable(db: Database.Database, work: WorkRow): string | null {
  if (work.status === "done" || work.status === "failed" || work.status === "cancelled") {
    return `工作项已是终态(${work.status}),不该再执行`;
  }
  const agent = getAgent(db, work.assigneeAgentId);
  if (agent === null) return `负责人 ${work.assigneeAgentId} 不存在`;
  if (agent.role !== "worker") {
    return `负责人 ${agent.displayName} 的角色是 ${agent.role},不是 worker —— 执行是 worker 的能力`;
  }
  return null;
}

/** 拼给 worker 的任务描述。 */
export function composeWorkPrompt(work: WorkRow): string {
  return [
    `# 工作项 ${work.id}`,
    "",
    `标题:${work.title}`,
    "",
    "目标:",
    work.goal,
    "",
    "---",
    "完成后**直接调 `work.update` 把状态改成 done**(或 failed);",
    "中途受阻就调 `blocker_open` 登记阻塞,并把工作项改成 blocked;",
    "有需要产出的东西(证据、结论、笔记)直接调 `board_write` —— " +
      "**工件就是你的交付物**,不需要另外写一段总结来「汇报」。",
  ].join("\n");
}

/**
 * 跑一个工作项。
 *
 * 会话由调用方建(这样同一次会话可以连续做多个工作项,省去反复建会话),
 * 这里只负责「跑它、判定、带现场回来」。
 */
export async function runWorkItem(opts: RunWorkOptions): Promise<ExecutionResult> {
  const before = getWork(opts.db, opts.workId);
  if (before === null) {
    throw new Error(`工作项 ${opts.workId} 不存在`);
  }

  const refusal = checkRunnable(opts.db, before);
  if (refusal !== null) {
    // 拒绝时开一个空回合,保证 turn 字段始终是有效对象(调用方不必判空)
    return {
      outcome: "refused",
      work: before,
      turn: emptyTurn(),
      producedArtifacts: [],
      raisedBlockers: [],
      refusalReason: refusal,
    };
  }

  // 开工:置为 in_progress(已有状态则保持 —— 重跑一个 in_progress 的工作项是合法的)
  if (before.status !== "in_progress") {
    updateWorkStatus(opts.db, before.id, "in_progress", Date.now());
  }

  // ── 记录回合前的基线,用于算出「这一回合新产出了什么」──
  const artifactsBefore = new Set(listArtifacts(opts.db, before.projectId).map((a) => a.id));
  const blockersBefore = new Set(
    listBlockers(opts.db, before.projectId).map((b) => b.id),
  );

  const turn = await runTurn({
    session: opts.session,
    db: opts.db,
    agentId: before.assigneeAgentId,
    projectId: before.projectId,
    message: composeWorkPrompt(before),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.wallClockTimeoutMs !== undefined
      ? { wallClockTimeoutMs: opts.wallClockTimeoutMs }
      : {}),
    ...(opts.abortGraceMs !== undefined ? { abortGraceMs: opts.abortGraceMs } : {}),
    ...(opts.injectPending !== undefined ? { injectPending: opts.injectPending } : {}),
    // 观察者透传 —— 不传的话 worker 干活的这几分钟在前端是全黑的
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
  });

  // ── 墙钟超时:平台必须处置,而不是留一句「未收敛」(见文件头)──
  let after = getWork(opts.db, before.id) ?? before;
  let timeoutDisposition: TimeoutDisposition | undefined;
  if (turn.timeout !== undefined) {
    timeoutDisposition = disposeTimeout(opts.db, after, turn.timeout);
    after = getWork(opts.db, before.id) ?? after;
  }

  const producedArtifacts = listArtifacts(opts.db, before.projectId).filter(
    (a) => !artifactsBefore.has(a.id),
  );
  const raisedBlockers = listBlockers(opts.db, before.projectId)
    .filter((b) => !blockersBefore.has(b.id))
    .map((b) => b.id);

  return {
    outcome: timeoutDisposition === "marked_failed" ? "timed_out" : classify(after),
    work: after,
    turn,
    producedArtifacts,
    raisedBlockers,
    ...(timeoutDisposition !== undefined ? { timeoutDisposition } : {}),
  };
}

/**
 * 墙钟超时之后把这个工作项收口。返回**实际做了什么**(必须回报,不静默)。
 *
 * 为什么是 `failed`(而不是 blocked,也不是留在 in_progress):
 *
 *  - **留在 `in_progress` = 静默死**(真机现场就是这个):排空器会把它当
 *    `execute_work` 待办反复叫醒,直到尝试预算用尽,然后它既不在待办里、
 *    也没有任何 outbox 事件(业务经理因此永远不会向甲方交代),没有人重试。
 *    而每次叫醒都要再买一个完整的墙钟上界。修 abort 只是让每回合有上界,
 *    留着这个状态等于让「3 × 上界」的账单重复发生,最后还是死。
 *  - **blocked 是假的**:`blocked` 在这个系统里的语义是「已登记阻塞」
 *    (`works.repo` 的注释、`ExecutionOutcome.blocked`、界面上的 `openBlockers`
 *    都这么读)。平台在这里并没有一条阻塞记录可指 —— 写 blocked 会让
 *    「阻塞列表」与工作项状态互相矛盾,而矛盾的状态比没有状态更难排查。
 *  - **failed 是终态里唯一诚实的落点**:它不假装成功(`done`)、不假装有人
 *    登记过阻塞(`blocked`)、也不假装还活着(`in_progress`)。它经
 *    `updateWorkStatus` 这个**唯一写口**写出 `work_failed` outbox 事件
 *    → 业务经理的汇报待办 → 甲方被告知。要人介入才能继续,这是对的失效方向:
 *    一次卡到墙钟的回合,自动重跑只是把同一段卡死行为再买一遍。
 *
 * 不动已经到达终态 / 已 blocked 的工作项:那是它自己在回合里做出的、更权威的
 * 判定(7-M/BC6:「不替它判」)。
 */
function disposeTimeout(
  db: Database.Database,
  work: WorkRow,
  scene: TurnTimeoutScene,
): TimeoutDisposition {
  if (isTerminalWorkStatus(work.status)) return "left_terminal";
  if (work.status === "blocked") return "left_blocked";

  updateWorkStatus(db, work.id, "failed", Date.now());
  log.warn(
    `execution: 工作项 ${work.id}「${work.title}」的回合被墙钟上界打断 ` +
      `(${scene.elapsedMs}ms ≥ ${scene.limitMs}ms · ` +
      (scene.interruptedTool === null
        ? "打断瞬间没有正在跑的工具"
        : `最后在跑 ${scene.interruptedTool.name}(${scene.interruptedTool.runningMs}ms)`) +
      `) —— 记为 failed:不再自动重跑,并写一条 work_failed 事件让业务经理向甲方交代`,
  );
  return "marked_failed";
}

/**
 * 判定结局。
 *
 * **「未收敛」不是失败** —— 它只是「没在这一次里做完」。把它当成失败会让调用方
 * 去做回滚/重试这类它不该做的决定;如实报出来,由上层决定再跑一次还是上报。
 */
function classify(work: WorkRow): ExecutionOutcome {
  switch (work.status) {
    case "done":
    case "failed":
    case "cancelled":
      return "converged";
    case "blocked":
      return "blocked";
    default:
      return "unconverged";
  }
}

function emptyTurn(): TurnResult {
  return {
    text: "",
    thinking: "",
    toolCalls: [],
    openedProjectIds: [],
    pending: { injected: false, summary: "(未执行)" },
    projectContext: { injected: false, summary: "(未执行)" },
    settled: true,
    timedOut: false,
  };
}

/** 把执行结果渲染成可读报告。**含现场**。 */
export function renderExecutionReport(r: ExecutionResult): string {
  const lines: string[] = [];
  lines.push(`工作项: ${r.work.id} 「${r.work.title}」`);
  lines.push(`状态:   ${r.work.status}  →  结局: ${OUTCOME_LABEL[r.outcome]}`);
  if (r.refusalReason !== undefined) lines.push(`拒绝原因: ${r.refusalReason}`);

  if (r.producedArtifacts.length > 0) {
    lines.push(`产出工件 ${r.producedArtifacts.length} 个:`);
    for (const a of r.producedArtifacts) {
      lines.push(`  [${a.kind}] ${a.id}: ${a.title}`);
    }
  } else {
    lines.push("产出工件: 无");
  }
  if (r.raisedBlockers.length > 0) {
    lines.push(`登记阻塞: ${r.raisedBlockers.join(", ")}`);
  }

  lines.push(`工具调用 ${r.turn.toolCalls.length} 次:`);
  for (const t of r.turn.toolCalls) {
    lines.push(
      `  ${t.isError ? "✖" : "✓"} ${t.name} (${t.durationMs}ms)` +
        (t.argsSummary !== "" ? `\n      参数:${t.argsSummary}` : "") +
        (t.resultSummary !== "" ? `\n      结果:${t.resultSummary}` : ""),
    );
  }
  if (r.turn.timeout !== undefined) lines.push(...renderTimeoutScene(r.turn.timeout));
  if (r.timeoutDisposition !== undefined) {
    lines.push(`超时处置: ${TIMEOUT_DISPOSITION_LABEL[r.timeoutDisposition]}`);
  }
  if (r.turn.timedOut) lines.push("⚠️ 回合超时收尾 —— 结局判定可能不准");
  if (r.turn.text.trim() !== "") {
    lines.push("", "它最后说:", r.turn.text.trim());
  }
  return lines.join("\n");
}

const OUTCOME_LABEL: Readonly<Record<ExecutionOutcome, string>> = {
  converged: "已收敛(工作项到达终态)",
  unconverged: "未收敛(工作项仍在进行中 —— 不替它判成功)",
  blocked: "受阻(已登记阻塞)",
  refused: "拒绝执行(前置条件不满足)",
  timed_out: "墙钟超时中断(平台打断并记为 failed —— 需要人介入,不再自动重跑)",
};

const TIMEOUT_DISPOSITION_LABEL: Readonly<Record<TimeoutDisposition, string>> = {
  marked_failed: "记为 failed(终态 · 写出 work_failed 事件 · 不会自动重跑)",
  left_terminal: "它自己在超时前已到达终态 —— 不覆盖",
  left_blocked: "它自己登记了阻塞 —— 不覆盖",
};
