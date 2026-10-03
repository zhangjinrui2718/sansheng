/**
 * BC7 Memory · SQLite 参考实现
 *
 * ── 检索为什么用 bigram ───────────────────────────────────────────
 *
 * 旧系统的正则分词是「贪婪整段」,而注释自称按字拆 —— 于是「我叫什么名字」
 * 永远召不回「用户名字:小明」(8-D 审计项 M2)。中文没有空格,按词切需要
 * 分词器;按 **bigram**(相邻两字滑窗)切不需要任何词典,且召回率够用。
 *
 * 英文/数字按词切,与 bigram 混用:查询里出现英文技术词(「TypeScript」)时
 * 按词匹配更准。
 *
 * ── 排序 ─────────────────────────────────────────────────────────
 *
 * 命中词数优先,其次 importance,再次 recency。
 * **命中数是主序** —— 只按 importance 排会让一条很久以前的高权重记忆永远压在
 * 顶上,而它可能与当前问题毫无关系。
 */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  isFragmentKind,
  type Fragment,
  type FragmentKind,
  type MemoryPort,
  type RecallOptions,
  type RememberInput,
} from "./port.js";

interface RawFragment {
  id: string;
  kind: string;
  content: string;
  importance: number;
  decay_factor: number;
  access_count: number;
  last_accessed_at: number | null;
  created_at: number;
  source_project_id: string | null;
}

function rowToFragment(raw: RawFragment): Fragment {
  if (!isFragmentKind(raw.kind)) {
    throw new Error(`memory_fragments 表里出现未定义 kind「${raw.kind}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    kind: raw.kind,
    content: raw.content,
    importance: raw.importance,
    decayFactor: raw.decay_factor,
    accessCount: raw.access_count,
    lastAccessedAt: raw.last_accessed_at,
    createdAt: raw.created_at,
    sourceProjectId: raw.source_project_id,
  };
}

/** 内容哈希(去重键)。trim + 折叠空白,避免「同一句话多个空格」算两条。 */
function contentHash(content: string): string {
  const normalized = content.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * 把查询串切成检索词。
 *
 * 中文(含日韩等 CJK 统一表意文字)走 bigram;ASCII 连续串走整词。
 * 两类混排时各切各的 —— 「用户的 TypeScript 偏好」会得到
 * [用户, 户的, TypeScript, 偏好]。
 */
export function tokenize(query: string): string[] {
  const terms = new Set<string>();
  const s = query.trim();
  if (s === "") return [];

  // ASCII 词(长度 ≥2,避免 a/the 这类噪音)
  for (const w of s.match(/[A-Za-z0-9_]{2,}/g) ?? []) terms.add(w.toLowerCase());

  // CJK bigram:只对连续 CJK 段滑窗,不跨标点/空格
  for (const seg of s.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g) ?? []) {
    if (seg.length === 1) { terms.add(seg); continue; }
    for (let i = 0; i + 1 < seg.length; i++) terms.add(seg.slice(i, i + 2));
  }
  return [...terms];
}

export interface SqliteMemoryOptions {
  /** id 生成(注入以便测试可复现) */
  newId: (prefix: string) => string;
  /** 时钟注入 */
  now: () => number;
}

/** 基于 SQLite 的参考实现。上层的 `MemoryPort` 契约不暴露任何 SQLite 细节。 */
export class SqliteMemory implements MemoryPort {
  constructor(
    private readonly db: Database.Database,
    private readonly opts: SqliteMemoryOptions,
  ) {}

  async remember(input: RememberInput): Promise<string> {
    const content = input.content.trim();
    if (content === "") throw new Error("记忆内容不能为空");
    if (!isFragmentKind(input.kind)) throw new Error(`未知记忆分类「${String(input.kind)}」`);

    const hash = contentHash(content);
    const existing = this.db
      .prepare(`SELECT id FROM memory_fragments WHERE content_hash = ?`)
      .get(hash) as { id: string } | undefined;
    // 重复内容不重复入库 —— 旧系统缺这个,于是攒下大量重复片段
    if (existing) return existing.id;

    const id = this.opts.newId("mem");
    const importance = input.importance ?? 0.5;
    if (importance < 0 || importance > 1) {
      throw new Error(`importance 必须在 [0,1],收到 ${importance}`);
    }
    this.db
      .prepare(
        `INSERT INTO memory_fragments
           (id, kind, content, importance, decay_factor, access_count,
            last_accessed_at, created_at, source_project_id, content_hash)
         VALUES (?, ?, ?, ?, 0.95, 0, NULL, ?, ?, ?)`,
      )
      .run(id, input.kind, content, importance, this.opts.now(), input.sourceProjectId ?? null, hash);
    return id;
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<Fragment[]> {
    const terms = tokenize(query);
    const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);

    // 查询无有效词 → 退化为按 importance + 新近度取前 N(而不是返回空)
    if (terms.length === 0) {
      return this.rankedFallback(opts, limit);
    }

    const kindFilter =
      opts.kinds !== undefined && opts.kinds.length > 0
        ? ` AND kind IN (${opts.kinds.map(() => "?").join(",")})`
        : "";
    const kindVals = opts.kinds !== undefined && opts.kinds.length > 0 ? [...opts.kinds] : [];

    // 在 SQL 里做 LIKE 粗筛(避免全表拉进内存),再在 JS 里按命中数精排。
    // 粗筛用 OR:任一 bigram 命中就进来。
    const likeClauses = terms.map(() => "content LIKE ?").join(" OR ");
    const likeVals = terms.map((t) => `%${t}%`);

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_fragments
         WHERE (${likeClauses})${kindFilter}`,
      )
      .all(...likeVals, ...kindVals) as RawFragment[];

    const scored = rows.map((raw) => {
      const lower = raw.content.toLowerCase();
      let hits = 0;
      for (const t of terms) if (lower.includes(t)) hits++;
      return { raw, hits };
    });

    scored.sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      if (b.raw.importance !== a.raw.importance) return b.raw.importance - a.raw.importance;
      return b.raw.created_at - a.raw.created_at;
    });

    const top = scored.slice(0, limit);
    if (top.length > 0) this.bumpAccess(top.map((s) => s.raw.id), this.opts.now());
    return top.map((s) => rowToFragment(s.raw));
  }

  private rankedFallback(opts: RecallOptions, limit: number): Fragment[] {
    const kindFilter =
      opts.kinds !== undefined && opts.kinds.length > 0
        ? `WHERE kind IN (${opts.kinds.map(() => "?").join(",")})`
        : "";
    const kindVals = opts.kinds !== undefined && opts.kinds.length > 0 ? [...opts.kinds] : [];
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_fragments ${kindFilter}
         ORDER BY importance DESC, created_at DESC LIMIT ?`,
      )
      .all(...kindVals, limit) as RawFragment[];
    return rows.map(rowToFragment);
  }

  /** 访问计数与最后访问时间 —— 排序与将来做衰减都要用 */
  private bumpAccess(ids: readonly string[], at: number): void {
    const stmt = this.db.prepare(
      `UPDATE memory_fragments SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
    );
    this.db.transaction(() => {
      for (const id of ids) stmt.run(at, id);
    })();
  }

  /**
   * 本轮是 no-op。
   *
   * 「实现一个什么都不做的方法」看起来多余,但它是**契约的一部分**:接口声明
   * decay 可选,调用方会写 `if (port.decay) await port.decay()`。给它一个真实
   * 实现(而不是不实现)让调用路径在参考后端上也被走通一次 —— 否则那段代码
   * 到换上真后端那天才会第一次执行。
   */
  async decay(): Promise<void> {
    return Promise.resolve();
  }
}

/** 记忆条数(诊断用)。 */
export function countFragments(db: Database.Database): number {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM memory_fragments`).get() as { n: number };
  return r.n;
}

export type { Fragment, FragmentKind, MemoryPort, RecallOptions, RememberInput };
