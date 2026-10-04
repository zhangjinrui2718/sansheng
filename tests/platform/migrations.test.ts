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
 *
 * ── 012 之后:重建表要**逐表登记**,不是放开守卫 ────────────────────
 *
 * 012 有意重建了 `project_sessions`(SQLite 不能 `ALTER COLUMN`,而
 * `project_id` 要从 NOT NULL 放宽为可空)。它因此确实「被两个迁移创建」。
 * 处置:
 *
 *   - 例外写在 `INTENTIONAL_REBUILDS` 里,**逐表登记 + 写明理由**;
 *   - 未登记的重名仍然报错 —— 守卫对批次 5 那种事故形态依然有牙;
 *   - 登记项必须真的命中一次(见下面「登记不得过期」那条断言),
 *     否则它只是给人看的注释,久了自己就漂了。
 *
 * 另外 012 必须**原样重建被 DROP 掉的索引**:`DROP TABLE` 会把表上的索引一起
 * 丢掉,而这件事不报错 —— 又一处静默失败。下面的 describe 守着它。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allMigrations, MIGRATIONS_DIR } from "./_migrations.js";

/**
 * 有意重建的表。**例外必须逐条登记**(表名 + 涉及的迁移文件 + 理由)。
 * 数组里的每一项都必须真的被用到 —— 见「登记不得过期」。
 */
const INTENTIONAL_REBUILDS: ReadonlyArray<{
  readonly table: string;
  readonly files: readonly string[];
  readonly why: string;
}> = [
  {
    table: "project_sessions",
    files: ["009_collaboration.sql", "012_intake_session.sql"],
    why:
      "012 把 project_id 从 NOT NULL 放宽为可空(接待会话)。SQLite 没有 ALTER COLUMN," +
      "放宽可空性只能重建表;而重建前后表名必须相同(其他表与全部代码都按这个名字引用它)",
  },
];

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
  /** 扫出全部「被 ≥2 个迁移创建」的表名 → 涉及的文件列表。 */
  function collisions(): Map<string, string[]> {
    const owner = new Map<string, string[]>();
    for (const f of FILES) {
      for (const t of createdTables(f.sql)) {
        const list = owner.get(t) ?? [];
        list.push(f.file);
        owner.set(t, list);
      }
    }
    return new Map([...owner.entries()].filter(([, files]) => files.length > 1));
  }

  it("每一个表名只由一个迁移创建(有意重建的除外,且必须已登记)", () => {
    const allowed = new Map(
      INTENTIONAL_REBUILDS.map((r) => [r.table, [...r.files].sort().join(" + ")]),
    );
    const unregistered = [...collisions().entries()]
      .filter(([table, files]) => allowed.get(table) !== [...files].sort().join(" + "))
      .map(([table, files]) => `${table} ← ${files.join(" + ")}`);

    expect(
      unregistered,
      "CREATE TABLE IF NOT EXISTS 撞名时**静默无操作** —— 新表不会建出来," +
        "报错会出现在下游(索引/查询),归因极难。撞名的表必须改名;" +
        "确实需要重建(如放宽 NOT NULL)的,逐表登记进 INTENTIONAL_REBUILDS 并写明理由",
    ).toEqual([]);
  });

  it("登记不得过期:每条 INTENTIONAL_REBUILDS 都必须真的命中一次重名", () => {
    const actual = collisions();
    const stale = INTENTIONAL_REBUILDS.filter((r) => {
      const files = actual.get(r.table);
      return files === undefined || [...r.files].sort().join(" + ") !== [...files].sort().join(" + ");
    }).map((r) => r.table);
    expect(stale, "这些登记项已经没有对应的重名了 —— 过期例外会让守卫悄悄失效").toEqual([]);
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

/**
 * 012 是一个**重建表**的迁移 —— 这类迁移的失败方式全是静默的:
 *   - 重建时漏掉数据 → 消息没了,不报错
 *   - 重建时漏掉索引 → 索引没了,不报错(DROP TABLE 会连索引一起丢)
 *   - 「唯一」约束写错 → 约束形同虚设,不报错
 * 所以这里把三件事都钉住:数据、索引、唯一性。
 */
describe("012 接待会话重建(静默失败的三处守卫)", () => {
  async function upTo011Then012() {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version >= 12) break;
      try {
        db.exec(f.sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        throw err;
      }
    }
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('bm','business_manager',NULL,'业务经理',1)`);
    for (const p of ["pj_1", "pj_2"]) {
      db.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
               VALUES ('${p}','${p}','甲方','目标','active',1)`);
      db.exec(`INSERT INTO project_sessions (id,project_id,created_at) VALUES ('s_${p}','${p}',1)`);
      db.exec(`INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
               VALUES ('m_${p}','s_${p}',NULL,'user','甲方说的话',1)`);
      db.exec(`INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
               VALUES ('m_${p}_a','s_${p}','bm','assistant','业务经理说的话',2)`);
    }
    const m12 = FILES.find((f) => f.version === 12);
    expect(m12, "012 迁移文件缺失").toBeDefined();
    db.exec(m12!.sql);
    return db;
  }

  it("重建不吃数据:会话行与消息一条不少,外键无悬空", async () => {
    const db = await upTo011Then012();
    const sessions = db.prepare(`SELECT COUNT(*) n FROM project_sessions`).get() as { n: number };
    const messages = db.prepare(`SELECT COUNT(*) n FROM session_messages`).get() as { n: number };
    expect(sessions.n).toBe(2);
    expect(messages.n).toBe(4);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(
      db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%\\_backup' ESCAPE '\\'`).get(),
    ).toEqual({ n: 0 });
    db.close();
  });

  it("重建不吃索引:009 的 idx_project_sessions_project 被原样重建", async () => {
    const db = await upTo011Then012();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as
      Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain("idx_project_sessions_project");
    expect(names).toContain("idx_session_single_intake");
    db.close();
  });

  it("接待会话全局唯一,但「一个项目多条会话」不受影响", async () => {
    const db = await upTo011Then012();
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at) VALUES ('s_intake',NULL,9)`);
    expect(() =>
      db.exec(`INSERT INTO project_sessions (id,project_id,created_at) VALUES ('s_intake2',NULL,10)`),
    ).toThrow(/UNIQUE/i);
    // 同一项目再来两条会话必须仍然合法(部分索引不该误伤非空行)
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at) VALUES ('s_pj1_b','pj_1',11)`);
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at) VALUES ('s_pj1_c','pj_1',12)`);
    const n = db.prepare(`SELECT COUNT(*) n FROM project_sessions WHERE project_id='pj_1'`).get() as { n: number };
    expect(n.n).toBe(3);
    db.close();
  });
});

