import type Database from "better-sqlite3";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function ensureSchemaTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
}

function currentVersion(db: Database.Database): number {
  const row = db.prepare(`SELECT MAX(version) as v FROM schema_version`).get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

function listMigrations(): Array<{ version: number; name: string; path: string }> {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const result: Array<{ version: number; name: string; path: string }> = [];
  for (const f of files) {
    const m = f.match(/^(\d{3,})_(.+)\.sql$/);
    if (!m || !m[1] || !m[2]) {
      throw new Error(`migration file name must match NNN_name.sql, got: ${f}`);
    }
    result.push({
      version: parseInt(m[1], 10),
      name: m[2],
      path: join(MIGRATIONS_DIR, f),
    });
  }
  return result;
}

export function runMigrations(db: Database.Database): MigrationResult {
  ensureSchemaTable(db);
  const current = currentVersion(db);
  const migrations = listMigrations();
  const applied: number[] = [];
  const skipped: string[] = [];

  for (const mig of migrations) {
    if (mig.version <= current) continue;
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
    } catch (err) {
      // sqlite-vec 可能没装,002 失败就 skip(fragments 会降级到无向量检索)
      if (mig.version === 2 && err instanceof Error && /vec0|no such module|not loaded/i.test(err.message)) {
        skipped.push(mig.path);
        continue;
      }
      throw err;
    }
  }

  return { applied, skipped };
}