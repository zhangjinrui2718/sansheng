/**
 * 经验库(`agent_notes`,migration 040)· 仓储 —— 一个角色**自己的**条目
 *
 * ── 它是什么 / 不是什么 ───────────────────────────────────────────
 *
 * 三套东西别并(与 010 / 028 文件头同一条判据):
 *
 *   记忆    关于**用户**,业务经理写,会淡忘;
 *   知识语料 关于**项目**,平台索引,角色只读,只存偏移;
 *   经验库  关于**这个角色自己的手艺**,角色自己写,跨项目 —— **直接存正文**。
 *
 * ── 隔离是这里的硬边界 ──────────────────────────────────────────
 *
 * 每个读函数都**必传** `agentId`:一个角色只检索得到自己的条目。人读面(成员页)
 * 也按角色看 —— 没有任何「列出所有人的经验」的口子(跨角色通道刻意不开:
 * 调研条目里的外部内容会跟着走,那是 prompt injection 的传播路径)。
 *
 * ── 检索 ───────────────────────────────────────────────────────
 *
 * `seg` 列存 bigram 分词(`shared/text.ts` 的 `indexTerms`,与 028 同一套切法),
 * FTS5 外部内容表 + 三个触发器由迁移维护。查询串**必须**先用
 * `knowledge/query.ts` 的 `buildMatchQuery()` 翻译 —— 不要在这里拼字符串。
 * 只有 `active` 的条目进检索结果;退休的条目读得到、改得活,但不再冒出来。
 */
import type Database from "better-sqlite3";
import { indexTerms } from "../../../shared/text.js";

/** 条目类型。闭集在 TS(不建 CHECK,与 039 同一条先例)。 */
export const AGENT_NOTE_KINDS = ["lesson", "research"] as const;
export type AgentNoteKind = (typeof AGENT_NOTE_KINDS)[number];

export function isAgentNoteKind(v: unknown): v is AgentNoteKind {
  return typeof v === "string" && (AGENT_NOTE_KINDS as readonly string[]).includes(v);
}

/** 在用 / 已退休。 */
export const AGENT_NOTE_STATUSES = ["active", "retired"] as const;
export type AgentNoteStatus = (typeof AGENT_NOTE_STATUSES)[number];

export interface AgentNoteRow {
  readonly noteRowid: number;
  readonly id: string;
  readonly agentId: string;
  readonly kind: AgentNoteKind;
  readonly title: string;
  readonly content: string;
  /** 出处。`research` 类在工具层强制非空;仓储层不替它判(见 `tools/experience.ts`)。 */
  readonly source: string | null;
  readonly sourceProjectId: string | null;
  readonly seg: string;
  readonly status: AgentNoteStatus;
  readonly retireReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type RawNote = {
  note_rowid: number;
  id: string;
  agent_id: string;
  kind: string;
  title: string;
  content: string;
  source: string | null;
  source_project_id: string | null;
  seg: string;
  status: string;
  retire_reason: string | null;
  created_at: number;
  updated_at: number;
};

/** 一条条目的可改部分(新建与改写共用一个形状)。 */
export interface AgentNoteInput {
  readonly kind: AgentNoteKind;
  readonly title: string;
  readonly content: string;
  readonly source: string | null;
  readonly sourceProjectId: string | null;
}

/**
 * 行 → 类型化对象。
 *
 * ⚠️ `kind` / `status` 是闭集,**读到闭集之外的值就抛** —— 不静默归到某一类。
 * 归类 = 把一行坏数据说成一个看起来正常的答案(AGENTS.md「三类静默失败」)。
 * 闭集在 TS、不在 CHECK 里,代价就是这条:读侧必须自己守。
 */
function rowToNote(raw: RawNote): AgentNoteRow {
  if (!isAgentNoteKind(raw.kind)) {
    throw new Error(`agent_notes.${raw.id}:kind「${raw.kind}」不在闭集里`);
  }
  if (raw.status !== "active" && raw.status !== "retired") {
    throw new Error(`agent_notes.${raw.id}:status「${raw.status}」不在闭集里`);
  }
  return {
    noteRowid: raw.note_rowid,
    id: raw.id,
    agentId: raw.agent_id,
    kind: raw.kind,
    title: raw.title,
    content: raw.content,
    source: raw.source,
    sourceProjectId: raw.source_project_id,
    seg: raw.seg,
    status: raw.status,
    retireReason: raw.retire_reason,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

const COLS =
  "note_rowid, id, agent_id, kind, title, content, source, source_project_id, seg, status, retire_reason, created_at, updated_at";

export function insertAgentNote(
  db: Database.Database,
  args: { readonly id: string; readonly agentId: string; readonly note: AgentNoteInput; readonly now: number },
): AgentNoteRow {
  const n = args.note;
  db.prepare(
    `INSERT INTO agent_notes (id, agent_id, kind, title, content, source, source_project_id, seg, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    args.id, args.agentId, n.kind, n.title, n.content, n.source, n.sourceProjectId,
    indexTerms(`${n.title}\n${n.content}`), args.now, args.now,
  );
  return getAgentNote(db, args.id) as AgentNoteRow;
}

/**
 * 改写一条(整体替换可改字段)。
 *
 * 改写会把退休的条目**救活**(`status` 回到 `active`、清掉退休原因):模型拿着一条
 * 过时的经验改对了,它就该重新被检索到。
 *
 * @returns `false` = 没有这条。**调用方要把它翻成 `not_found`,不许当成功。**
 */
export function updateAgentNote(
  db: Database.Database,
  id: string,
  note: AgentNoteInput,
  now: number,
): boolean {
  const r = db
    .prepare(
      `UPDATE agent_notes
          SET kind = ?, title = ?, content = ?, source = ?, source_project_id = ?,
              seg = ?, status = 'active', retire_reason = NULL, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      note.kind, note.title, note.content, note.source, note.sourceProjectId,
      indexTerms(`${note.title}\n${note.content}`), now, id,
    );
  return r.changes > 0;
}

/**
 * 退休一条。只有 `active` 的能退休(重复退休不算成功 —— `false`)。
 *
 * @returns `false` = 没有这条,或它已经退休。
 */
export function retireAgentNote(
  db: Database.Database,
  id: string,
  reason: string,
  now: number,
): boolean {
  const r = db
    .prepare(
      `UPDATE agent_notes SET status = 'retired', retire_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'active'`,
    )
    .run(reason, now, id);
  return r.changes > 0;
}

/** 删一条(人读面的「删除」;模型没有删的口子 —— 它只能退休)。 */
export function deleteAgentNote(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM agent_notes WHERE id = ?`).run(id).changes > 0;
}

export function getAgentNote(db: Database.Database, id: string): AgentNoteRow | null {
  const raw = db.prepare(`SELECT ${COLS} FROM agent_notes WHERE id = ?`).get(id) as RawNote | undefined;
  return raw === undefined ? null : rowToNote(raw);
}

/** 在用条数(工具面的上限判据用它)。 */
export function countActiveAgentNotes(db: Database.Database, agentId: string): number {
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM agent_notes WHERE agent_id = ? AND status = 'active'`)
    .get(agentId) as { n: number };
  return r.n;
}

/** 在用条数,按类型分。`lesson` / `research` 两个键恒在(0 就写 0)。 */
export function countAgentNotesByKind(
  db: Database.Database,
  agentId: string,
): Readonly<Record<AgentNoteKind, number>> {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM agent_notes
        WHERE agent_id = ? AND status = 'active' GROUP BY kind`,
    )
    .all(agentId) as Array<{ kind: string; n: number }>;
  const out: Record<AgentNoteKind, number> = { lesson: 0, research: 0 };
  for (const r of rows) {
    // ⚠️ 闭集之外的 kind 不归到任何一类(把它算进某一类 = 把坏数据说成正常答案):抛。
    if (!isAgentNoteKind(r.kind)) throw new Error(`agent_notes:kind「${r.kind}」不在闭集里`);
    out[r.kind] = r.n;
  }
  return out;
}

export interface AgentNoteHit {
  readonly note: AgentNoteRow;
  /** FTS5 的 bm25 分数:**越小越相关**。 */
  readonly score: number;
}

/**
 * 全文检索**某一个人的**在用条目,按相关度排。
 *
 * `agentId` 必传 —— 没有它这个函数就没有意义(见文件头「隔离」)。
 */
export function searchAgentNotes(
  db: Database.Database,
  matchQuery: string,
  opts: { readonly agentId: string; readonly limit?: number; readonly kind?: AgentNoteKind },
): AgentNoteHit[] {
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 20);
  const kindFilter = opts.kind !== undefined ? ` AND n.kind = ?` : "";
  const vals: unknown[] = [matchQuery, opts.agentId];
  if (opts.kind !== undefined) vals.push(opts.kind);
  vals.push(limit);
  const rows = db
    .prepare(
      `SELECT ${COLS.split(", ").map((c) => `n.${c}`).join(", ")}, bm25(agent_notes_fts) AS score
         FROM agent_notes_fts
         JOIN agent_notes n ON n.note_rowid = agent_notes_fts.rowid
        WHERE agent_notes_fts MATCH ? AND n.agent_id = ? AND n.status = 'active'${kindFilter}
        ORDER BY score ASC
        LIMIT ?`,
    )
    .all(...vals) as Array<RawNote & { score: number }>;
  return rows.map((r) => ({ note: rowToNote(r), score: r.score }));
}

/**
 * 按时间倒序列出某一个人的条目(人读面「最近条目」)。
 *
 * `q` 给了就按检索走(仍按相关度),没给就按 `updated_at` 倒序。**检索词太短
 * (切不出词)由调用方先判** —— 这里收到空的 `matchQuery` 会是一次 `fts5: syntax error`。
 */
export function listAgentNotes(
  db: Database.Database,
  opts: {
    readonly agentId: string;
    readonly limit?: number;
    readonly matchQuery?: string;
    /** 缺省只列在用的;显式传 `'all'` 才连退休的一起列(检索永远只认在用的)。 */
    readonly status?: AgentNoteStatus | "all";
  },
): AgentNoteRow[] {
  if (opts.matchQuery !== undefined) {
    return searchAgentNotes(db, opts.matchQuery, { agentId: opts.agentId, limit: opts.limit }).map((h) => h.note);
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  // 缺省 = 只列在用的(`'all'` 是人读面显式要才给)
  const status: AgentNoteStatus | "all" = opts.status ?? "active";
  const statusFilter = status === "all" ? "" : ` AND status = ?`;
  const vals: unknown[] = [opts.agentId];
  if (statusFilter !== "") vals.push(status);
  vals.push(limit);
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM agent_notes
        WHERE agent_id = ?${statusFilter}
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...vals) as RawNote[];
  return rows.map(rowToNote);
}
