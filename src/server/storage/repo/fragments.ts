import type Database from "better-sqlite3";

export interface FragmentRow {
  id: string;
  kind: "fact" | "preference" | "project" | "context" | "summary";
  content: string;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  importance: number;
  decayFactor: number;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  metadata: string | null;
}

export interface FragmentSearchOpts {
  /** 已有 embedding 时走向量检索;否则 fallback 到 importance 排序 */
  embedding?: number[] | null;
  limit?: number;
}

let vecAvailable: boolean | null = null;

export function isVecAvailable(db: Database.Database): boolean {
  if (vecAvailable !== null) return vecAvailable;
  try {
    db.prepare(`SELECT COUNT(*) FROM fragments_vec LIMIT 1`).get();
    vecAvailable = true;
  } catch {
    vecAvailable = false;
  }
  return vecAvailable;
}

export function insertFragment(db: Database.Database, f: FragmentRow): void {
  db.prepare(
    `INSERT INTO fragments
       (id, kind, content, source_conversation_id, source_message_id, importance, decay_factor, access_count, last_accessed_at, created_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       importance = excluded.importance,
       last_accessed_at = excluded.last_accessed_at`,
  ).run(
    f.id,
    f.kind,
    f.content,
    f.sourceConversationId,
    f.sourceMessageId,
    f.importance,
    f.decayFactor,
    f.accessCount,
    f.lastAccessedAt,
    f.createdAt,
    f.metadata,
  );
}

export function upsertFragmentEmbedding(db: Database.Database, fragmentId: string, embedding: number[]): void {
  if (!isVecAvailable(db)) return;
  // vec0 是 KNN-distance 表;先删后插(没有真正的 upsert)
  db.prepare(`DELETE FROM fragments_vec WHERE fragment_id = ?`).run(fragmentId);
  // FLOAT[1536] 是固定维度,所以拼成 [a,b,c,...] 字符串
  const vecStr = `[${embedding.join(",")}]`;
  db.prepare(`INSERT INTO fragments_vec (fragment_id, embedding) VALUES (?, ?)`).run(fragmentId, vecStr);
}

export function getFragment(db: Database.Database, id: string): FragmentRow | null {
  const r = db.prepare(`SELECT * FROM fragments WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToFragment(r) : null;
}

export function listFragmentsByKind(
  db: Database.Database,
  kind: FragmentRow["kind"],
  limit: number,
): FragmentRow[] {
  const rows = db
    .prepare(`SELECT * FROM fragments WHERE kind = ? ORDER BY importance DESC, created_at DESC LIMIT ?`)
    .all(kind, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToFragment);
}

export function searchFragments(db: Database.Database, opts: FragmentSearchOpts): FragmentRow[] {
  const limit = opts.limit ?? 10;
  // 向量检索路径
  if (opts.embedding && isVecAvailable(db)) {
    const vecStr = `[${opts.embedding.join(",")}]`;
    const rows = db
      .prepare(
        `SELECT f.*, v.distance
         FROM fragments_vec v
         JOIN fragments f ON f.id = v.fragment_id
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance ASC`,
      )
      .all(vecStr, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToFragment);
  }
  // Fallback: 按 importance * (1 + access_count) 排序
  const rows = db
    .prepare(
      `SELECT * FROM fragments ORDER BY (importance * (1 + access_count)) DESC, last_accessed_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToFragment);
}

export function recordFragmentAccess(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE fragments SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
  ).run(Date.now(), id);
}

function rowToFragment(r: Record<string, unknown>): FragmentRow {
  return {
    id: r.id as string,
    kind: r.kind as FragmentRow["kind"],
    content: r.content as string,
    sourceConversationId: (r.source_conversation_id as string | null) ?? null,
    sourceMessageId: (r.source_message_id as string | null) ?? null,
    importance: r.importance as number,
    decayFactor: r.decay_factor as number,
    accessCount: r.access_count as number,
    lastAccessedAt: (r.last_accessed_at as number | null) ?? null,
    createdAt: r.created_at as number,
    metadata: (r.metadata as string | null) ?? null,
  };
}