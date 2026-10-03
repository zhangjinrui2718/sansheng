/**
 * 批次 4a · B3 — sqlite-vec 生产从未加载 + migration 逻辑使漏洞不可自愈
 * (docs/CODE-REVIEW-2026-10-01.md §B3,含实证)+ C9-1 isVecAvailable 跨实例泄漏
 *
 * 缺陷形态(审查 §B3 实证):
 *  - `storage/db.ts` 构造器无 `load(db)`;全仓 `sqlite-vec` import 只在 tests/
 *    → 生产启动 `applied migrations 1,3,4,5`,002 每次被静默 skip
 *    (migrations.ts catch-and-skip);
 *  - **不可自愈**:`currentVersion` 用 `MAX(version)` → 002 被跳过后 MAX=5 →
 *    日后即使补上 extension load,002 也永不重跑(审查实证:`applied: []`,
 *    `fragments_vec created retroactively: false`);
 *  - 连带:upsertFragmentEmbedding 因 isVecAvailable=false 静默丢弃向量,
 *    searchFragments 的 vec 路径全链路死代码;
 *  - C9-1:`isVecAvailable` 用模块级变量缓存首个探测结果 → 跨 DB 实例串味。
 *
 * 修复契约:
 *  - `new Storage(<文件路径>)`(生产构造路径,非测试注入)在连接上真实加载
 *    sqlite-vec → migration 002 applied → isVecAvailable(db)=true;
 *  - 向量 upsert + KNN 检索在临时库上端到端可用;
 *  - runMigrations 改**集合判定**(逐条 version 与 schema_version 已应用行比对)
 *    → 历史上被 skip 的 002 在 vec 可加载的下一次 boot 自动补跑(自愈);
 *  - isVecAvailable 按 DB 实例缓存(只缓存肯定结果;否定结果每次重探,
 *    同进程内自愈建表后立即可见,且负缓存永不串到别的实例)。
 */
import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../src/server/storage/db.js";
import { allMigrationVersions, versionsWithoutVec } from "./_migrations.js";
import { runMigrations } from "../../src/server/storage/migrations.js";
import {
  isVecAvailable,
  insertFragment,
  upsertFragmentEmbedding,
  searchFragments,
  type FragmentRow,
} from "../../src/server/storage/repo/fragments.js";

const tmpDirs: string[] = [];
function tmpDbPath(prefix = "sansheng-b3-vec-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return join(dir, "sansheng.db");
}

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkFragment(id: string, content: string, importance: number): FragmentRow {
  return {
    id,
    kind: "fact",
    content,
    sourceConversationId: null,
    sourceMessageId: null,
    importance,
    decayFactor: 0.95,
    accessCount: 0,
    lastAccessedAt: null,
    createdAt: Date.now(),
    metadata: null,
  };
}

/** 1536 维向量:除 `hotIndex` 位为 1.0 外全 0.1(两个向量互相可区分) */
function mkVec(hotIndex: number): number[] {
  const v = new Array<number>(1536).fill(0.1);
  v[hotIndex] = 1.0;
  return v;
}

function appliedVersions(db: Database.Database): number[] {
  return (
    db.prepare(`SELECT version FROM schema_version ORDER BY version`).all() as Array<{
      version: number;
    }>
  ).map((r) => r.version);
}

describe("B3 · sqlite-vec 生产加载(Storage 构造路径,非测试注入)", () => {
  it("new Storage(文件路径) → vec 真实加载 → migration 002 applied → isVecAvailable=true", () => {
    const storage = new Storage(tmpDbPath());
    try {
      // RED(修复前):002 被 skip → [1,3,4,5](审查实证「applied migrations 1,3,4,5」)
      expect(appliedVersions(storage.db)).toEqual(allMigrationVersions());
      // RED(修复前):fragments_vec 不存在 → false
      expect(isVecAvailable(storage.db)).toBe(true);
      // RED(修复前):构造器从不加载扩展 → vecLoaded 属性不存在(undefined)
      expect((storage as Storage & { vecLoaded?: boolean }).vecLoaded).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("向量 upsert + KNN 检索端到端可用(临时库;距离序而非 importance 序)", () => {
    const storage = new Storage(tmpDbPath());
    try {
      // 故意让 importance 与向量距离结论相反:f-near importance 低、f-far 高。
      // 修复前(无 vec)searchFragments 走 importance fallback → f-far 排前 → RED;
      // 修复后走 vec KNN → 查询向量与 f-near 的 embedding 相同 → f-near 排前。
      insertFragment(storage.db, mkFragment("f-near", "向量近邻片段", 0.2));
      insertFragment(storage.db, mkFragment("f-far", "importance 高分片段", 0.9));
      const vNear = mkVec(0);
      const vFar = mkVec(777);
      upsertFragmentEmbedding(storage.db, "f-near", vNear);
      upsertFragmentEmbedding(storage.db, "f-far", vFar);

      // RED(修复前):fragments_vec 表不存在 → 本行直接 throw(no such table)
      const cnt = storage.db
        .prepare(`SELECT COUNT(*) AS c FROM fragments_vec`)
        .get() as { c: number };
      expect(cnt.c).toBe(2);

      const rows = searchFragments(storage.db, { embedding: vNear, limit: 2 });
      expect(rows.map((r) => r.id)).toEqual(["f-near", "f-far"]);
    } finally {
      storage.close();
    }
  });

  it("自愈:历史上被 skip 的 002 在下一次 boot(vec 已加载)自动补跑(审查「不可自愈」实证复现)", () => {
    const dbPath = tmpDbPath("sansheng-b3-heal-");
    // 阶段 1:模拟旧生产形态 —— 连接未加载扩展时跑 migrations → 002 被 catch-and-skip
    const raw = new Database(dbPath);
    try {
      const r1 = runMigrations(raw);
      expect(r1.applied).not.toContain(2);
      expect(r1.skipped).toHaveLength(1);
      expect(appliedVersions(raw)).toEqual(versionsWithoutVec());
    } finally {
      raw.close();
    }
    // 阶段 2:「重启」走生产构造路径(构造器自动加载 vec)。
    // RED(修复前):currentVersion=MAX=5 → 002 ≤ 5 永不重跑 → isVecAvailable=false
    const storage = new Storage(dbPath);
    try {
      expect(appliedVersions(storage.db)).toEqual(allMigrationVersions());
      expect(isVecAvailable(storage.db)).toBe(true);
      // 自愈后向量链路立即可用
      insertFragment(storage.db, mkFragment("f-heal", "自愈后的片段", 0.5));
      upsertFragmentEmbedding(storage.db, "f-heal", mkVec(3));
      const rows = searchFragments(storage.db, { embedding: mkVec(3), limit: 5 });
      expect(rows[0]?.id).toBe("f-heal");
    } finally {
      storage.close();
    }
  });
});

describe("C9-1 · isVecAvailable 模块级缓存跨 DB 实例串味", () => {
  it("按实例缓存:负→正、正→负两个方向都不泄漏", () => {
    const dbNoVec = new Database(":memory:");
    runMigrations(dbNoVec); // 无扩展 → 002 skip → 无 fragments_vec
    const dbVec = new Database(":memory:");
    loadSqliteVec(dbVec);
    runMigrations(dbVec);

    expect(isVecAvailable(dbNoVec)).toBe(false);
    // RED(修复前):模块级 vecAvailable=false 已缓存 → 有 vec 的实例也返回 false
    expect(isVecAvailable(dbVec)).toBe(true);

    const dbNoVec2 = new Database(":memory:");
    runMigrations(dbNoVec2);
    // RED(修复前另一方向):若 true 先被缓存 → 无 vec 实例误报 true →
    // upsertFragmentEmbedding 会对不存在的表 INSERT 直接 throw(而非静默降级)
    expect(isVecAvailable(dbNoVec2)).toBe(false);

    dbNoVec.close();
    dbVec.close();
    dbNoVec2.close();
  });
});
