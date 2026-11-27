/**
 * 职责到点那一轮的任务正文(039,2026-11-27)—— 「先看现状再动手」的落点
 *
 * ── 为什么由平台渲染现状 ────────────────────────────────────────
 *
 * 「动手前先看现状」如果只写在提示词里,它取决于模型当下想不想去查。这里把该看的
 * 东西**先摆进任务正文**:职责的目标与边界、上一轮它自己写的自省(尤其是「下一轮
 * 怎么改」)、工作间里没做完的活、出过的失败、等甲方答的问题。它不必记,也漏不掉。
 *
 * 全部是**查出来的事实**,没有一句是平台替模型写的判断。两种形态:
 *   · 开工(没有未收工的一轮)—— 先列功课(`duty_run_open`),再派活;
 *   · 收工(有未收工的一轮)—— 逐步交代、写自省(`duty_run_close`)。
 * 哪一种由库里有没有未收工的一轮决定,与规则判据 `dueDutyPhase` 同源。
 *
 * ⚠️ 只 import `dispatcher.js` 的**类型**:dispatcher 在值这一层引本文件,反过来
 * 引它的值就是一个环。
 */
import type Database from "better-sqlite3";
import type { DriverTodo } from "./dispatcher.js";
import {
  failuresSince, getDuty, openDutyRunOf, lastDutyRunOf,
  type DutyFailure, type DutyRow, type DutyRunRow,
} from "../storage/repo/duties.js";
import {
  isTerminalWorkStatus, listWorks, listWorksPendingReview, type WorkRow,
} from "../storage/repo/works.js";
import { listAsks } from "../storage/repo/asks.js";
import { listArtifacts } from "../storage/repo/artifacts.js";
import { DUTY_MAX_STEPS, cadenceText, formatClock } from "./duty.js";

/** 列表最多逐条列几行;超出的折成一句计数(正文是给模型读的现场,不是报表)。 */
const MAX_LINES = 5;

function head<T>(items: readonly T[]): { readonly shown: readonly T[]; readonly more: number } {
  return { shown: items.slice(0, MAX_LINES), more: Math.max(0, items.length - MAX_LINES) };
}

function workLines(works: readonly WorkRow[]): string[] {
  const { shown, more } = head(works);
  return [
    ...shown.map((w) => `  - ${w.id} [${w.status}] ${w.title}`),
    ...(more > 0 ? [`  -(还有 ${more} 条)`] : []),
  ];
}

function failureLines(failures: readonly DutyFailure[]): string[] {
  if (failures.length === 0) return ["- 没有"];
  const { shown, more } = head(failures);
  return [
    ...shown.map((f) => `  - [${f.kind}] ${f.id}${f.title !== "" ? `「${f.title}」` : ""}`),
    ...(more > 0 ? [`  -(还有 ${more} 件)`] : []),
  ];
}

function selfReviewLines(run: DutyRunRow): string[] {
  return [
    `- 做成:${run.doneSummary ?? "(没写)"}`,
    `- 没做成:${run.notDone ?? "(没写)"}`,
    `- 下一轮怎么改:${run.nextChange ?? "(没写)"}  ← 这一条这一轮要兑现`,
    `- 缺口:${run.gaps ?? "(没写)"}`,
    `- 新知:${run.learned ?? "(没写)"}`,
  ];
}

function dutyLines(duty: DutyRow): string[] {
  return [
    `- 目标:${duty.goal}`,
    `- 节奏:${cadenceText(duty.cadence)}`,
    `- 产出形态:${duty.formal
      ? "正式交付物(走整合 → 交付 → 甲方验收)"
      : "例行产出(成果写进日报,不产出交付物、不用甲方验收)"}`,
    `- 必须先问甲方的事:${duty.boundaries.trim() !== "" ? duty.boundaries : "(甲方没写 —— 按你平时的判断)"}`,
  ];
}

/** 等甲方答的问题数(「球在甲方那边」的结构化事实,与规则里的 `awaitingClient` 同一个读法)。 */
function openClientQuestionCount(db: Database.Database, projectId: string): number {
  return listArtifacts(db, projectId, { kind: "client_question", status: "open", limit: 500 }).length;
}

/** 现状:没做完的活、待审的产出、等甲方答的问题。 */
function stateLines(db: Database.Database, projectId: string, works: readonly WorkRow[]): string[] {
  const open = works.filter((w) => !isTerminalWorkStatus(w.status));
  const pendingReview = listWorksPendingReview(db, projectId);
  const lines: string[] = [];
  if (works.length === 0) {
    lines.push("- 这个工作间里还没有任何工作项");
  } else {
    lines.push(`- 没做完的工作项:${open.length} 条`);
    if (open.length > 0) lines.push(...workLines(open));
  }
  if (pendingReview.length > 0) lines.push(`- 做完了、还等着审的产出:${pendingReview.length} 条`);
  const questions = openClientQuestionCount(db, projectId);
  lines.push(`- 等甲方答的问题:${questions > 0 ? `${questions} 条` : "没有"}`);
  return lines;
}

/** 工作间安静了吗 —— 与规则判据同源的三件事(没有未完成的活、没有待审、没有未答的提问)。 */
function isQuiet(db: Database.Database, projectId: string, works: readonly WorkRow[]): boolean {
  return !works.some((w) => !isTerminalWorkStatus(w.status))
    && listWorksPendingReview(db, projectId).length === 0
    && listAsks(db, projectId, { status: "open" }).length === 0;
}

/**
 * `duty_due` 那一轮的任务正文。待办的 `target` 是职责 id。
 * 职责行已经不在(被删)时如实说,不编一份。
 */
export function renderDutyTask(db: Database.Database, todo: DriverTodo): string {
  // ⚠️ 待办的 `target` 是**职责 id**(不是项目 id)—— 按 id 查职责。第一版这里拿它当项目 id
  // 去 `dutyOfProject` 查,永远查不到:每一轮任务正文都会变成「记录已经不在了」。
  const duty = todo.target !== null ? getDuty(db, todo.target) : null;
  if (duty === null) {
    return "# 现在轮到你了:职责到点了\n\n⚠️ 这条职责的记录已经不在了 —— 无事可做。";
  }
  const open = openDutyRunOf(db, duty.id);
  return open === null ? renderOpen(db, duty) : renderClose(db, duty, open);
}

// ── 开工 ────────────────────────────────────────────────────────

function renderOpen(db: Database.Database, duty: DutyRow): string {
  const last = lastDutyRunOf(db, duty.id);
  const works = listWorks(db, duty.projectId);
  const sinceLast = last !== null && last.finishedAt !== null
    ? failuresSince(db, duty.projectId, last.finishedAt)
    : [];
  const lines: string[] = [
    `# 现在轮到你了:职责「${duty.name}」到点了 —— 开工`,
    "",
    "## 这条职责",
    ...dutyLines(duty),
    "",
    "## 上一轮你写的自省(你自己写的)",
    ...(last === null
      ? ["- 从没开过工 —— 这是第一轮。"]
      : last.status === "open"
        ? ["- 上一轮还没收工(先把它收了,不叠着开新的一轮)。"]
        : selfReviewLines(last)),
    "",
    "## 现状(平台查的,不是猜的)",
    // ⚠️ 这里**不放「现在几点」**:`renderTask` 拿不到 `now`,而任务正文是给模型读的现场。
    // 晚开工多久、错过了几轮这些如实的数字,由 `duty_run_open` 的返回值交给它。
    ...(duty.nextDueAt !== null ? [`- 这一轮服务的排定点:${formatClock(duty.nextDueAt)}`] : []),
    ...stateLines(db, duty.projectId, works),
    "- 上一轮收工之后没成的事:",
    ...(last === null ? ["  (还没有上一轮)"] : failureLines(sinceLast)),
    "",
    "## 这一轮怎么做",
    "1. **先看上面的现状。**不要跳过它直接照昨天的做法来 —— 昨天写的「下一轮怎么改」就是给今天用的。",
    `2. **\`duty_run_open\` 写下这一轮的功课**:1–${DUTY_MAX_STEPS} 步,每步一条可检验的标准;` +
    "只推进朝着职责目标最小的一步。写不出功课,说明还没想清这一轮做什么。",
    "3. **派活,不自己干**:`ask_role` 请项目经理拆成工作项(这里拆出来的活**已经确认开工**,不用甲方再点)。" +
    (duty.formal
      ? "正式交付物的职责照完整流程走:整合 → 交付 → 甲方验收。"
      : "例行产出让他拆成**平的工作项、不建根容器**,产出写成笔记或证据,不写成正式交付物。"),
    "4. 列完功课,这一轮**先不收工**。活落定之后平台会再叫你收工。",
    "",
    "这一轮的正文就是给甲方的:写下这一轮打算做哪几步。不挂 `[未播报]`,不必再 `tell_client`。",
  ];
  return lines.join("\n");
}

// ── 收工 ────────────────────────────────────────────────────────

function renderClose(db: Database.Database, duty: DutyRow, run: DutyRunRow): string {
  const works = listWorks(db, duty.projectId);
  const touched = works.filter((w) => w.updatedAt >= run.startedAt);
  // ⚠️ 「还没做完的」看工作间里**全部**非终态的活,不只是这一轮动过的:一条在开工前
  // 就卡住、这一轮没碰的活同样是「没做成」,不能因为没被动过就从正文里消失。
  const stillOpen = works.filter((w) => !isTerminalWorkStatus(w.status));
  const failures = failuresSince(db, duty.projectId, run.startedAt);
  // 为什么是现在收:规则只在两种情况下叫业务经理来收工 —— 工作间安静了,或者已经
  // 拖到了下一个排定点。安静与否在这里算得出;算出来不安静,就只可能是后者。
  const why = isQuiet(db, duty.projectId, works)
    ? "工作间安静了:没有未完成的活、没有待审的产出、没有未答的提问。"
    : `已经到了下一个排定点(${duty.nextDueAt !== null ? formatClock(duty.nextDueAt) : ""}):` +
      "上一轮到此为止 —— 没做完的照实写进「没做成」,不把它拖进新一轮。";
  const lines: string[] = [
    `# 现在轮到你了:职责「${duty.name}」这一轮该收工了 —— 写自省`,
    "",
    `为什么是现在:${why}`,
    "",
    "## 这一轮的功课(你开工时列的)",
    ...run.steps.map((s, i) => `${i + 1}. ${s.title} —— ${s.criterion}`),
    "",
    "## 这一轮新落的事(平台查的)",
    "- 这一轮里没成的:",
    ...failureLines(failures),
    `- 这一轮动过的工作项:${touched.length} 条`,
    ...(touched.length > 0 ? workLines(touched) : []),
    ...(stillOpen.length > 0
      ? [`- ⚠️ 还没做完的工作项:${stillOpen.length} 条 —— 它们要如实写进「没做成」。`, ...workLines(stillOpen)]
      : []),
    "",
    "## 收工怎么做",
    "- `duty_run_close`:每一步功课都标做成没做成;做成 / 没做成 / 下一轮怎么改 / 缺口 / 新知五项都填",
    "  (没有就写「无」,不许空着)。",
    ...(failures.length > 0
      ? [`- ⚠️ 这一轮有 ${failures.length} 件事没成:**「原因在自己哪一步」(\`cause\`)不许为空** ——` +
        "先想自己(目标写清了吗 / 判据给了吗 / 现状看了吗 / 派活说明白了吗),再想怎么改。"]
      : []),
    "- 不报百分比,不说「一切顺利」;没做到的、存疑的、没覆盖的,照实列出来。",
    "",
    "收工后你写的正文就是给甲方的日报:写成几步、共几步;做成了什么、还差什么。",
    "不挂 `[未播报]`,不必再 `tell_client`;不写工具名、内部角色名、工作项 id。",
  ];
  return lines.join("\n");
}
