/**
 * 知识语料(knowledge_chunks)· 仓储
 *
 * ── 这是语料的**唯一写口** ────────────────────────────────────────
 *
 * 设计 `docs/DESIGN-KNOWLEDGE.md`:语料由**平台**写,agent 只读(不给任何写工具)。
 * 所以 `knowledge_chunks` 的 INSERT / UPDATE / DELETE 只出现在本文件里 ——
 * 与 `repo/works.ts` 的 `updateWorkStatus` 同一条"唯一写口"纪律。
 * 抽查方式:`grep -rn "INSERT INTO knowledge_chunks" src/` 只应命中这里。
 *
 * ── 索引与正文分开 ───────────────────────────────────────────────
 *
 * 这里**不存正文**:每条只存来源坐标 + 原文里的字符区间 + 该块文本的哈希 +
 * 检索用的 bigram 列。正文现读(工件在项目仓、消息在 `session_messages`)——
 * 抄一份正文会得到两份会漂的真相,而工件那边已经为这件事做了三态。
 *
 * `seg` 列由调用方用 `shared/text.ts` 的 `indexTerms()` 生成;
 * **索引侧与查询侧必须同一套切法**,否则中文静默漏召回(见那个文件的文件头)。
 */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

/** 来源闭集。P1 只有这两类(`work` / `project` 是 P2,见设计 §8)。 */
export type KnowledgeSourceKind = "artifact" | "message";

export const KNOWLEDGE_SOURCE_KINDS: readonly KnowledgeSourceKind[] = ["artifact", "message"];

export function isKnowledgeSourceKind(v: unknown): v is KnowledgeSourceKind {
  return typeof v === "string" && (KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(v);
}

/** 块文本的哈希。它是"同一来源重扫时这块变没变"的唯一判据(幂等的另一半是 seq)。 */
export function chunkSha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface KnowledgeChunkRow {
  readonly rowid: number;
  readonly id: string;
  readonly sourceKind: KnowledgeSourceKind;
  readonly sourceId: string;
  readonly projectId: string | null;
  readonly artifactId: string | null;
  readonly messageId: string | null;
  readonly workId: string | null;
  readonly seq: number;
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RawChunk {
  chunk_rowid: number;
  id: string;
  source_kind: string;
  source_id: string;
  project_id: string | null;
  artifact_id: string | null;
  message_id: string | null;
  work_id: string | null;
  seq: number;
  offset: number;
  length: number;
  sha256: string;
  created_at: number;
  updated_at: number;
}

function rowToChunk(raw: RawChunk): KnowledgeChunkRow {
  // 与 `memory/sqliteMemory.ts` 的 rowToFragment 同款:表里出现闭集外的值 ⇒ 响亮抛错,
  // 不静默当成某一类。静默归类会让"来源"这件事在读面撒谎。
  if (!isKnowledgeSourceKind(raw.source_kind)) {
    throw new Error(`knowledge_chunks 表里出现未定义 source_kind「${raw.source_kind}」(id=${raw.id})`);
  }
  return {
    rowid: raw.chunk_rowid,
    id: raw.id,
    sourceKind: raw.source_kind,
    sourceId: raw.source_id,
    projectId: raw.project_id,
    artifactId: raw.artifact_id,
    messageId: raw.message_id,
    workId: raw.work_id,
    seq: raw.seq,
    offset: raw.offset,
    length: raw.length,
    sha256: raw.sha256,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

/** `source_kind:source_id` —— 列表/集合里比较"这条来源还在不在"用的键。 */
export function sourceKey(kind: KnowledgeSourceKind, id: string): string {
  return `${kind}:${id}`;
}

export interface KnowledgeChunkInput {
  readonly seq: number;
  readonly offset: number;
  readonly length: number;
  readonly text: string;
}

export interface ReplaceSourceSpec {
  readonly sourceKind: KnowledgeSourceKind;
  readonly sourceId: string;
  readonly projectId: string | null;
  readonly artifactId?: string | null;
  readonly messageId?: string | null;
  readonly workId?: string | null;
  readonly chunks: readonly KnowledgeChunkInput[];
  /** id 生成注入(与平台其它仓储同款:可复现的测试要能注入) */
  readonly newId: (prefix: string) => string;
  readonly now: number;
  /** 检索用的分词列;**必须**由 `shared/text.ts` 的 `indexTerms()` 生成 */
  readonly segOf: (text: string) => string;
}

export interface ReplaceResult {
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly deleted: number;
}

/**
 * 用一个来源的**当前**块集合替换它已有的块集合。**幂等**:
 * 同一份输入跑两次 ⇒ 第二次全是 `unchanged`(哈希相同就不动 FTS 索引)。
 *
 * 块数变少(正文被改短)时按 `seq >= chunks.length` 删掉多余的行 ——
 * 留下幽灵块等于"检索得到一个正文里不存在的片段",那是最坏的一种错(不是空,是错)。
 */
export function replaceSourceChunks(db: Database.Database, spec: ReplaceSourceSpec): ReplaceResult {
  const existing = db
    .prepare(`SELECT chunk_rowid, seq, sha256 FROM knowledge_chunks WHERE source_kind = ? AND source_id = ?`)
    .all(spec.sourceKind, spec.sourceId) as Array<{ chunk_rowid: number; seq: number; sha256: string }>;
  const bySeq = new Map(existing.map((r) => [r.seq, r]));

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let deleted = 0;

  const insert = db.prepare(
    `INSERT INTO knowledge_chunks
       (id, source_kind, source_id, project_id, artifact_id, message_id, work_id,
        seq, offset, length, sha256, seg, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE knowledge_chunks
        SET project_id = ?, artifact_id = ?, message_id = ?, work_id = ?,
            offset = ?, length = ?, sha256 = ?, seg = ?, updated_at = ?
      WHERE chunk_rowid = ?`,
  );
  const remove = db.prepare(`DELETE FROM knowledge_chunks WHERE chunk_rowid = ?`);

  db.transaction(() => {
    for (const c of spec.chunks) {
      const sha = chunkSha(c.text);
      const prev = bySeq.get(c.seq);
      if (prev === undefined) {
        insert.run(
          spec.newId("chk"), spec.sourceKind, spec.sourceId, spec.projectId,
          spec.artifactId ?? null, spec.messageId ?? null, spec.workId ?? null,
          c.seq, c.offset, c.length, sha, spec.segOf(c.text), spec.now, spec.now,
        );
        inserted++;
        continue;
      }
      if (prev.sha256 === sha) { unchanged++; continue; }
      update.run(
        spec.projectId, spec.artifactId ?? null, spec.messageId ?? null, spec.workId ?? null,
        c.offset, c.length, sha, spec.segOf(c.text), spec.now, prev.chunk_rowid,
      );
      updated++;
    }

    for (const r of existing) {
      if (r.seq < spec.chunks.length) continue;
      remove.run(r.chunk_rowid);
      deleted++;
    }
  })();

  return { inserted, updated, unchanged, deleted };
}

/** 该项目下所有的来源键(`source_kind:source_id`)。索引器用它做 prune 的差集。 */
export function listProjectSourceKeys(db: Database.Database, projectId: string): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT source_kind, source_id FROM knowledge_chunks WHERE project_id = ?`)
    .all(projectId) as Array<{ source_kind: string; source_id: string }>;
  return rows.map((r) =>
    isKnowledgeSourceKind(r.source_kind) ? sourceKey(r.source_kind, r.source_id) : `${r.source_kind}:${r.source_id}`,
  );
}

/**
 * 删掉"来源已经不在"的块(工件被删、消息被清、项目被 reset)。
 * 返回删除条数 —— 调用方要把它记进索引报告里,不许静默。
 */
export function pruneProjectKnowledge(
  db: Database.Database,
  projectId: string,
  seenSourceKeys: ReadonlySet<string>,
): number {
  const rows = db
    .prepare(`SELECT chunk_rowid, source_kind, source_id FROM knowledge_chunks WHERE project_id = ?`)
    .all(projectId) as Array<{ chunk_rowid: number; source_kind: string; source_id: string }>;
  const remove = db.prepare(`DELETE FROM knowledge_chunks WHERE chunk_rowid = ?`);
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (seenSourceKeys.has(`${r.source_kind}:${r.source_id}`)) continue;
      remove.run(r.chunk_rowid);
      n++;
    }
  })();
  return n;
}

export function deleteProjectKnowledge(db: Database.Database, projectId: string): number {
  return db.prepare(`DELETE FROM knowledge_chunks WHERE project_id = ?`).run(projectId).changes;
}

export function getKnowledgeChunk(db: Database.Database, id: string): KnowledgeChunkRow | null {
  const raw = db.prepare(`SELECT * FROM knowledge_chunks WHERE id = ?`).get(id) as RawChunk | undefined;
  return raw === undefined ? null : rowToChunk(raw);
}

export interface KnowledgeHit {
  readonly chunk: KnowledgeChunkRow;
  /** FTS5 的 bm25 分数:**越小越相关**(ORDER BY score ASC) */
  readonly score: number;
}

/**
 * 全文检索。`matchQuery` **必须**是 FTS5 的 MATCH 表达式 ——
 * 由 `knowledge/query.ts` 的 `buildMatchQuery()` 用同一套分词生成,
 * 不要在这里拼字符串(拼错一个引号就是一次 `fts5: syntax error`,而它对模型
 * 只表现为"检索坏了")。
 */
export function searchKnowledgeChunks(
  db: Database.Database,
  matchQuery: string,
  opts: { readonly limit?: number; readonly kind?: KnowledgeSourceKind } = {},
): KnowledgeHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  const kindFilter = opts.kind !== undefined ? ` AND c.source_kind = ?` : "";
  const vals: unknown[] = [matchQuery];
  if (opts.kind !== undefined) vals.push(opts.kind);
  vals.push(limit);

  const rows = db
    .prepare(
      `SELECT c.*, bm25(knowledge_fts) AS score
         FROM knowledge_fts
         JOIN knowledge_chunks c ON c.chunk_rowid = knowledge_fts.rowid
        WHERE knowledge_fts MATCH ?${kindFilter}
        ORDER BY score ASC
        LIMIT ?`,
    )
    .all(...vals) as Array<RawChunk & { score: number }>;

  return rows.map((r) => ({ chunk: rowToChunk(r), score: r.score }));
}

/** 语料条数(诊断与测试用)。 */
export function countKnowledgeChunks(db: Database.Database): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks`).get() as { n: number };
  return r.n;
}

/** 某个项目的语料条数(索引报告用)。 */
export function countProjectKnowledge(db: Database.Database, projectId: string): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks WHERE project_id = ?`)
    .get(projectId) as { n: number };
  return r.n;
}
