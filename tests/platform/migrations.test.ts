/**
 * 迁移不变量测试
 *
 * ── 这个测试是为了一个真实踩到的坑 ────────────────────────────────
 *
 * 批次 5 写迁移 009 时,新表用了 `conversations` / `messages` 两个名字 ——
 * 而 001 早就建过同名表。`CREATE TABLE IF NOT EXISTS` **撞名时静默无操作**,
 * 于是:
 *
 *   1. 新表根本没建出来(不报错)
 *   2. 紧接着的 CREATE INDEX 以旧表为目标 → "no such column: project_id"
 *   3. 报错位置在**下游**,不在撞名处 —— 归因靠猜
 *
 * 167 个测试一起红,而错误信息指向一个和根因无关的索引。
 *
 * 这个坑的根源是「新旧表并存于同一个 SQLite」这个选择:它让撞名成为可能,
 * 而 IF NOT EXISTS 又让撞名无声。所以必须有一条不变量专门守它。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allMigrations, MIGRATIONS_DIR } from "./_migrations.js";

const FILES = allMigrations(MIGRATIONS_DIR).map((m) => ({
  version: m.version,
  name: m.name,
  file: `${String(m.version).padStart(3, "0")}_${m.name}.sql`,
  sql: readFileSync(join(MIGRATIONS_DIR, `${String(m.version).padStart(3, "0")}_${m.name}.sql`), "utf8"),
}));

/**
 * 去掉 SQL 注释。
 *
 * **必须先剥注释再解析** —— 这几个迁移的注释里就写着
 * 「CREATE TABLE IF NOT EXISTS 撞名时静默无操作」这句话。不剥的话,解析器会
 * 把那句话当真的 DDL,而且正则回溯时会把 `IF` 当成表名,报出一个
 * 「IF ← 009 + 010」的假撞名。
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 提取一个迁移里 CREATE TABLE 的表名(已剥注释) */
function createdTables(sql: string): string[] {
  const body = stripSqlComments(sql);
  return [...body.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)]
    .map((m) => m[1]!)
    // 兜底:即便可选组没匹配上,也不能把 SQL 关键字当成表名
    .filter((t) => !/^(if|not|exists)$/i.test(t));
}

describe("迁移文件名与编号", () => {
  it("编号唯一(重复编号会让集合判定把后者当成已应用)", () => {
    const byVersion = new Map<number, string[]>();
    for (const f of FILES) {
      const list = byVersion.get(f.version) ?? [];
      list.push(f.file);
      byVersion.set(f.version, list);
    }
    const dupes = [...byVersion.entries()].filter(([, v]) => v.length > 1);
    expect(dupes, "同一个编号被多个文件占用").toEqual([]);
  });

  it("文件名规范 NNN_name.sql", () => {
    for (const f of FILES) expect(f.file).toMatch(/^\d{3,}_[a-z0-9_]+\.sql$/);
  });
});

describe("**表名不得被两个迁移重复创建**(批次 5 真实事故的不变量)", () => {
  it("每一个表名只由一个迁移创建", () => {
    const owner = new Map<string, string[]>();
    for (const f of FILES) {
      for (const t of createdTables(f.sql)) {
        const list = owner.get(t) ?? [];
        list.push(f.file);
        owner.set(t, list);
      }
    }
    const collisions = [...owner.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([table, files]) => `${table} ← ${files.join(" + ")}`);

    expect(
      collisions,
      "CREATE TABLE IF NOT EXISTS 撞名时**静默无操作** —— 新表不会建出来," +
        "报错会出现在下游(索引/查询),归因极难。撞名的表必须改名",
    ).toEqual([]);
  });

  it("平台表与旧表的名字空间不重叠(并存期的硬约束)", () => {
    // 「平台表」= 007 及之后创建的;「旧表」= 006 及之前
    const oldTables = new Set<string>();
    const newTables = new Map<string, string>();
    for (const f of FILES) {
      for (const t of createdTables(f.sql)) {
        if (f.version <= 6) oldTables.add(t);
        else newTables.set(t, f.file);
      }
    }
    const overlap = [...newTables.entries()].filter(([t]) => oldTables.has(t));
    expect(
      overlap.map(([t, f]) => `${t}(平台 ${f})`),
      "平台表不能复用旧表名 —— 旧表在阶段 8 才会被 DROP,并存期里撞名会让新表静默建不出来",
    ).toEqual([]);
  });
});

describe("迁移引用的表必须先存在", () => {
  it("每条 CREATE INDEX 的目标表在该迁移或更早的迁移里被创建过", () => {
    const known = new Set<string>();
    const problems: string[] = [];
    for (const f of FILES) {
      // 先看这个迁移自己建了什么
      const own = createdTables(f.sql);
      // 检查索引目标
      for (const m of stripSqlComments(f.sql).matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[a-z_0-9]+\s+ON\s+([a-z_][a-z0-9_]*)/gi)) {
        const target = m[1]!;
        if (!known.has(target) && !own.includes(target)) {
          problems.push(`${f.file}: 索引目标表 ${target} 尚不存在`);
        }
      }
      for (const t of own) known.add(t);
    }
    expect(problems).toEqual([]);
  });

  it("ALTER TABLE 的目标必须先存在", () => {
    const known = new Set<string>();
    const problems: string[] = [];
    for (const f of FILES) {
      for (const m of stripSqlComments(f.sql).matchAll(/ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)/gi)) {
        const target = m[1]!;
        if (!known.has(target)) problems.push(`${f.file}: ALTER TABLE ${target} 尚不存在`);
      }
      for (const t of createdTables(f.sql)) known.add(t);
    }
    // 002 是 vec 迁移,依赖 001 的 fragments;005/006 依赖 004 的 blackboards
    expect(problems).toEqual([]);
  });
});

describe("真实迁移序列能跑通", () => {
  it("001→最新 全部应用成功(002 vec 在无扩展时允许失败)", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const failed: string[] = [];
    for (const f of FILES) {
      try {
        db.exec(f.sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 002 建 vec0 虚表,没加载扩展时必然失败 —— 这是已知且被迁移器 skip 的
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        failed.push(`${f.file}: ${msg}`);
      }
    }
    db.close();
    expect(failed).toEqual([]);
  });
});
