import Database from "better-sqlite3";
// B3(审查 §B3):生产连接加载 sqlite-vec —— 此前全仓唯一 load 点在 tests/,
// 生产启动 002_vec.sql 永远被 skip,向量检索全链路死代码。
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "./migrations.js";
import { log } from "../../shared/log.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Storage {
  readonly db: Database.Database;
  /**
   * B3:本实例是否在构造时成功加载 sqlite-vec 扩展。
   * 仅文件路径构造分支会尝试加载;adopted-Database 分支(测试便利)恒 false —
   * 该分支的 vec 可用性由调用方负责(loadSqliteVec),运行时判定始终以
   * isVecAvailable(db) 为准(本标志只描述「构造器加载动作」的结果)。
   */
  readonly vecLoaded: boolean;
  private closed = false;

  constructor(dbOrPath: string | Database.Database) {
    if (typeof dbOrPath === "string") {
      // 确保父目录存在
      const dir = dirname(dbOrPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      this.db = new Database(dbOrPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("synchronous = NORMAL");

      // B3:先加载扩展再跑 migrations —— 002(vec0 虚表)才能真实 applied;
      // 加载失败(平台二进制缺失/不支持平台)→ 降级不崩 boot:
      // 002 走 migrations 的 catch-and-skip(下次 boot 集合判定自动补跑),
      // repo 层经 isVecAvailable 探测回退 text/importance 检索。
      this.vecLoaded = tryLoadVecExtension(this.db);

      const result = runMigrations(this.db);
      if (result.applied.length > 0) {
        log.info(`storage: applied migrations ${result.applied.join(", ")}`);
      }
      if (result.skipped.length > 0) {
        // B3:skip 不再完全静默 —— 明确告知降级项(002 会在 vec 可加载的下一次
        // boot 自愈补跑,见 migrations.ts 集合判定)
        log.warn(
          `storage: skipped migrations (degraded, will retry on next boot): ${result.skipped.join(", ")}`,
        );
      }
      // B1 additive safety: idempotently ensure blackboards.artifacts_json exists
      // (handles cases where migration 005 didn't run — e.g., legacy DBs upgraded in place).
      ensureBlackboardArtifactsColumn(this.db);
    } else {
      // Adopt a caller-owned Database instance (test convenience for in-memory DBs).
      // The caller is responsible for running migrations and pragmas.
      this.db = dbOrPath;
      this.vecLoaded = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      log.warn("storage close failed:", err);
    }
  }
}

/**
 * B3(审查 §B3 修复方向「db.ts 构造器 try/catch load」):
 * 在连接上加载 sqlite-vec 扩展。失败 → warn + 返回 false(降级语义):
 *  - 002_vec.sql 由 runMigrations 的 vec0 catch-and-skip 兜住,boot 不崩;
 *  - fragments repo 经 isVecAvailable 探测自动走 text/importance fallback;
 *  - 下一次 boot(vec 可加载时)由集合判定自动补跑 002(自愈)。
 * sqlite-vec 的平台二进制是 optionalDependencies:装不上时 load() throw,
 * 这正是必须 try/catch 的原因(包本体在 dependencies,顶层 import 安全)。
 */
function tryLoadVecExtension(db: Database.Database): boolean {
  try {
    loadSqliteVec(db);
    return true;
  } catch (err) {
    log.warn(
      "storage: sqlite-vec extension load failed — vector search degraded to text/importance fallback:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * B1 · ensure `blackboards.artifacts_json` column exists.
 *
 * Idempotent — safe to call multiple times. Uses PRAGMA table_info to detect
 * the column, then ALTER TABLE if missing. Default `'[]'` matches migration 005.
 *
 * This complements migration 005 for:
 *   - DBs created on older migrations where 005 didn't run yet
 *   - In-memory test DBs that skip the full migration runner
 *   - Recovery scenarios where a row needs the column added
 */
export function ensureBlackboardArtifactsColumn(db: Database.Database): void {
  // PRAGMA table_info on a missing table throws. Guard so callers (e.g. fresh
  // DB before migrations ran) don't crash — it's purely a defense-in-depth
  // check; the column is normally added by migration 005.
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='blackboards'`)
    .all() as Array<{ name: string }>;
  if (tables.length === 0) return;
  const cols = db
    .prepare(`PRAGMA table_info(blackboards)`)
    .all() as Array<{ name: string }>;
  const has = cols.some((c) => c.name === "artifacts_json");
  if (has) return;
  db.exec(`ALTER TABLE blackboards ADD COLUMN artifacts_json TEXT DEFAULT '[]'`);
}