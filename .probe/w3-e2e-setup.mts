/**
 * W3-③ 端到端 · **第 1 步:把副本库造成「只差一个汇报待办」的状态**
 *
 * ── 为什么要造状态(以及造的是哪一部分)──────────────────────────
 *
 * 要验的东西是**平台叫醒业务经理的那个回合**(`trigger.kind === "todo"`)——
 * 只有这种回合才该出现工作记录行 `[未播报] …`(提示词 `business_manager.core`
 * 第 171 行),也只有它会被 `detectUnannouncedTurn` 事后检查。
 *
 * 而这时候的 `~/.sansheng/sansheng.db` **是空的**(0 项目 / 0 工作项 / 0 工件,
 * 只有一条接待会话的 8 条消息 —— 与 HANDOFF 里「1 根 + 4 子」那份快照已经不
 * 是同一个库了)。所以要么真跑一整条「立项 → 拆解 → 执行 → 整合」的流水线
 * (十来个回合、花掉用户大量 token,而且结果不确定),要么**只造那一条触发**。
 *
 * 造的是:`projects` / `project_assignments` / 一条根工作项 / 一条
 * **未 accepted 的 `deliverable` 工件** / 一条 `work_failed` 事件。
 * 造完由 `collectTodos` **自己**回报「现在可执行的待办有哪些」—— 本脚本要求
 * 它**恰好**是 `report_downstream` 一条(见下面 `assertOnlyReportTodo`)。
 *
 * 不造的是:回合本身。触发之后的一切(提示词、模型、工具调用、落库、
 * `[未播报]` 判定、通道判定)全部由**真宿主 + 真模型**跑,本脚本一个字节都不碰。
 *
 * ── 为什么这些行必须由**仓储**写(不是裸 SQL)──────────────────
 *
 * 裸 SQL 会绕开仓储的闭集校验与业务不变量(例如 `insertDispatchEvent` 的
 * `worthInterrupting`、`review_state` 的初值推导)。用仓储写 = 写进去的行与
 * 生产路径写进去的行同形。
 *
 * 用法:`npx tsx .probe/w3-e2e-setup.mts <dataDir>`
 */
import { join } from "node:path";
import { openPlatformDb } from "../src/platform/storage/db.js";
import { insertProject, addMember } from "../src/platform/storage/repo/projects.js";
import { listAgents } from "../src/platform/storage/repo/agents.js";
import { insertWork } from "../src/platform/storage/repo/works.js";
import { insertArtifact } from "../src/platform/storage/repo/artifacts.js";
import { insertDispatchEvent } from "../src/platform/storage/repo/dispatch.js";
import { collectTodos } from "../src/platform/runtime/dispatcher.js";

const dataDir = process.argv[2];
if (dataDir === undefined) {
  console.error("用法:npx tsx .probe/w3-e2e-setup.mts <dataDir>");
  process.exit(2);
}

const NOW = Date.now();
const PROJECT = `p_e2e_${NOW}`;
const WORK = `w_e2e_${NOW}`;
const DELIVERABLE = `a_e2e_${NOW}`;

const db = openPlatformDb(join(dataDir, "sansheng.db"));

// ── 0. 已有组织吗(agents 表在真库里已经有那四个角色)──────────────
const agents = listAgents(db);
const byRole = new Map(agents.map((a) => [a.role, a.id]));
for (const role of ["business_manager", "project_manager", "worker", "quality_reviewer"] as const) {
  if (!byRole.has(role)) throw new Error(`副本库里没有角色 ${role} —— 这份脚本假定组织已播种`);
}
const bm = byRole.get("business_manager")!;
const pm = byRole.get("project_manager")!;
const wk = byRole.get("worker")!;
const qa = byRole.get("quality_reviewer")!;
console.log(`[setup] agents: bm=${bm} pm=${pm} wk=${wk} qa=${qa}`);

// ── 1. 项目 + 四名成员 ─────────────────────────────────────────
insertProject(db, {
  id: PROJECT,
  name: "W3 E2E 验收项目",
  client: "甲方",
  goal: "验证平台叫醒业务经理的回合会留下工作记录([未播报])",
  status: "active",
  createdAt: NOW,
});
for (const id of [bm, pm, wk, qa]) addMember(db, PROJECT, id, NOW);
console.log(`[setup] project ${PROJECT} + 4 名成员`);

// ── 2. 一条**已收口**的根工作项 ────────────────────────────────
//
// `status='done'` + `review_state='done'` ⇒ `execute_work` / `review_work` 都不成立;
// 有一条工作项 ⇒ `decompose_project` 不成立。
insertWork(db, {
  id: WORK,
  projectId: PROJECT,
  parentWorkId: null,
  title: "把登录做出来",
  goal: "验收判据:能登录",
  status: "done",
  reviewState: "done",
  assigneeAgentId: wk,
  createdAt: NOW,
  updatedAt: NOW,
});
console.log(`[setup] work ${WORK}(done + review done,根)`);

// ── 3. 一条**未 accepted** 的 deliverable 工件 ─────────────────
//
// 它的作用是**压住两条规则**:
//   · `integrate` 的判据是「收口了 **且** 子树上没有 deliverable」⇒ 有它就不叫 PM 整合;
//   · `handover` 要的是 `status='accepted'` 的 deliverable ⇒ `open` 不满足,不叫 BM 交付。
// 这正是「用工件推动流程」那条设计的正常形态,不是为了让测试好写而编的状态。
insertArtifact(db, {
  id: DELIVERABLE,
  projectId: PROJECT,
  conversationId: null,
  kind: "deliverable",
  status: "open",
  authorAgentId: pm,
  title: "登录模块交付物",
  body: "E2E 夹具:一条尚未验收的交付物(压住 integrate / handover 两条规则)",
  metadataJson: null,
  createdAt: NOW,
  updatedAt: NOW,
  workId: WORK,
});
console.log(`[setup] deliverable ${DELIVERABLE}(open,挂在根工作项上)`);

// ── 4. 一条 `work_failed` outbox 事件 —— **真正要验的那条触发** ──
//
// 选 `work_failed` 而不是 `work_done`:后者要等合并窗口(攒够 3 条或最老的一条
// 等 5 分钟),前者**绕过窗口立刻叫醒**(`immediateEvent`)⇒ 一次干净的触发,
// 不必往库里塞三条假事件。
const ev = insertDispatchEvent(db, {
  projectId: PROJECT,
  kind: "work_failed",
  subjectId: WORK,
  summary: "E2E 夹具:某条下游工作项失败(用事件触发业务经理的汇报待办)",
  createdAt: NOW,
});
if (!ev.written) throw new Error(`insertDispatchEvent 未写入:${ev.reason} —— ${ev.detail ?? ""}`);
console.log(`[setup] dispatch_event work_failed subject=${WORK}`);

// ── 5. 自检(正样本):待办**恰好**是 report_downstream 一条 ──────
//
// 这一步是本脚本存在的意义:否则真模型会先被别的待办叫去干别的活(拆解 / 分派 /
// 审查 / 整合),而我要看的那个回合**根本不会发生** —— 那会变成一次「跑了但验错了」
// 的检查(本项目三类静默失败之一)。
const board = collectTodos({ db, projectId: PROJECT, now: NOW });
const kinds = board.runnable.map((t) => `${t.role}:${t.kind}`);
console.log(`[setup] collectTodos ⇒ runnable=[${kinds.join(", ")}] exhausted=[${board.exhausted.length}]`);
const only = board.runnable.length === 1 && board.runnable[0]!.kind === "report_downstream";
if (!only) {
  console.error(
    `[setup] ✗ 负样本失败:期待**恰好**一条 report_downstream,实际 [${kinds.join(", ")}] —— ` +
      `真回合会被别的待办先叫走,这次 E2E 不作数`,
  );
  db.close();
  process.exit(1);
}
// 顺带把这条待办的 label 打出来(它是「为什么叫醒」的可读现场)
console.log(`[setup] ✓ 唯一待办:${board.runnable[0]!.label}`);
console.log(`[setup] PROJECT_ID=${PROJECT}`);
console.log(`[setup] WORK_ID=${WORK}`);
db.close();
