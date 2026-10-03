/**
 * BC2 · 待办注入面(ADR-001 §5.2)
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 新模型里提问者进入 blocked,而**收到方不会主动知道**有东西在等它。
 * 旧系统靠 watchdog + artifactBus 事件推送;新模型把「判断」交给了收到方的
 * 正常回合 —— 但如果没人告诉它有东西在等,那个回合永远不会发生。
 *
 * 没有这一层会发生什么:整个 7-L 升级链在真实运行中**停摆**,而单元测试全绿
 * —— 因为测试都是显式调用 `ask_list` 的。这是「测试通过但系统不动」的典型形态。
 *
 * ── 为什么做成纯函数而不是「会话启动时查一次」──────────────���───────
 *
 * 「什么时候注入」是运行时的事(每轮?启动时?);「注入什么」是纯逻辑。
 * 拆开之后后者可以穷举测试,而前者只需要一行调用。
 *
 * ── 它不做的事 ──────────────────────────────────────────────────
 *
 * 不查数据库之外的任何东西、不写状态、不决定「要不要打扰」。它只回答
 * 「这个人此刻手上有哪些悬而未决的事」,并渲染成一段可注入的文本。
 * 「要不要现在就注入」由调用方决定。
 */
import type Database from "better-sqlite3";
import { listAsks, askedByMeOpen, listOverdueAsks, type AskRow } from "../storage/repo/asks.js";
import { pendingMeetingsFor, type MeetingRow } from "../storage/repo/meetings.js";
import { getAgent } from "../storage/repo/agents.js";
import { listBlockers, type BlockerRow } from "../storage/repo/blockers.js";
import { listChanges, type ChangeRequestRow } from "../storage/repo/changes.js";

export interface PendingWork {
  /** 在等我答的提问 —— **最高优先级**,有人因为我停着 */
  asksToAnswer: readonly AskRow[];
  /** 等我表态的会议(异步,不阻塞,但不该忘) */
  meetingsToRespond: readonly MeetingRow[];
  /** 我自己卡住的(我是提问者且还没结论)—— 用于让 agent 知道自己在等谁 */
  myBlockedAsks: readonly AskRow[];
  /** 已过截止仍未答复的 —— 仅统计,处置由调度器决定(ADR-001 §5.3) */
  overdueAsks: readonly AskRow[];
  /** 该项目未解决的阻塞 —— 供业务经理向甲方交代状况 */
  openBlockers: readonly BlockerRow[];
  /** 待评审的变更 */
  pendingChanges: readonly ChangeRequestRow[];
}

/** 收集一个 agent 在某项目里的全部待办。纯查询,无副作用。 */
export function collectPendingWork(
  db: Database.Database,
  agentId: string,
  projectId: string,
  now: number,
): PendingWork {
  return {
    asksToAnswer: listAsks(db, projectId, { toAgentId: agentId, actionableOnly: true }),
    meetingsToRespond: pendingMeetingsFor(db, agentId),
    myBlockedAsks: askedByMeOpen(db, agentId),
    overdueAsks: listOverdueAsks(db, now, projectId),
    openBlockers: listBlockers(db, projectId, { unresolvedOnly: true }),
    pendingChanges: listChanges(db, projectId, { status: "proposed" }),
  };
}

/** 有没有任何需要该 agent 动手的事。用于决定「要不要注入」。 */
export function hasActionableWork(w: PendingWork): boolean {
  return (
    w.asksToAnswer.length > 0 ||
    w.meetingsToRespond.length > 0 ||
    w.pendingChanges.length > 0
  );
}

/** 一句话摘要(日志/诊断用)。 */
export function summarizePendingWork(w: PendingWork): string {
  const parts: string[] = [];
  if (w.asksToAnswer.length > 0) parts.push(`${w.asksToAnswer.length} 条等你答`);
  if (w.meetingsToRespond.length > 0) parts.push(`${w.meetingsToRespond.length} 场会等表态`);
  if (w.pendingChanges.length > 0) parts.push(`${w.pendingChanges.length} 条变更待评审`);
  if (w.myBlockedAsks.length > 0) parts.push(`你自己卡着 ${w.myBlockedAsks.length} 条`);
  if (w.overdueAsks.length > 0) parts.push(`${w.overdueAsks.length} 条已超时`);
  if (w.openBlockers.length > 0) parts.push(`${w.openBlockers.length} 个未解决阻塞`);
  return parts.length > 0 ? parts.join(" · ") : "无待办";
}

function nameOf(db: Database.Database, agentId: string): string {
  const a = getAgent(db, agentId);
  return a ? `${a.displayName}(${a.role})` : agentId;
}

/**
 * 渲染成可注入的文本。
 *
 * ── 与 `hasActionableWork` 的分工:一个是「有什么话要说」,一个是「要不要打断你」──
 *
 * 这两个判断**必须分开**,合并会两头不讨好:
 *   - 只按 actionable 渲染 → 业务经理想向甲方交代「有哪些未解决阻塞」时,
 *     那段信息根本渲染不出来(阻塞不是 actionable,没人被它阻塞着等回复)
 *   - 只按「有内容」唤醒 → 每轮都因为挂着几个老阻塞而注入一遍,白占 context
 *
 * 所以:渲染 = 我知道的全部;要不要注入 = 调用方按 `hasActionableWork` 决定。
 *
 * **真的一条都没有时返回空串** —— 让调用方可以无脑拼接。返回一段「你没有待办」
 * 的废话会白占 context,而重试轮里它会反复出现。
 */
export function renderPendingWork(db: Database.Database, w: PendingWork): string {
  const hasAnything =
    w.asksToAnswer.length > 0 ||
    w.meetingsToRespond.length > 0 ||
    w.pendingChanges.length > 0 ||
    w.myBlockedAsks.length > 0 ||
    w.overdueAsks.length > 0 ||
    w.openBlockers.length > 0;
  if (!hasAnything) return "";
  const lines: string[] = ["## 当前待办"];

  if (w.asksToAnswer.length > 0) {
    lines.push(
      "",
      `### 等你的提问(${w.asksToAnswer.length})—— 有人因此停着`,
      "**先处理这些**:提问者处于 blocked,你不答它就走不下去。",
      "能自己判断的直接 `answer`;判不了才 `escalate`(目标由平台计算)。",
      ...w.asksToAnswer.map(
        (a) =>
          `- ${a.id} ← ${nameOf(db, a.fromAgentId)}:${a.question.split("\n")[0]}` +
          `\n    它的假设:${a.hypothesis.split("\n")[0]}`,
      ),
    );
  }

  if (w.meetingsToRespond.length > 0) {
    lines.push(
      "",
      `### 等你表态的会议(${w.meetingsToRespond.length})`,
      "用 `meeting_read` 看议题与已有立场,`meeting_respond` 表态(反对必须写理由)。",
      ...w.meetingsToRespond.map((m) => `- ${m.id}:${m.topic}(发起人 ${nameOf(db, m.conveningAgentId)})`),
    );
  }

  if (w.pendingChanges.length > 0) {
    lines.push(
      "",
      `### 待评审的变更(${w.pendingChanges.length})`,
      "用 `change_read` 看理由与影响面,`change_review` 推进状态。",
      ...w.pendingChanges.map((c) => `- ${c.id}:${c.title}`),
    );
  }

  if (w.myBlockedAsks.length > 0) {
    lines.push(
      "",
      `### 你自己在等的(${w.myBlockedAsks.length})`,
      "这些还没结论,你目前被它们挡着。",
      ...w.myBlockedAsks.map((a) => `- ${a.id} → ${nameOf(db, a.toAgentId)}(状态 ${a.status})`),
    );
  }

  if (w.overdueAsks.length > 0) {
    lines.push(
      "",
      `### 已超时的提问(${w.overdueAsks.length})`,
      "**注意**:当前没有调度器周期性处置超时(ADR-001 §5.3),所以请自行判断是否催办或改走升级。",
      ...w.overdueAsks.map((a) => `- ${a.id}(截止 ${new Date(a.deadlineAt ?? 0).toISOString()})`),
    );
  }

  if (w.openBlockers.length > 0) {
    lines.push(
      "",
      `### 未解决的阻塞(${w.openBlockers.length})`,
      "向甲方交代项目状况时要能说清这些;用 `blocker_read` 看现场。",
      ...w.openBlockers.map((b) => `- [${b.severity}] ${b.id}:${b.title}`),
    );
  }

  return lines.join("\n");
}
