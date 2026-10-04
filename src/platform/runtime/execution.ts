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
 */
import type Database from "better-sqlite3";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  getWork, updateWorkStatus, type WorkRow,
} from "../storage/repo/works.js";
import { listArtifacts, type ArtifactRow } from "../storage/repo/artifacts.js";
import { listBlockers } from "../storage/repo/blockers.js";
import { getAgent } from "../storage/repo/agents.js";
import { runTurn, type TurnResult } from "./turn.js";

export type ExecutionOutcome =
  /** 工作项被推到了终态(done / failed / cancelled) */
  | "converged"
  /** 回合结束但工作项仍在进行中 —— **不替它判成功** */
  | "unconverged"
  /** 工作项状态是 blocked —— 它如实登记了阻塞,这是合法结局 */
  | "blocked"
  /** 工作项根本不该被执行(状态/归属不对) */
  | "refused";

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
}

export interface RunWorkOptions {
  readonly session: AgentSession;
  readonly db: Database.Database;
  readonly workId: string;
  readonly timeoutMs?: number;
  readonly injectPending?: boolean;
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
    ...(opts.injectPending !== undefined ? { injectPending: opts.injectPending } : {}),
  });

  const after = getWork(opts.db, before.id) ?? before;
  const producedArtifacts = listArtifacts(opts.db, before.projectId).filter(
    (a) => !artifactsBefore.has(a.id),
  );
  const raisedBlockers = listBlockers(opts.db, before.projectId)
    .filter((b) => !blockersBefore.has(b.id))
    .map((b) => b.id);

  return {
    outcome: classify(after),
    work: after,
    turn,
    producedArtifacts,
    raisedBlockers,
  };
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
    pending: { injected: false, summary: "(未执行)" },
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
};
