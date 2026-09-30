import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";
import { log } from "../../shared/log.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Storage {
  readonly db: Database.Database;
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

      const result = runMigrations(this.db);
      if (result.applied.length > 0) {
        log.info(`storage: applied migrations ${result.applied.join(", ")}`);
      }
      // B1 additive safety: idempotently ensure blackboards.artifacts_json exists
      // (handles cases where migration 005 didn't run — e.g., legacy DBs upgraded in place).
      ensureBlackboardArtifactsColumn(this.db);
    } else {
      // Adopt a caller-owned Database instance (test convenience for in-memory DBs).
      // The caller is responsible for running migrations and pragmas.
      this.db = dbOrPath;
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