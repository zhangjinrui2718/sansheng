/**
 * BC4 ChangeControl · blockers 仓储
 *
 * 阻塞是**跨会话存活的一等实体**(设计 1 §2.2),不是工件的一个 kind ——
 * 它有自己的状态机:
 *
 *   open → acknowledged → resolved | deferred | rejected
 *
 * 为什么不能塞进工件:工件的状态机是 `open → accepted|rejected|superseded`,
 * 表达不了「已承认但还没解决」「决定先搁置」这些中间态。而「哪些阻塞还没解决」
 * 恰好是业务经理对甲方汇报时最需要查的一屏。
 */
import type Database from "better-sqlite3";
import { insertDispatchEvent } from "./dispatch.js";

export type BlockerStatus = "open" | "acknowledged" | "resolved" | "deferred" | "rejected";
export type BlockerSeverity = "low" | "medium" | "high" | "critical";

export const BLOCKER_STATUSES: readonly BlockerStatus[] = [
  "open",
  "acknowledged",
  "resolved",
  "deferred",
  "rejected",
];

export const BLOCKER_SEVERITIES: readonly BlockerSeverity[] = [
  "low",
  "medium",
  "high",
  "critical",
];

/** 「还没解决」的两个状态 —— blocked/unacknowledged 都算挂着 */
const UNRESOLVED: ReadonlySet<BlockerStatus> = new Set<BlockerStatus>(["open", "acknowledged"]);

export function isBlockerStatus(v: unknown): v is BlockerStatus {
  return typeof v === "string" && (BLOCKER_STATUSES as readonly string[]).includes(v);
}

export function isBlockerSeverity(v: unknown): v is BlockerSeverity {
  return typeof v === "string" && (BLOCKER_SEVERITIES as readonly string[]).includes(v);
}

export function isUnresolvedBlocker(s: BlockerStatus): boolean {
  return UNRESOLVED.has(s);
}

export interface BlockerRow {
  id: string;
  projectId: string;
  raisedByAgentId: string;
  title: string;
  detail: string;
  severity: BlockerSeverity;
  status: BlockerStatus;
  createdAt: number;
  resolvedAt: number | null;
  resolution: string | null;
}

interface RawBlocker {
  id: string;
  project_id: string;
  raised_by_agent_id: string;
  title: string;
  detail: string;
  severity: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

function rowToBlocker(raw: RawBlocker): BlockerRow {
  if (!isBlockerSeverity(raw.severity)) {
    throw new Error(`blockers 表里出现未定义 severity「${raw.severity}」(id=${raw.id})`);
  }
  if (!isBlockerStatus(raw.status)) {
    throw new Error(`blockers 表里出现未定义 status「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    raisedByAgentId: raw.raised_by_agent_id,
    title: raw.title,
    detail: raw.detail,
    severity: raw.severity,
    status: raw.status,
    createdAt: raw.created_at,
    resolvedAt: raw.resolved_at,
    resolution: raw.resolution,
  };
}

// ── blockers ────────────────────────────────────────────────────

export function insertBlocker(
  db: Database.Database,
  row: Omit<BlockerRow, "resolvedAt" | "resolution"> & {
    resolvedAt?: number | null;
    resolution?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO blockers (id, project_id, raised_by_agent_id, title, detail, severity,
                           status, created_at, resolved_at, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.projectId, row.raisedByAgentId, row.title, row.detail, row.severity,
    row.status, row.createdAt, row.resolvedAt ?? null, row.resolution ?? null,
  );
  // 新阻塞是一件**该让甲方知道**的下游事件 —— 记进 outbox,于是业务经理的待办
  // 是一条查询,而不是级联在内存里观察到的事件(批次 20 的洞:撞上界就丢)。
  insertDispatchEvent(db, {
    projectId: row.projectId,
    kind: "blocker_opened",
    subjectId: row.id,
    summary: `${row.title}[${row.severity}]`,
    createdAt: row.createdAt,
  });
}

export function getBlocker(db: Database.Database, id: string): BlockerRow | null {
  const raw = db.prepare(`SELECT * FROM blockers WHERE id = ?`).get(id) as RawBlocker | undefined;
  return raw ? rowToBlocker(raw) : null;
}

export interface ListBlockersFilter {
  status?: BlockerStatus;
  severity?: BlockerSeverity;
  /** true = 只要未解决的(open | acknowledged) */
  unresolvedOnly?: boolean;
  raisedByAgentId?: string;
  limit?: number;
}

export function listBlockers(
  db: Database.Database,
  projectId: string,
  filter: ListBlockersFilter = {},
): BlockerRow[] {
  const where = ["project_id = ?"];
  const vals: unknown[] = [projectId];
  if (filter.status !== undefined) { where.push("status = ?"); vals.push(filter.status); }
  if (filter.severity !== undefined) { where.push("severity = ?"); vals.push(filter.severity); }
  if (filter.unresolvedOnly === true) where.push("status IN ('open', 'acknowledged')");
  if (filter.raisedByAgentId !== undefined) {
    where.push("raised_by_agent_id = ?");
    vals.push(filter.raisedByAgentId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  vals.push(limit);
  // severity 排序:critical 最高。用 CASE 而不是字典序(critical < high 是错的)
  const rows = db
    .prepare(
      `SELECT * FROM blockers WHERE ${where.join(" AND ")}
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                              WHEN 'medium' THEN 2 ELSE 3 END,
                created_at DESC
       LIMIT ?`,
    )
    .all(...vals) as RawBlocker[];
  return rows.map(rowToBlocker);
}

/**
 * 改状态。落终态时**必须带 resolution** —— 一个「已解决」但没说怎么解决的
 * 阻塞,在事后复盘时等于没记录(7-N 教训:失败必须留现场)。
 */
export function setBlockerStatus(
  db: Database.Database,
  id: string,
  status: BlockerStatus,
  at: number,
  resolution?: string,
): void {
  const terminal = status === "resolved" || status === "rejected" || status === "deferred";
  if (terminal && (resolution === undefined || resolution.trim() === "")) {
    throw new Error(`阻塞 ${id} 转入终态「${status}」必须给 resolution — 否则事后看不出当时怎么处理的`);
  }
  if (terminal) {
    db.prepare(`UPDATE blockers SET status = ?, resolved_at = ?, resolution = ? WHERE id = ?`).run(
      status, at, resolution, id,
    );
  } else {
    db.prepare(`UPDATE blockers SET status = ?, resolved_at = NULL, resolution = NULL WHERE id = ?`).run(
      status, id,
    );
  }
}

export function deleteBlocker(db: Database.Database, id: string): void {
  db.prepare(`DELETE FROM blockers WHERE id = ?`).run(id);
}

// ── blocker_blocks ──────────────────────────────────────────────

/** 登记「这个阻塞挡住了哪些工作项」。设计 1 §8.1 原本没有这张表的位置。 */
export function blockWork(db: Database.Database, blockerId: string, workId: string): void {
  db.prepare(
    `INSERT INTO blocker_blocks (blocker_id, work_id) VALUES (?, ?)
     ON CONFLICT(blocker_id, work_id) DO NOTHING`,
  ).run(blockerId, workId);
}

export function unblockWork(db: Database.Database, blockerId: string, workId: string): void {
  db.prepare(`DELETE FROM blocker_blocks WHERE blocker_id = ? AND work_id = ?`).run(blockerId, workId);
}

/** 这个阻塞挡住了谁 */
export function listBlockedWorks(db: Database.Database, blockerId: string): string[] {
  const rows = db
    .prepare(`SELECT work_id FROM blocker_blocks WHERE blocker_id = ?`)
    .all(blockerId) as Array<{ work_id: string }>;
  return rows.map((r) => r.work_id);
}

/**
 * 这条工作项被哪些**未解决**的阻塞挡着。
 *
 * 这是「未解决阻塞反馈给用户」那条需求的查询入口 —— 也是为什么
 * `blocksWorkIds[]` 必须有地方存:没有它,就只能说「项目有 3 个阻塞」,
 * 说不出「哪一个卡住了哪件事」。
 */
export function blockersForWork(db: Database.Database, workId: string): BlockerRow[] {
  const rows = db
    .prepare(
      `SELECT b.* FROM blockers b
       JOIN blocker_blocks bb ON bb.blocker_id = b.id
       WHERE bb.work_id = ? AND b.status IN ('open', 'acknowledged')
       ORDER BY b.created_at DESC`,
    )
    .all(workId) as RawBlocker[];
  return rows.map(rowToBlocker);
}
