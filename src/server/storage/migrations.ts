import type Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../../shared/log.js";

// Resolve migrations dir — works for both:
//   - dev: src/server/storage/migrations.ts → /  3 levels to /<repo>/migrations
//   - prod: dist/src/server/storage/migrations.js → /  4 levels to /<repo>/migrations
// Try 3-level first, fall back to 4-level if missing.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR_CANDIDATES = [
  resolve(HERE, "../../../migrations"),
  resolve(HERE, "../../../../migrations"),
];
const MIGRATIONS_DIR: string =
  MIGRATIONS_DIR_CANDIDATES.find((p): p is string => existsSync(p)) ??
  MIGRATIONS_DIR_CANDIDATES[1]!;

export interface MigrationResult {
  applied: number[];
  skipped: string[];
}

export interface RunMigrationsOptions {
  /**
   * C9-2(审查 §C9)测试 seam / 特殊部署:显式指定 migrations 目录。
   * 缺省 = 模块解析出的 <repo>/migrations(dev/dist 双候选,见文件头)。
   */
  migrationsDir?: string;
}

function ensureSchemaTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
}

/**
 * B3(审查 §B3「migration 逻辑使漏洞不可自愈」):已应用版本**集合**。
 * 旧实现用 `MAX(version)` 做单调游标 —— 002(vec)因扩展缺失被 skip 后
 * MAX 仍是 5,之后即使 vec 修好,`002 <= 5` 也永不重跑(实证:
 * `002 self-heals on subsequent boot: false`)。集合判定逐条比对,
 * 缺哪条补哪条。
 */
function appliedVersions(db: Database.Database): Set<number> {
  const rows = db.prepare(`SELECT version FROM schema_version`).all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

function listMigrations(dir: string = MIGRATIONS_DIR): Array<{ version: number; name: string; path: string }> {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const result: Array<{ version: number; name: string; path: string }> = [];
  for (const f of files) {
    const m = f.match(/^(\d{3,})_(.+)\.sql$/);
    if (!m || !m[1] || !m[2]) {
      throw new Error(`migration file name must match NNN_name.sql, got: ${f}`);
    }
    result.push({
      version: parseInt(m[1], 10),
      name: m[2],
      path: join(dir, f),
    });
  }
  return result;
}

export function runMigrations(db: Database.Database, opts: RunMigrationsOptions = {}): MigrationResult {
  ensureSchemaTable(db);
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const have = appliedVersions(db);
  const migrations = listMigrations(dir);

  // C9-2(审查 §C9「migrations 目录缺失静默空表启动」):不再静默。
  // 论证(两种形态两种处置):
  //  - 目录缺失 + 全新库(schema_version 空)→ **显式 throw**:空 schema 启动
  //    意味着之后所有 storage 查询一片 500,把安装故障推迟成运行时谜团;
  //    fail fast 让 `sansheng start` 直接报可读错误。
  //  - 目录缺失 + 已迁移库 → log.error 响亮告警后继续:既有表结构完好可用,
  //    拒绝启动会把本来能跑的安装打死(npm 包 files 未打包 migrations/ 的
  //    历史形态即属此类);但必须明说「新 migration 无法应用」。
  if (!existsSync(dir)) {
    if (have.size === 0) {
      throw new Error(
        `migrations directory not found: ${dir} — refusing to boot a fresh database with an empty schema (broken installation: <repo>/migrations must ship alongside the code)`,
      );
    }
    log.error(
      `storage: migrations directory not found: ${dir} — continuing with ${have.size} previously applied migration(s); NO new migrations can be applied until the installation is fixed`,
    );
  }

  const applied: number[] = [];
  const skipped: string[] = [];

  for (const mig of migrations) {
    // B3:集合判定(见 appliedVersions 注释)。补跑的 migration 必须幂等且
    // 不依赖应用顺序 —— 现状满足:002 只建独立 vec0 虚表(IF NOT EXISTS),
    // 004/005 已补 IF NOT EXISTS / 走 ALTER(C9-3)。
    if (have.has(mig.version)) continue;
    const sql = readFileSync(mig.path, "utf-8");
    try {
      db.transaction(() => {
        db.exec(sql);
        db.prepare(`INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)`).run(
          mig.version,
          mig.name,
          Date.now(),
        );
      })();
      applied.push(mig.version);
      have.add(mig.version);
    } catch (err) {
      // sqlite-vec 可能没装,002 失败就 skip(fragments 会降级到无向量检索)。
      // 与旧行为的区别:skip 不再永久化 —— 集合判定下,下一次 boot 若 vec
      // 可加载(Storage 构造器已接线),002 自动补跑(自愈)。
      if (mig.version === 2 && err instanceof Error && /vec0|no such module|not loaded/i.test(err.message)) {
        log.warn(`storage: migration 002 (vec) skipped — sqlite-vec unavailable: ${err.message}`);
        skipped.push(mig.path);
        continue;
      }
      throw err;
    }
  }

  return { applied, skipped };
}
