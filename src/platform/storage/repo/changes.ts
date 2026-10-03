/**
 * BC4 ChangeControl · change_requests 仓储
 *
 * 需求变更的独立生命周期(设计 1 §6.3):
 *
 *   proposed → under_review → accepted → implemented
 *                    └──────→ rejected
 *
 * ── 为什么变更要独立成实体 ────────────────────────────────────────
 *
 * 变更改的是**项目范围**,不是推进进度 —— 它与工作项是两种东西。
 * 设计 2 §3.2 据此把 `project.update` 只给业务经理:项目经理要改范围必须走
 * `change.propose`。否则「能直接改项目目标」会让整个变更管理失去意义。
 *
 * 影响面用 `change_affects` 关联表而非 JSON 列 —— 见 migrations/008 文件头。
 */
import type Database from "better-sqlite3";

export type ChangeStatus =
  | "proposed"
  | "under_review"
  | "accepted"
  | "implemented"
  | "rejected";

export const CHANGE_STATUSES: readonly ChangeStatus[] = [
  "proposed",
  "under_review",
  "accepted",
  "implemented",
  "rejected",
];

/** 终态:不再流转 */
const CHANGE_TERMINAL: ReadonlySet<ChangeStatus> = new Set<ChangeStatus>([
  "implemented",
  "rejected",
]);

/**
 * 合法的状态迁移。**白名单而非黑名单** —— 未列出的迁移一律拒绝。
 *
 * 为什么需要它:`proposed` 直接跳 `implemented`(没评审就实施)是这类流程
 * 最典型的漏洞,而它不会以报错的形式出现,只会以「验收时发现没人评过」的形式
 * 出现 —— 那时已经晚了。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ChangeStatus, readonly ChangeStatus[]>> = {
  proposed: ["under_review", "rejected"],
  under_review: ["accepted", "rejected"],
  accepted: ["implemented", "rejected"],
  implemented: [],
  rejected: [],
};

export function isChangeStatus(v: unknown): v is ChangeStatus {
  return typeof v === "string" && (CHANGE_STATUSES as readonly string[]).includes(v);
}

export function isChangeTerminal(s: ChangeStatus): boolean {
  return CHANGE_TERMINAL.has(s);
}

export function canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface ChangeRequestRow {
  id: string;
  projectId: string;
  title: string;
  rationale: string;
  /** 影响面描述(自由文本数组,序列化后存) */
  impactJson: string | null;
  status: ChangeStatus;
  decidedByAgentId: string | null;
  createdAt: number;
  decidedAt: number | null;
}

interface RawChange {
  id: string;
  project_id: string;
  title: string;
  rationale: string;
  impact_json: string | null;
  status: string;
  decided_by_agent_id: string | null;
  created_at: number;
  decided_at: number | null;
}

function rowToChange(raw: RawChange): ChangeRequestRow {
  if (!isChangeStatus(raw.status)) {
    throw new Error(`change_requests 表里出现未定义 status「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    title: raw.title,
    rationale: raw.rationale,
    impactJson: raw.impact_json,
    status: raw.status,
    decidedByAgentId: raw.decided_by_agent_id,
    createdAt: raw.created_at,
    decidedAt: raw.decided_at,
  };
}

// ── change_requests ─────────────────────────────────────────────

export function insertChange(
  db: Database.Database,
  row: Omit<ChangeRequestRow, "decidedByAgentId" | "decidedAt" | "status"> & {
    status?: ChangeStatus;
    decidedByAgentId?: string | null;
    decidedAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO change_requests (id, project_id, title, rationale, impact_json, status,
                                  decided_by_agent_id, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.projectId, row.title, row.rationale, row.impactJson,
    row.status ?? "proposed", row.decidedByAgentId ?? null, row.createdAt,
    row.decidedAt ?? null,
  );
}

export function getChange(db: Database.Database, id: string): ChangeRequestRow | null {
  const raw = db.prepare(`SELECT * FROM change_requests WHERE id = ?`).get(id) as
    | RawChange
    | undefined;
  return raw ? rowToChange(raw) : null;
}

export interface ListChangesFilter {
  status?: ChangeStatus;
  limit?: number;
}

export function listChanges(
  db: Database.Database,
  projectId: string,
  filter: ListChangesFilter = {},
): ChangeRequestRow[] {
  const where = ["project_id = ?"];
  const vals: unknown[] = [projectId];
  if (filter.status !== undefined) { where.push("status = ?"); vals.push(filter.status); }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  vals.push(limit);
  const rows = db
    .prepare(`SELECT * FROM change_requests WHERE ${where.join(" AND ")}
              ORDER BY created_at DESC LIMIT ?`)
    .all(...vals) as RawChange[];
  return rows.map(rowToChange);
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "illegal_transition" | "missing_decider"; from?: ChangeStatus };

/**
 * 推进变更状态。**非法迁移被拒**,不是静默写入。
 *
 * 评审类迁移(`under_review` / `accepted` / `implemented` / `rejected`)必须记
 * 决定人 —— 一个没有决定人的评审结论,在事后追责时等于没人负责。
 */
export function transitionChange(
  db: Database.Database,
  id: string,
  to: ChangeStatus,
  at: number,
  decidedByAgentId?: string,
): TransitionResult {
  const cur = getChange(db, id);
  if (!cur) return { ok: false, reason: "not_found" };
  if (!canTransition(cur.status, to)) {
    return { ok: false, reason: "illegal_transition", from: cur.status };
  }
  const needsDecider = to !== "under_review";
  if (needsDecider && (decidedByAgentId === undefined || decidedByAgentId === "")) {
    return { ok: false, reason: "missing_decider" };
  }
  db.prepare(
    `UPDATE change_requests SET status = ?, decided_by_agent_id = COALESCE(?, decided_by_agent_id),
                                decided_at = CASE WHEN ? = 'under_review' THEN decided_at ELSE ? END
     WHERE id = ?`,
  ).run(to, decidedByAgentId ?? null, to, at, id);
  return { ok: true };
}

export function deleteChange(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM change_requests WHERE id = ?`).run(id);
}

// ── change_affects ──────────────────────────────────────────────

/** 登记「这个变更影响了哪些工作项」(取代不可查的 affected_work_ids_json) */
export function affectWork(db: Database.Database, changeId: string, workId: string): void {
  db.prepare(
    `INSERT INTO change_affects (change_id, work_id) VALUES (?, ?)
     ON CONFLICT(change_id, work_id) DO NOTHING`,
  ).run(changeId, workId);
}

export function unaffectedWork(db: Database.Database, changeId: string, workId: string): void {
  db.prepare(`DELETE FROM change_affects WHERE change_id = ? AND work_id = ?`).run(changeId, workId);
}

/** 这个变更影响了哪些工作项 */
export function listAffectedWorks(db: Database.Database, changeId: string): string[] {
  const rows = db
    .prepare(`SELECT work_id FROM change_affects WHERE change_id = ?`)
    .all(changeId) as Array<{ work_id: string }>;
  return rows.map((r) => r.work_id);
}

/**
 * 这条工作项被哪些变更影响过。
 *
 * 这是「需求变更要体现在 blackboard 上」那条需求的查询入口 ——
 * 也是 JSON 列做不到而关联表能做到的事。
 */
export function changesForWork(db: Database.Database, workId: string): ChangeRequestRow[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM change_requests c
       JOIN change_affects ca ON ca.change_id = c.id
       WHERE ca.work_id = ?
       ORDER BY c.created_at DESC`,
    )
    .all(workId) as RawChange[];
  return rows.map(rowToChange);
}
