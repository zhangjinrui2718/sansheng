import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";
import { log } from "../../shared/log.js";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Storage {
  readonly db: Database.Database;
  private closed = false;

  constructor(dbPath: string) {
    // 确保父目录存在
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");

    const result = runMigrations(this.db);
    if (result.applied.length > 0) {
      log.info(`storage: applied migrations ${result.applied.join(", ")}`);
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