/**
 * 批次 4a · C4(上)— upsertFragmentEmbedding 先 DELETE 后 INSERT 不在事务内
 * (docs/CODE-REVIEW-2026-10-01.md §C4,审查有一次性实证:维度不匹配失败 → 旧向量已删)
 *
 * 缺陷形态:fragments.ts 先 `DELETE FROM fragments_vec WHERE fragment_id=?` 再
 * `INSERT` —— INSERT 失败(典型:embedding 维度 ≠ FLOAT[1536])时 DELETE 已提交
 * → 旧向量永久丢失,该 fragment 从向量检索里消失(且调用方只 warn,无人重建)。
 *
 * 修复契约:DELETE+INSERT 包进 better-sqlite3 `db.transaction()` —— INSERT 抛错
 * → 整个事务回滚 → 旧向量仍在、仍可检索。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "../../src/server/storage/migrations.js";
import {
  insertFragment,
  upsertFragmentEmbedding,
  searchFragments,
} from "../../src/server/storage/repo/fragments.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  loadSqliteVec(db);
  runMigrations(db);
  insertFragment(db, {
    id: "f1",
    kind: "fact",
    content: "已有向量的片段",
    sourceConversationId: null,
    sourceMessageId: null,
    importance: 0.5,
    decayFactor: 0.95,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    metadata: null,
  });
});

afterEach(() => {
  db.close();
});

function goodVec(): number[] {
  const v = new Array<number>(1536).fill(0.1);
  v[0] = 1.0;
  return v;
}

function vecRowCount(fragmentId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS c FROM fragments_vec WHERE fragment_id = ?`).get(fragmentId) as {
      c: number;
    }
  ).c;
}

describe("C4 · upsertFragmentEmbedding 事务化", () => {
  it("维度不匹配的 INSERT 失败 → 事务回滚 → 旧向量仍在且仍可检索", () => {
    const v1 = goodVec();
    upsertFragmentEmbedding(db, "f1", v1);
    expect(vecRowCount("f1")).toBe(1);

    // FLOAT[1536] 表插 3 维向量 → sqlite-vec 报维度错误。
    // RED(修复前):DELETE 已先提交 → 抛错后 vecRowCount=0(旧向量丢失)
    expect(() => upsertFragmentEmbedding(db, "f1", [0.1, 0.2, 0.3])).toThrow();
    expect(vecRowCount("f1"), "失败后旧向量必须仍在(事务回滚)").toBe(1);

    // 旧向量仍可被 KNN 检索命中
    const rows = searchFragments(db, { embedding: v1, limit: 5 });
    expect(rows.map((r) => r.id)).toContain("f1");
  });

  it("合法覆盖仍正常:同维度二次 upsert → 恰好一行且为新向量", () => {
    upsertFragmentEmbedding(db, "f1", goodVec());
    const v2 = goodVec();
    v2[0] = 0.2;
    v2[1] = 1.0;
    upsertFragmentEmbedding(db, "f1", v2); // vec0 无真 upsert:删旧插新
    expect(vecRowCount("f1")).toBe(1);
    // 新向量生效:用 v2 检索命中 f1
    const rows = searchFragments(db, { embedding: v2, limit: 5 });
    expect(rows[0]?.id).toBe("f1");
  });
});
