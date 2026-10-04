/**
 * BC1 ProjectManagement · works / work_deps 仓储
 *
 * `works` 是工作项树(通过 parent_work_id 分层),`work_deps` 是 DAG 依赖边。
 *
 * ── 环检测为什么必须在 repo 层 ────────────────────────────────────
 *
 * 自环由 schema 的 `CHECK (work_id <> depends_on_work_id)` 拒绝,但**多跳环**
 * SQL 表达不了。而这个项目在旧代码里已经踩过一次 DAG 通配 bug —— 死循环的
 * 表现是「计划永远跑不完」,事后极难归因。所以 `createsCycle` 是写依赖前的
 * 强制前置,不是可选的优化。
 */
import type Database from "better-sqlite3";
import { insertDispatchEvent, type DispatchEventKind } from "./dispatch.js";

export type WorkStatus = "open" | "in_progress" | "blocked" | "done" | "failed" | "cancelled";

export const WORK_STATUSES: readonly WorkStatus[] = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "failed",
  "cancelled",
];

/**
 * 工作项的**审查态**(migration 013)。数据模型里此前没有「等待审查」这个状态,
 * 所以质检的待办只能靠级联观察到的内存事件 —— 不持久、重启不补跑。
 *
 *   none    不该被审(非 done)
 *   pending 已是 done、等着审   ← 质检的待办 = 一条查询(见 listWorksPendingReview)
 *   done    审过了(平台在质检那个回合成功结束后写)
 */
export type ReviewState = "none" | "pending" | "done";

export const REVIEW_STATES: readonly ReviewState[] = ["none", "pending", "done"];

export function isReviewState(v: unknown): v is ReviewState {
  return typeof v === "string" && (REVIEW_STATES as readonly string[]).includes(v);
}

/** 终态:不再推进。用于判断「能不能从这条边继续往下解」 */
const TERMINAL: ReadonlySet<WorkStatus> = new Set<WorkStatus>(["done", "failed", "cancelled"]);

export function isWorkStatus(v: unknown): v is WorkStatus {
  return typeof v === "string" && (WORK_STATUSES as readonly string[]).includes(v);
}

export function isTerminalWorkStatus(s: WorkStatus): boolean {
  return TERMINAL.has(s);
}

export interface WorkRow {
  id: string;
  projectId: string;
  parentWorkId: string | null;
  title: string;
  goal: string;
  status: WorkStatus;
  /** 审查态(migration 013)。质检的待办由它查出来,不靠任何内存事件。 */
  reviewState: ReviewState;
  assigneeAgentId: string;
  createdAt: number;
  updatedAt: number;
}

interface RawWork {
  id: string;
  project_id: string;
  parent_work_id: string | null;
  title: string;
  goal: string;
  status: string;
  review_state: string;
  assignee_agent_id: string;
  created_at: number;
  updated_at: number;
}

function rowToWork(raw: RawWork): WorkRow {
  if (!isWorkStatus(raw.status)) {
    throw new Error(`works 表里出现未定义状态「${raw.status}」(id=${raw.id})`);
  }
  if (!isReviewState(raw.review_state)) {
    throw new Error(`works 表里出现未定义 review_state「${raw.review_state}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    parentWorkId: raw.parent_work_id,
    title: raw.title,
    goal: raw.goal,
    status: raw.status,
    reviewState: raw.review_state,
    assigneeAgentId: raw.assignee_agent_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

// ── works ───────────────────────────────────────────────────────

/**
 * 新建工作项时它就 `done` 的场合(测试/CLI 直接造终态项):那也是一份没人审过的
 * 产出,所以进 `pending`,与「状态迁移到 done」走同一条语义。
 */
function initialReviewState(status: WorkStatus): ReviewState {
  return status === "done" ? "pending" : "none";
}

/**
 * 插入用的一行。`reviewState` 可省:调用方不需要知道审查态这条内部状态 ——
 * 它由状态推导(见 `initialReviewState`),只有重建历史数据时才显式指定。
 */
export type NewWorkRow = Omit<WorkRow, "reviewState"> & { readonly reviewState?: ReviewState };

export function insertWork(db: Database.Database, row: NewWorkRow): void {
  db.prepare(
    `INSERT INTO works (id, project_id, parent_work_id, title, goal, status, review_state,
                        assignee_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.projectId, row.parentWorkId, row.title, row.goal,
    row.status, row.reviewState ?? initialReviewState(row.status), row.assigneeAgentId,
    row.createdAt, row.updatedAt,
  );
}

export function getWork(db: Database.Database, id: string): WorkRow | null {
  const raw = db.prepare(`SELECT * FROM works WHERE id = ?`).get(id) as RawWork | undefined;
  return raw ? rowToWork(raw) : null;
}

export interface ListWorksFilter {
  status?: WorkStatus;
  assigneeAgentId?: string;
  parentWorkId?: string;
  /** true = 只要顶层工作项(parent 为空) */
  rootsOnly?: boolean;
}

export function listWorks(
  db: Database.Database,
  projectId: string,
  filter: ListWorksFilter = {},
): WorkRow[] {
  const where = ["project_id = ?"];
  const vals: unknown[] = [projectId];
  if (filter.status !== undefined) { where.push("status = ?"); vals.push(filter.status); }
  if (filter.assigneeAgentId !== undefined) {
    where.push("assignee_agent_id = ?"); vals.push(filter.assigneeAgentId);
  }
  if (filter.parentWorkId !== undefined) {
    where.push("parent_work_id = ?"); vals.push(filter.parentWorkId);
  }
  if (filter.rootsOnly === true) where.push("parent_work_id IS NULL");
  const rows = db
    .prepare(`SELECT * FROM works WHERE ${where.join(" AND ")} ORDER BY created_at`)
    .all(...vals) as RawWork[];
  return rows.map(rowToWork);
}

/**
 * 改状态。**这是 `works.status` 的唯一写口**,所以审查态与下游事件都在这里维护 ——
 * 散到各个调用方去写,迟早有一条路漏掉,而漏掉的表现是静默的
 * (产出没人审 / 做完了没人向甲方交代)。
 *
 * 两条不变量:
 *   ① 迁入 `done` → `review_state = 'pending'`(产出等审);迁出 `done` → `none`
 *   ② 迁入 `done` / `failed` / `blocked` → 记一条 `dispatch_events`
 *      (业务经理的汇报待办由它查出来 —— 不再是级联观察到的内存事件)
 */
export function updateWorkStatus(
  db: Database.Database,
  id: string,
  status: WorkStatus,
  at: number,
): void {
  const before = getWork(db, id);
  const reviewState: ReviewState =
    status !== "done"
      ? "none"
      : before?.status === "done"
        ? (before.reviewState ?? "pending")
        : "pending";
  db.prepare(`UPDATE works SET status = ?, updated_at = ?, review_state = ? WHERE id = ?`).run(
    status, at, reviewState, id,
  );

  if (before === null || before.status === status) return;
  const kind = EVENT_KIND[status];
  if (kind === undefined) return;
  insertDispatchEvent(db, {
    projectId: before.projectId,
    kind,
    subjectId: id,
    summary: `${labelFor(before.title, status)}`,
    createdAt: at,
  });
}

/** 状态 → 下游事件种类。只有这三条对甲方有信息量(`in_progress` 之类不算)。 */
const EVENT_KIND: Readonly<Partial<Record<WorkStatus, DispatchEventKind>>> = {
  done: "work_done",
  failed: "work_failed",
  blocked: "work_blocked",
};

function labelFor(title: string, status: WorkStatus): string {
  const how =
    status === "done" ? "已完成" : status === "failed" ? "失败了" : "受阻";
  return `「${title}」${how}`;
}

/**
 * **等审的工作项** —— 质检那条待办的唯一判据。
 *
 * 它就是一条查询(部分索引 `idx_works_pending_review` 为它建),所以:
 *   - 重启后能补跑(状态在库里,不在进程内存里)
 *   - 「刚刚完成」这种内存事件不再是判据(那是批次 20 不持久、重启不补跑的根因)
 */
export function listWorksPendingReview(
  db: Database.Database,
  projectId: string,
): WorkRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM works
       WHERE project_id = ? AND status = 'done' AND review_state = 'pending'
       ORDER BY updated_at, id`,
    )
    .all(projectId) as RawWork[];
  return rows.map(rowToWork);
}

/**
 * 标记已审(平台在质检那个回合**成功结束之后**写)。
 *
 * 判据不是「模型有没有写 review_finding」—— 那依赖模型自己建立 artifact_link,
 * 现有模型里没有保证(见 `docs/DESIGN-PLATFORM.md` 与 AGENTS.md 的说明)。
 * 平台能确定的事实是:**这一份产出已经被交给质检看过一次了**;它到底审出了什么,
 * 现场在那一回合的会话消息与工件里。若这一回合失败/被中断,调用方**不写**,
 * 于是下次 tick 重来(at-least-once)。
 */
export function markWorkReviewed(db: Database.Database, id: string, at: number): void {
  db.prepare(
    `UPDATE works SET review_state = 'done', updated_at = ?
     WHERE id = ? AND status = 'done' AND review_state = 'pending'`,
  ).run(at, id);
}

/** 改派。设计 1 §3.3:改派与分派走同一条解析路径,避免「改派绕过歧义检查」。 */
export function assignWork(
  db: Database.Database,
  id: string,
  assigneeAgentId: string,
  at: number,
): void {
  db.prepare(`UPDATE works SET assignee_agent_id = ?, updated_at = ? WHERE id = ?`).run(
    assigneeAgentId,
    at,
    id,
  );
}

export function deleteWork(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM works WHERE id = ?`).run(id);
}

// ── work_deps ───────────────────────────────────────────────────

/**
 * 加一条依赖前的环检测。
 *
 * 语义:要加 `workId depends on depId`。若从 `depId` 沿 depends_on 方向能走回
 * `workId`,则这条边会成环。
 *
 * 用已访问集合 + 显式栈做 DFS —— 不设深度上限(工作项树本来可能很深),
 * 靠 visited 保证终止。
 */
export function createsCycle(
  db: Database.Database,
  workId: string,
  depId: string,
): boolean {
  if (workId === depId) return true; // 自环(schema 也拦,这里给出更早的失败)
  const stmt = db.prepare(`SELECT depends_on_work_id FROM work_deps WHERE work_id = ?`);
  const visited = new Set<string>();
  const stack = [depId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === workId) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const r of stmt.all(cur) as Array<{ depends_on_work_id: string }>) {
      stack.push(r.depends_on_work_id);
    }
  }
  return false;
}

export type AddDepResult =
  | { ok: true }
  | { ok: false; reason: "self" | "cycle" | "duplicate" | "not_found" };

/** 加依赖。**环检测是前置**,成环时不写库并返回结构化原因。 */
export function addDep(db: Database.Database, workId: string, depId: string): AddDepResult {
  if (workId === depId) return { ok: false, reason: "self" };
  if (getWork(db, workId) === null || getWork(db, depId) === null) {
    return { ok: false, reason: "not_found" };
  }
  const exists = db
    .prepare(`SELECT 1 FROM work_deps WHERE work_id = ? AND depends_on_work_id = ?`)
    .get(workId, depId);
  if (exists) return { ok: false, reason: "duplicate" };
  if (createsCycle(db, workId, depId)) return { ok: false, reason: "cycle" };
  db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run(workId, depId);
  return { ok: true };
}

export function removeDep(db: Database.Database, workId: string, depId: string): void {
  db.prepare(`DELETE FROM work_deps WHERE work_id = ? AND depends_on_work_id = ?`).run(
    workId,
    depId,
  );
}

/** 我的前置(我必须等谁) */
export function listDeps(db: Database.Database, workId: string): string[] {
  const rows = db
    .prepare(`SELECT depends_on_work_id FROM work_deps WHERE work_id = ?`)
    .all(workId) as Array<{ depends_on_work_id: string }>;
  return rows.map((r) => r.depends_on_work_id);
}

/** 我的后继(谁在等我)—— 一条边完成后要唤醒的那批 */
export function listDependents(db: Database.Database, workId: string): string[] {
  const rows = db
    .prepare(`SELECT work_id FROM work_deps WHERE depends_on_work_id = ?`)
    .all(workId) as Array<{ work_id: string }>;
  return rows.map((r) => r.work_id);
}

/**
 * 一条工作项的前置状态,**分三态**而不是一个布尔。
 *
 * 为什么必须分开:旧系统的 todo 依赖只有「满足/未满足」,于是上游 failed 时
 * 下游只能干等 —— 而它等的那个东西永远不会来。旧代码为此专门有
 * `cascadeFailDependents`。这里把区分做进返回值,让调用方**必须**显式决定
 * 「等」还是「级联失败」,不能靠默认行为糊过去。
 */
export interface DepState {
  /** 已 done —— 依赖满足 */
  satisfied: string[];
  /** failed / cancelled —— **永远不可能满足**,调用方应级联失败而非等待 */
  failed: string[];
  /** 仍在推进 —— 等得起 */
  pending: string[];
  /** 依赖指向的工作项不存在(数据损坏) */
  missing: string[];
}

export function depState(db: Database.Database, workId: string): DepState {
  const state: DepState = { satisfied: [], failed: [], pending: [], missing: [] };
  for (const d of listDeps(db, workId)) {
    const w = getWork(db, d);
    if (w === null) { state.missing.push(d); continue; }
    if (w.status === "done") state.satisfied.push(d);
    else if (w.status === "failed" || w.status === "cancelled") state.failed.push(d);
    else state.pending.push(d);
  }
  return state;
}

/** 前置是否全部满足(可以开工)。failed / missing 都算「不满足」—— 它们不该被当成放行。 */
export function depsSatisfied(db: Database.Database, workId: string): boolean {
  const s = depState(db, workId);
  return s.failed.length === 0 && s.pending.length === 0 && s.missing.length === 0;
}
