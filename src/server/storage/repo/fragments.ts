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

/** Closed-set of fragment kinds — single source of truth for validation. */
export const FRAGMENT_KINDS = ["fact", "preference", "project", "context", "summary"] as const;
export type FragmentKind = (typeof FRAGMENT_KINDS)[number];

/** Narrow a raw string to the closed FragmentKind set; false otherwise. */
export function isFragmentKind(s: string | null | undefined): s is FragmentKind {
  return typeof s === "string" && (FRAGMENT_KINDS as readonly string[]).includes(s);
}

export interface FragmentSearchOpts {
  /** 已有 embedding 时走向量检索;否则 fallback 到 importance 排序 */
  embedding?: number[] | null;
  limit?: number;
}

// C9-1(审查 §C9):旧实现用模块级变量缓存首个探测结果 —— 任一 DB 实例先探出
// false(如无 vec 的测试内存库),之后**所有**实例都被误判 false(true 反向同理
// → upsert 对不存在的表 INSERT 直接 throw)。向量检索可用性被“第一个调用者”
// 决定,跨实例串味。改为按实例 WeakMap,且**只缓存肯定结果**:
//  - true 在进程生命周期内单调(运行期无人 DROP fragments_vec)→ 永久缓存安全;
//  - false 不缓存 → B3 自愈(补跑 002 建表)后同进程立即可见,
//    且否定结果永不泄漏到其它实例。
const vecAvailableByDb = new WeakMap<Database.Database, true>();

export function isVecAvailable(db: Database.Database): boolean {
  if (vecAvailableByDb.has(db)) return true;
  try {
    db.prepare(`SELECT COUNT(*) FROM fragments_vec LIMIT 1`).get();
    vecAvailableByDb.set(db, true);
    return true;
  } catch {
    return false;
  }
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
  // vec0 是 KNN-distance 表;先删后插(没有真正的 upsert)。
  // C4(审查 §C4):DELETE+INSERT 必须在同一事务内 —— 旧实现裸跑两条语句,
  // INSERT 失败(典型:embedding 维度 ≠ FLOAT[1536],sqlite-vec 直接 throw)时
  // DELETE 已提交 → 旧向量永久丢失,该 fragment 从向量检索里静默消失
  // (调用方只 warn,无人重建)。transaction 化后 INSERT 抛错 → 整体回滚 →
  // 旧向量仍在、仍可检索。better-sqlite3 transaction 支持嵌套(savepoint),
  // 调用方已在事务里也安全。
  const vecStr = `[${embedding.join(",")}]`;
  const upsert = db.transaction(() => {
    db.prepare(`DELETE FROM fragments_vec WHERE fragment_id = ?`).run(fragmentId);
    db.prepare(`INSERT INTO fragments_vec (fragment_id, embedding) VALUES (?, ?)`).run(fragmentId, vecStr);
  });
  upsert();
}

export function getFragment(db: Database.Database, id: string): FragmentRow | null {
  const r = db.prepare(`SELECT * FROM fragments WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToFragment(r) : null;
}

/**
 * List fragments filtered by `kind`. Accepts any string for `kind` — invalid
 * values return an empty array (safe for URL query params that have not been
 * pre-validated by the caller). This is the validated boundary for fragment
 * kind access; callers should NOT cast `unknown` strings to `FragmentKind`
 * upstream — pass the raw string and let this function gate.
 */
export function listFragmentsByKind(
  db: Database.Database,
  kind: string,
  limit: number,
): FragmentRow[] {
  if (!isFragmentKind(kind)) return [];
  const rows = db
    .prepare(`SELECT * FROM fragments WHERE kind = ? ORDER BY importance DESC, created_at DESC LIMIT ?`)
    .all(kind, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToFragment);
}

// M3b: 列出全部 fragment(按 created_at DESC);M3c 可加时间窗 / kind 过滤
export function listFragmentsAll(
  db: Database.Database,
  limit: number = 100,
): FragmentRow[] {
  const rows = db
    .prepare(`SELECT * FROM fragments ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
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

/**
 * M3a · 基于文本 LIKE 的轻量检索(用于 ws.ts prompt 上下文注入)
 * - 对每个 ≥2 字符的 word 跑 OR LIKE
 * - 评分:命中 token 数 * importance * (1 + access_count)
 * - kinds?:限定种类;**默认排除 "summary"**(批次 5a.5 T1,§B1)——
 *   M2 占位启发式曾把 assistant 全文存成 summary(垃圾源已断,见 extractor.ts),
 *   存量垃圾被 LIKE 命中 → 注入 → 模型模仿 → 自我放大。改默认值而非在唯一
 *   生产调用方(ws.ts)显式传参 = 影响面最小且未来调用方天然免疫;数据不删,
 *   显式传 kinds:["summary"] 仍可检索,清理 SQL 由用户自行决定。
 *   显式传空数组 = 不过滤(保持旧语义)。
 * - limit:返回数量上限
 */
/**
 * 查询分词(批次 8-D / 审计 M2)。
 *
 * **旧实现是坏的,而且注释在撒谎**:`/[\u4e00-\u9fa5]{2,}/g` 是**贪婪整段**匹配,
 * 注释却写「中文按字拆」。于是查询「我叫什么名字」只产生一个 token「我叫什么名字」,
 * 而库里存的是「用户名字:小明」—— LIKE '%我叫什么名字%' 永远匹配不上。
 * 后果:用户说「记住:我叫小明」,下一轮问「我叫什么名字」,**记忆对用户等于不存在**。
 *
 * 现在按 CJK 惯例切 **bigram(相邻二字)**:「我叫什么名字」→ 我叫 / 叫什 / 什么 / 么名 / 名字。
 * 无词典、无分词器、纯字符串运算,却把「同义不同形」压到可接受:命中靠共享的二字组
 * (「名字」两侧都有),而不是整句相等。单字查询额外补一个字本身,否则 bigram 一个都产不出来。
 * 英文沿用原样(≥2 字母的小写词);数字与符号不参与匹配。
 */
function tokenizeQuery(query: string): string[] {
  const words: string[] = [];
  for (const tok of query.split(/\s+/)) {
    if (!tok) continue;
    const en = tok.match(/[a-zA-Z]{2,}/g);
    if (en) words.push(...en.map((w) => w.toLowerCase()));
    const zh = tok.match(/[\u4e00-\u9fa5]+/g);
    if (!zh) continue;
    for (const run of zh) {
      if (run.length === 1) {
        words.push(run);
        continue;
      }
      for (let i = 0; i + 1 < run.length; i++) words.push(run.slice(i, i + 2));
    }
  }
  return words;
}
export function searchFragmentsByText(
  db: Database.Database,
  query: string,
  opts: { limit?: number; kinds?: FragmentRow["kind"][] } = {},
): FragmentRow[] {
  const limit = opts.limit ?? 5;
  const kinds = opts.kinds ?? (["fact", "preference", "project", "context"] as FragmentRow["kind"][]);
  const words = tokenizeQuery(query);
  // 去重
  const tokens = Array.from(new Set(words));
  if (tokens.length === 0) return [];

  // 参数顺序必须与 SQL 占位符严格一致:score×2(下方 .all 前置)→ LIKE×n → kind IN×k → LIMIT。
  // 批次 5a.5 T1 顺带修复潜在 bug:旧代码先 push kinds 再 push LIKE tokens,与 SQL
  // 里 WHERE (LIKE…) AND kind IN (…) 的占位符顺序相反 —— 生产此前无人传 kinds 未暴露,
  // 默认 kinds 生效后该路径必走,错序会让 LIKE 绑定到 kind 值导致检索恒空。
  const likeClauses = tokens.map(() => "LOWER(f.content) LIKE ?").join(" OR ");
  const params: unknown[] = tokens.map((t) => `%${t}%`);
  let kindClause = "";
  if (kinds.length > 0) {
    kindClause = `AND f.kind IN (${kinds.map(() => "?").join(",")})`;
    params.push(...kinds);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT f.*,
              (LENGTH(f.content) - LENGTH(REPLACE(LOWER(f.content), LOWER(?), ''))) / MAX(LENGTH(?), 1)
                * f.importance * (1 + f.access_count) AS score
       FROM fragments f
       WHERE (${likeClauses}) ${kindClause}
       ORDER BY score DESC, f.importance DESC, f.created_at DESC
       LIMIT ?`,
    )
    .all(tokens[0], tokens[0], ...params) as Array<Record<string, unknown>>;
  return rows.map(rowToFragment);
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