/**
 * 批次 4a · C9-2 + C9-3(docs/CODE-REVIEW-2026-10-01.md §C9)
 *
 * C9-2:migrations 目录缺失 → runMigrations 返回空、**静默**以空表启动
 *   (后续所有 storage 查询 500,极难定位)。修复契约(论证见 migrations.ts):
 *   - 目录缺失 + 全新库(schema_version 无任何已应用行)→ **显式 throw**
 *     (fail fast:空 schema 启动 = 全链路坏,静默只会把故障推迟成一片 500);
 *   - 目录缺失 + 已迁移过的库 → 响亮 log.error 后继续可启动
 *     (既有表结构完好,拒绝启动反而把可用安装打死;新 migration 无法应用需告警)。
 *   - 测试 seam:runMigrations(db, { migrationsDir }) 可显式指定目录。
 *
 * C9-3:004_blackboards.sql 是全目录唯一无 IF NOT EXISTS 的 CREATE TABLE
 *   (+两个 CREATE INDEX 同样裸奔)。集合判定(B3 自愈)让「version 未记录但
 *   对象已存在」的重跑形态成为可能(如手工修复过的库 / 从别处拷贝的库),
 *   必须幂等。已存在的库安全性:schema_version 已记录 4 → 正常 boot 永不重跑
 *   004(既有 db.test.ts 幂等用例覆盖);本文件验证文件本身重放安全。
 */
import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../../src/server/storage/migrations.js";

const NONEXISTENT_DIR = join(tmpdir(), "sansheng-migrations-dir-does-not-exist-4a");

describe("C9-2 · migrations 目录缺失不再静默", () => {
  it("全新库 + 目录缺失 → 显式 throw(拒绝空表启动)", () => {
    const db = new Database(":memory:");
    // RED(修复前):第二参数不存在,目录缺失静默返回 { applied: [] } → 不 throw
    expect(() =>
      runMigrations(db, { migrationsDir: NONEXISTENT_DIR }),
    ).toThrow(/migrations directory/i);
    db.close();
  });

  it("已迁移库 + 目录缺失 → 不 throw(既有安装仍可启动,响亮告警)", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    runMigrations(db); // 真实目录,全量应用
    expect(() =>
      runMigrations(db, { migrationsDir: NONEXISTENT_DIR }),
    ).not.toThrow();
    db.close();
  });
});

describe("C9-3 · 004_blackboards.sql 幂等可重放(IF NOT EXISTS)", () => {
  it("同一库上重放两次 004 → 第二次不 throw", () => {
    const sql004 = readFileSync(
      fileURLToPath(new URL("../../migrations/004_blackboards.sql", import.meta.url)),
      "utf-8",
    );
    const db = new Database(":memory:");
    db.exec(sql004);
    // RED(修复前):CREATE TABLE blackboards 无 IF NOT EXISTS → "table blackboards already exists"
    expect(() => db.exec(sql004)).not.toThrow();
    db.close();
  });

  it("已记录 version=4 的库正常 boot 不重跑 004(schema_version 守护,编辑文件不影响存量库)", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    const r1 = runMigrations(db);
    expect(r1.applied).toContain(4);
    const r2 = runMigrations(db);
    expect(r2.applied).toHaveLength(0); // 幂等:不重放任何已记录版本
    db.close();
  });
});
