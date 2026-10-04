/**
 * 测试辅助:从 `migrations/` 目录**推导**迁移版本集合,而不是硬编码。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────
 *
 * 三个 storage 测试原本把「最新迁移是 6」写死在断言里:
 *
 *   expect(version).toBe(6);
 *   expect(versions).toEqual([1, 3, 4, 5, 6]);
 *
 * 于是每次新增一个迁移,这些测试就红一次 —— 而它们红的**原因与被测行为无关**,
 * 只是数字变了。这类失败会训练人忽略红灯,比没有测试更糟。
 *
 * 改成推导之后,断言表达的是真正的意图:
 *   「除 002(vec)外的全部迁移都应用了」
 *
 * 加 008 / 009 都不再需要动这些测试。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** 仓库根的 migrations/ —— 从 tests/storage/ 往上两级 */
export const MIGRATIONS_DIR = join(import.meta.dirname, "../../migrations");

export interface MigrationFile {
  version: number;
  name: string;
}

/** 目录里全部迁移,按版本升序 */
export function allMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const m = f.match(/^(\d{3,})_(.+)\.sql$/);
      if (!m || !m[1] || !m[2]) throw new Error(`迁移文件名不合规:${f}`);
      return { version: parseInt(m[1], 10), name: m[2] };
    })
    .sort((a, b) => a.version - b.version);
}

/** 全部迁移版本号(升序) */
export function allMigrationVersions(dir: string = MIGRATIONS_DIR): number[] {
  return allMigrations(dir).map((m) => m.version);
}

/** 最新迁移版本号 */
export function latestMigrationVersion(dir: string = MIGRATIONS_DIR): number {
  const all = allMigrationVersions(dir);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error(`migrations 目录为空:${dir}`);
  return last;
}

/** vec 扩展不可用时应当被 skip 的版本(迁移 002 建 vec0 虚表) */
export const VEC_MIGRATION_VERSION = 2;

/** vec 不可用时期望应用的版本集合 */
export function versionsWithoutVec(dir: string = MIGRATIONS_DIR): number[] {
  return allMigrationVersions(dir).filter((v) => v !== VEC_MIGRATION_VERSION);
}

/** 从库里读出已应用版本(升序) */
export function appliedVersions(db: { prepare: (sql: string) => { all: () => unknown[] } }): number[] {
  const rows = db.prepare(`SELECT version FROM schema_version ORDER BY version`).all() as Array<{
    version: number;
  }>;
  return rows.map((r) => r.version);
}
