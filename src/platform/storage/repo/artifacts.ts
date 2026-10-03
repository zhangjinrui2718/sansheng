/**
 * BC3 Blackboard · artifacts / artifact_links 仓储
 *
 * ── 这个仓储不做权限判定 ──────────────────────────────────────────
 *
 * `blackboard.write` 能写哪些 kind 由 `ROLE_SPECS[role].writeKinds` 决定,
 * 判定发生在 `harness/authorize.ts` 的 `WriteKindGate`(调用期第三道门)。
 * 仓储层只负责「schema 允许的 kind」与「数据完整性」。
 *
 * 这个分工是有意的:权限是**角色相关**的,仓储不该知道调用者是谁。把两者
 * 混在一起会让「换个调用方就得改仓储」,也再没有单一位置能回答
 * 「这个角色到底能写什么」。
 */
import type Database from "better-sqlite3";
import {
  ARTIFACT_KINDS,
  isArtifactKind,
  type ArtifactKind,
} from "../../identity/role.js";

/** 工件状态机(设计 1 §6.3)。 */
export type ArtifactStatus = "open" | "accepted" | "rejected" | "superseded";

export const ARTIFACT_STATUSES: readonly ArtifactStatus[] = [
  "open",
  "accepted",
  "rejected",
  "superseded",
];

export function isArtifactStatus(v: unknown): v is ArtifactStatus {
  return typeof v === "string" && (ARTIFACT_STATUSES as readonly string[]).includes(v);
}

/** 工件间关系类型 */
export type ArtifactLinkRel = "parent" | "depends_on" | "answers";

export const ARTIFACT_LINK_RELS: readonly ArtifactLinkRel[] = [
  "parent",
  "depends_on",
  "answers",
];

export function isArtifactLinkRel(v: unknown): v is ArtifactLinkRel {
  return typeof v === "string" && (ARTIFACT_LINK_RELS as readonly string[]).includes(v);
}

export interface ArtifactRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  kind: ArtifactKind;
  status: ArtifactStatus;
  authorAgentId: string;
  title: string;
  body: string;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawArtifact {
  id: string;
  project_id: string;
  conversation_id: string | null;
  kind: string;
  status: string;
  author_agent_id: string;
  title: string;
  body: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

/** 行 → 领域对象。边界处校验闭合集,不让未定义的 kind/status 冒充类型。 */
function rowToArtifact(raw: RawArtifact): ArtifactRow {
  if (!isArtifactKind(raw.kind)) {
    throw new Error(`artifacts 表里出现未定义 kind「${raw.kind}」(id=${raw.id})`);
  }
  if (!isArtifactStatus(raw.status)) {
    throw new Error(`artifacts 表里出现未定义 status「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    conversationId: raw.conversation_id,
    kind: raw.kind,
    status: raw.status,
    authorAgentId: raw.author_agent_id,
    title: raw.title,
    body: raw.body,
    metadataJson: raw.metadata_json,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

// ── artifacts ───────────────────────────────────────────────────

export function insertArtifact(db: Database.Database, row: ArtifactRow): void {
  db.prepare(
    `INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                            title, body, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.projectId, row.conversationId, row.kind, row.status, row.authorAgentId,
    row.title, row.body, row.metadataJson, row.createdAt, row.updatedAt,
  );
}

export function getArtifact(db: Database.Database, id: string): ArtifactRow | null {
  const raw = db.prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as
    | RawArtifact
    | undefined;
  return raw ? rowToArtifact(raw) : null;
}

export interface ListArtifactsFilter {
  kind?: ArtifactKind;
  status?: ArtifactStatus;
  authorAgentId?: string;
  /** 只要某条工件的子件(rel='parent') */
  parentOf?: string;
  limit?: number;
}

/**
 * 列工件。**作用域是 projectId,不是 conversationId** ——
 * 这是本次升级最关键的一处签名变更(设计 1 §3.2):对话活不过项目。
 */
export function listArtifacts(
  db: Database.Database,
  projectId: string,
  filter: ListArtifactsFilter = {},
): ArtifactRow[] {
  const where = ["a.project_id = ?"];
  const vals: unknown[] = [projectId];
  if (filter.kind !== undefined) { where.push("a.kind = ?"); vals.push(filter.kind); }
  if (filter.status !== undefined) { where.push("a.status = ?"); vals.push(filter.status); }
  if (filter.authorAgentId !== undefined) {
    where.push("a.author_agent_id = ?");
    vals.push(filter.authorAgentId);
  }
  if (filter.parentOf !== undefined) {
    where.push(
      `a.id IN (SELECT artifact_id FROM artifact_links WHERE rel = 'parent' AND target_artifact_id = ?)`,
    );
    vals.push(filter.parentOf);
  }
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  vals.push(limit);
  const rows = db
    .prepare(
      `SELECT a.* FROM artifacts a WHERE ${where.join(" AND ")}
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(...vals) as RawArtifact[];
  return rows.map(rowToArtifact);
}

/** 改状态。终态之间的互转由调用方负责语义(仓储只管闭集与幂等)。 */
export function setArtifactStatus(
  db: Database.Database,
  id: string,
  status: ArtifactStatus,
  at: number,
): void {
  db.prepare(`UPDATE artifacts SET status = ?, updated_at = ? WHERE id = ?`).run(status, at, id);
}

export function updateArtifactBody(
  db: Database.Database,
  id: string,
  body: string,
  at: number,
): void {
  db.prepare(`UPDATE artifacts SET body = ?, updated_at = ? WHERE id = ?`).run(body, at, id);
}

/** 按 kind 计数 —— 「未解决阻塞/待审意见有多少」这类汇总读法。 */
export function countArtifactsByKind(db: Database.Database, projectId: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM artifacts WHERE project_id = ? GROUP BY kind`)
    .all(projectId) as Array<{ kind: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

// ── artifact_links ──────────────────────────────────────────────

export type AddLinkResult = { ok: true } | { ok: false; reason: "self" | "duplicate" | "not_found" };

export function addArtifactLink(
  db: Database.Database,
  artifactId: string,
  rel: ArtifactLinkRel,
  targetArtifactId: string,
): AddLinkResult {
  if (artifactId === targetArtifactId) return { ok: false, reason: "self" };
  if (getArtifact(db, artifactId) === null || getArtifact(db, targetArtifactId) === null) {
    return { ok: false, reason: "not_found" };
  }
  const exists = db
    .prepare(
      `SELECT 1 FROM artifact_links WHERE artifact_id = ? AND rel = ? AND target_artifact_id = ?`,
    )
    .get(artifactId, rel, targetArtifactId);
  if (exists) return { ok: false, reason: "duplicate" };
  db.prepare(
    `INSERT INTO artifact_links (artifact_id, rel, target_artifact_id) VALUES (?, ?, ?)`,
  ).run(artifactId, rel, targetArtifactId);
  return { ok: true };
}

export function removeArtifactLink(
  db: Database.Database,
  artifactId: string,
  rel: ArtifactLinkRel,
  targetArtifactId: string,
): void {
  db.prepare(
    `DELETE FROM artifact_links WHERE artifact_id = ? AND rel = ? AND target_artifact_id = ?`,
  ).run(artifactId, rel, targetArtifactId);
}

/** 出边:这条工件指向谁 */
export function listLinks(
  db: Database.Database,
  artifactId: string,
  rel?: ArtifactLinkRel,
): string[] {
  const rows = (
    rel === undefined
      ? db.prepare(`SELECT target_artifact_id AS t FROM artifact_links WHERE artifact_id = ?`).all(artifactId)
      : db
          .prepare(`SELECT target_artifact_id AS t FROM artifact_links WHERE artifact_id = ? AND rel = ?`)
          .all(artifactId, rel)
  ) as Array<{ t: string }>;
  return rows.map((r) => r.t);
}

/** 入边:谁指向这条工件(例如「哪些 decision 回答了这个提问」) */
export function listBackLinks(
  db: Database.Database,
  artifactId: string,
  rel?: ArtifactLinkRel,
): string[] {
  const rows = (
    rel === undefined
      ? db.prepare(`SELECT artifact_id AS a FROM artifact_links WHERE target_artifact_id = ?`).all(artifactId)
      : db
          .prepare(`SELECT artifact_id AS a FROM artifact_links WHERE target_artifact_id = ? AND rel = ?`)
          .all(artifactId, rel)
  ) as Array<{ a: string }>;
  return rows.map((r) => r.a);
}

/** 全部合法 kind(供 WriteKindGate 回灌给模型用,与 ROLE_SPECS 同源) */
export const ALL_ARTIFACT_KINDS: readonly ArtifactKind[] = ARTIFACT_KINDS;
