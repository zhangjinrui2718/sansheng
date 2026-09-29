/**
 * Test helpers for HTTP routes (M3+ B1).
 * Builds a minimal Hono app with only B1 routes — no kernel/ws mocking needed.
 *
 * createApp() instantiates Storage with a real file path + creates ToolRegistry (which
 * reads ~/.sansheng/sandbox.json), neither of which we want for unit tests. So we build
 * a thin Storage-shaped object that wraps a raw in-memory better-sqlite3 Database.
 */
import { Hono } from "hono";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "../../../src/server/storage/migrations.js";
import { registerBlackboardArtifactRoutes } from "../../../src/server/http/blackboardRoutes.js";

export interface TestStorage {
  db: Database.Database;
  storage: TestStorage;
}

export function makeTestStorage(): TestStorage {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  runMigrations(db);
  const obj: TestStorage = { db, storage: undefined as unknown as TestStorage };
  obj.storage = obj;
  return obj;
}

export function makeTestApp(storage: TestStorage): Hono {
  const app = new Hono();
  registerBlackboardArtifactRoutes(app, storage as { db: Database.Database });
  return app;
}