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
import { DISPATCH_EVENT_KINDS } from "../../src/platform/storage/repo/dispatch.js";

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
  {
    table: "dispatch_events",
    files: ["013_dispatch_state.sql", "015_dispatch_event_kinds.sql"],
    why:
      "015 把 kind 的 CHECK 闭集从 4 个取值放宽到 5 个(加 work_cancelled —— 「取消」是" +
      "下游悬空的来源,业务经理与质检都该知道)。SQLite 改不了已有 CHECK 的表达式," +
      "而 ALTER TABLE ADD CONSTRAINT 只能**收紧**(实测:拿去放宽会无错应用而约束一个字节没变," +
      "见 015 文件头),所以只能重建表;重建前后表名必须相同(代码与全部查询都按这个名字引用它)",
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


/**
 * 013 是**纯加法**(一个 ADD COLUMN + 两张新表),但「纯加法」这句话必须被验,
 * 不能被相信 —— 批次 18 的事故正是一份看起来无害的 migration 静默删光了全部
 * 会话消息(DROP TABLE 级联,`foreign_key_check` 一声不响)。
 *
 * 另外 `ALTER TABLE ... ADD COLUMN ... CHECK` 在 SQLite 上是否真的接受、
 * CHECK 是否真的在拦,都不是注释能保证的事,所以这里逐条钉住。
 */
describe("013 排空器状态(一个 ADD COLUMN + 两张新表)", () => {
  async function upTo012Then013() {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version >= 13) break;
      try {
        db.exec(f.sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        throw err;
      }
    }
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('wk','worker','engineering','工人',1)`);
    db.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
             VALUES ('pj_1','语音机器人调研','甲方','目标','active',1)`);
    db.exec(`INSERT INTO project_assignments (project_id,agent_id,added_at) VALUES ('pj_1','wk',1)`);
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at) VALUES ('s_1','pj_1',1)`);
    db.exec(`INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
             VALUES ('m_1','s_1',NULL,'user','甲方说的话',1)`);
    db.exec(`INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
             VALUES ('m_2','s_1','wk','assistant','工人说的话',2)`);
    db.exec(`INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
             VALUES ('w_open','pj_1',NULL,'在跑','g','open','wk',1,1)`);
    db.exec(`INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
             VALUES ('w_done','pj_1',NULL,'已完成','g','done','wk',1,1)`);
    db.exec(`INSERT INTO artifacts (id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at)
             VALUES ('a_1','pj_1',NULL,'evidence','open','wk','证据','现场',NULL,1,1)`);
    const m13 = FILES.find((f) => f.version === 13);
    expect(m13, "013 迁移文件缺失").toBeDefined();
    db.exec(m13!.sql);
    return db;
  }

  it("不吃数据:消息 / 工作项 / 工件的行数与正文一字不少,外键无悬空", async () => {
    const db = await upTo012Then013();
    const count = (t: string) =>
      (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    expect(count("session_messages")).toBe(2);
    expect(count("project_sessions")).toBe(1);
    expect(count("works")).toBe(2);
    expect(count("artifacts")).toBe(1);
    expect(
      (db.prepare(`SELECT group_concat(content,'|') t FROM session_messages`).get() as { t: string }).t,
    ).toBe("甲方说的话|工人说的话");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")[0]).toEqual({ integrity_check: "ok" });
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%\\_backup' ESCAPE '\\'`).get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it("新列与新表就位:review_state / dispatch_events / dispatch_attempts / 部分索引", async () => {
    const db = await upTo012Then013();
    const cols = (db.prepare(`PRAGMA table_info(works)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toContain("review_state");
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM works WHERE review_state = 'none'`).get() as { n: number }).n,
    ).toBe(2);
    for (const t of ["dispatch_events", "dispatch_attempts"]) {
      expect(
        (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?`).get(t) as { n: number }).n,
        `${t} 没建出来`,
      ).toBe(1);
    }
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_works_pending_review'`).get() as { n: number }).n,
    ).toBe(1);
    db.close();
  });

  it("已有的 done 工作项**不会**被凭空判成「等着审」(默认 none,不制造唤醒风暴)", async () => {
    const db = await upTo012Then013();
    const r = db.prepare(`SELECT review_state s FROM works WHERE id='w_done'`).get() as { s: string };
    expect(r.s).toBe("none");
    db.close();
  });

  it("两个 CHECK 真的在拦(review_state 与 dispatch_events.kind)", async () => {
    const db = await upTo012Then013();
    expect(() => db.exec(`UPDATE works SET review_state='whatever' WHERE id='w_open'`))
      .toThrow(/CHECK/i);
    expect(() =>
      db.exec(`INSERT INTO dispatch_events (project_id,kind,subject_id,summary,created_at)
               VALUES ('pj_1','work_exploded','w_open','x',1)`),
    ).toThrow(/CHECK/i);
    db.close();
  });

  it("dispatch_events 的 seq 单调自增(它是「这批事件的版本号」)", async () => {
    const db = await upTo012Then013();
    db.exec(`INSERT INTO dispatch_events (project_id,kind,subject_id,summary,created_at)
             VALUES ('pj_1','work_done','w_done','「已完成」已完成',1)`);
    db.exec(`INSERT INTO dispatch_events (project_id,kind,subject_id,summary,created_at)
             VALUES ('pj_1','work_blocked','w_open','「在跑」受阻',2)`);
    const seqs = (db.prepare(`SELECT seq FROM dispatch_events ORDER BY seq`).all() as Array<{ seq: number }>)
      .map((r) => r.seq);
    expect(seqs).toEqual([1, 2]);
    db.close();
  });
});

/**
 * 014 是**纯加法**(一个 ADD COLUMN + 一条部分索引),纯到**不需要登记任何例外**
 * —— 它不建表,所以没有 `CREATE TABLE IF NOT EXISTS` 撞名的面;它不 DROP,
 * 所以没有批次 18 那条静默删数据的路。
 *
 * 但它的两条设计选择各自对着一次真实事故,都不能靠注释保证:
 *   - `ON DELETE SET NULL` 而不是 `CASCADE` —— 用 CASCADE 就是「删工作项 = 删产出」,
 *     而工件是审计面,必须比产生它的东西活得久;
 *   - 部分索引而不是全表索引 —— 多数工件的 work_id 是 NULL。
 * 所以这里钉住:文件形态、列的可空性与外键动作、旧行不受影响、删工作项不删产出。
 */
describe("014 产出边(纯 ADD COLUMN + 部分索引)", () => {
  async function upTo013Then014(apply14 = true) {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version >= 14) break;
      try {
        db.exec(f.sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        throw err;
      }
    }
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('wk','worker','engineering','工人',1)`);
    db.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
             VALUES ('pj_1','语音机器人调研','甲方','目标','active',1)`);
    db.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
             VALUES ('pj_2','另一个项目','甲方','目标','active',1)`);
    db.exec(`INSERT INTO project_assignments (project_id,agent_id,added_at) VALUES ('pj_1','wk',1)`);
    db.exec(`INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
             VALUES ('w_1','pj_1',NULL,'做','g','in_progress','wk',1,1)`);
    db.exec(`INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
             VALUES ('w_2','pj_2',NULL,'别人家的','g','open','wk',1,1)`);
    // 014 之前就存在的工件(要逐字活下来)
    db.exec(`INSERT INTO artifacts (id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at)
             VALUES ('a_old','pj_1',NULL,'evidence','open','wk','旧证据','现场','{"k":1}',1,1)`);
    const m14 = FILES.find((f) => f.version === 14);
    expect(m14, "014 迁移文件缺失").toBeDefined();
    if (apply14) db.exec(m14!.sql);
    return db;
  }

  it("迁移文件是纯加法:一行 DROP 都没有,也没有 CREATE TABLE(撞名面为零)", () => {
    const m14 = FILES.find((f) => f.version === 14);
    expect(m14, "014 迁移文件缺失").toBeDefined();
    expect(stripSqlComments(m14!.sql)).not.toMatch(/\bDROP\b/i);
    expect(createdTables(m14!.sql)).toEqual([]);
  });

  it("列就位且**可空 / 无 DEFAULT**(不传 workId 是合法状态,不是缺参数)", async () => {
    const colOf = (d: Awaited<ReturnType<typeof upTo013Then014>>) =>
      (d.prepare(`PRAGMA table_info(artifacts)`).all() as Array<{
        name: string; type: string; notnull: number; dflt_value: unknown;
      }>).find((c) => c.name === "work_id");

    // 负样本:014 之前这一列不存在(证明下面的断言不是恒真)
    const before = await upTo013Then014(false);
    expect(colOf(before)).toBeUndefined();
    before.close();

    const db = await upTo013Then014();
    const col = colOf(db);
    expect(col, "artifacts.work_id 没建出来").toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    db.close();
  });

  it("外键是 works(id) 且动作为 **SET NULL** —— 不是 CASCADE、也不是 RESTRICT", async () => {
    const db = await upTo013Then014();
    const fks = (db.prepare(`PRAGMA foreign_key_list(artifacts)`).all() as Array<{
      table: string; from: string; to: string; on_delete: string;
    }>).filter((k) => k.from === "work_id");
    expect(fks).toEqual([
      expect.objectContaining({ table: "works", to: "id", on_delete: "SET NULL" }),
    ]);
    // 悬空 work_id 真的被拦(负样本:外键不是摆设)
    expect(() =>
      db.exec(`INSERT INTO artifacts (id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at,work_id)
               VALUES ('a_ghost','pj_1',NULL,'note','open','wk','孤儿','b',NULL,2,2,'w_ghost')`),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  it("部分索引就位:idx_artifacts_work 带 WHERE work_id IS NOT NULL", async () => {
    const db = await upTo013Then014();
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_artifacts_work'`)
      .get() as { sql: string } | undefined;
    expect(row, "idx_artifacts_work 没建出来").toBeDefined();
    expect(row!.sql).toMatch(/WHERE\s+work_id\s+IS\s+NOT\s+NULL/i);
    db.close();
  });

  it("旧行逐字不变、一条不少;删工作项**不删产出**(SET NULL 不是 CASCADE)", async () => {
    const db = await upTo013Then014();
    const before = db.prepare(`SELECT * FROM artifacts WHERE id='a_old'`).get();
    expect(before).toEqual({
      id: "a_old", project_id: "pj_1", conversation_id: null, kind: "evidence", status: "open",
      author_agent_id: "wk", title: "旧证据", body: "现场", metadata_json: '{"k":1}',
      created_at: 1, updated_at: 1, work_id: null,
    });

    db.exec(`UPDATE artifacts SET work_id='w_1' WHERE id='a_old'`);
    db.exec(`DELETE FROM works WHERE id='w_1'`);
    const after = db.prepare(`SELECT * FROM artifacts WHERE id='a_old'`).get();
    expect(after, "删工作项把产出一起删了 —— 这是 CASCADE 的形态,不是本迁移的语义").toEqual({
      ...(before as Record<string, unknown>), work_id: null,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")[0]).toEqual({ integrity_check: "ok" });
    db.close();
  });
});

/**
 * 015 是**重建表**的迁移 —— 与 012 同一类,失败方式也全是静默的:
 *
 *   - `DROP TABLE` 若命中一张**被引用**的表,会级联删掉子表的行(012 实测:删光了
 *     全部 `session_messages`),而 `foreign_key_check` 一声不响;
 *   - `DROP TABLE` 会连表上的索引一起丢掉,不报错;
 *   - `AUTOINCREMENT` 的 `sqlite_sequence` 记账会被抹掉,于是「版本号」可能回退;
 *   - 拿 `ALTER TABLE ... ADD CONSTRAINT` 去「放宽」会**无错应用而约束一个字节没变**。
 *
 * 所以这里把「前提 + 结果」逐条钉住,并且每条都带一个**已知答案**的样本自检
 * (AGENTS.md §三类静默失败:一个坏掉的检查不等于「检查失败」)。
 *
 * ── 裁决:`work_reopened` **不加**(这条裁决存档在这里)────────────────
 *
 * 设计 §12 #9 的出路 (b)(`done → in_progress` 退回时写一条「先前那次交代作废」
 * 的事件)需要新 kind,而「每加一个 kind 都要重建一次表」——看起来应该一次加够。
 * **没有加**,理由四条:
 *
 *   1. **死枚举**:全仓没有写出方(`repo/works.ts` 的 `EVENT_KIND` 只有
 *      done / failed / blocked / cancelled —— 本迁移不改 `repo/works.ts`,
 *      这正是 Wave 1 的设计)。把没有写者的取值放进 CHECK,等于让 schema 说
 *      一句假话「本系统会发出这种事件」;与「代码写了但没有读者」同构,只是方向
 *      反过来:**schema 开了口,但没有写者**。
 *   2. **省下的那次重建可能是假的**:§12 #9(b) 要的是「让甲方知道先前那次交代
 *      作废」,而 outbox 现在的列只有 `subject_id`(工作项 id 或阻塞 id),**没有
 *      任何字段能指向前一条事件**。真要实现 (b),多半还要动列 —— 那时照样得
 *      重建表,预先塞一个 kind **省不掉任何东西**。
 *   3. **代价不对称**:`dispatch_events` 没有子表引用(见下面「重建前提」那条)、
 *      只有一条部分索引,重建成本极低(012 那次贵,是因为 `project_sessions`
 *      有级联子表);而一个无写者的取值会**永久**留在闭集里误导读者,并让
 *      「闭集里每个取值都真的会被写出来」这条不变量永久变假。
 *   4. §12 #9 至今**未决**(文档原文只说「(b) 更贴合真实工作流」)。为一个尚未
 *      裁决的分支先占位,等于把一个没做的决定固化进 schema。
 *
 * 将来真要 (b):照 015 再走一次重建 + 登记进 `INTENTIONAL_REBUILDS`。
 * 下面「闭集与代码同步」那条用例会在加常量而忘加迁移时先红。
 */
describe("015 放宽 dispatch_events.kind(重建表:012 那类静默失败)", () => {
  /**
   * 到 014 为止的真 schema。**015 不在里面** —— 每个用例显式决定应不应用它,
   * 因为「之前」与「之后」两个方向都要有牙地测(负样本靠「之前」)。
   */
  async function upTo014() {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version >= 15) break;
      try {
        db.exec(f.sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        throw err;
      }
    }
    for (const [id, role, spec, name] of [
      ["bm", "business_manager", null, "业务经理"],
      ["wk", "worker", "engineering", "工人"],
    ] as ReadonlyArray<[string, string, string | null, string]>) {
      db.prepare(
        `INSERT INTO agents (id,role,specialization,display_name,created_at) VALUES (?,?,?,?,1)`,
      ).run(id, role, spec, name);
    }
    for (const p of ["pj_1", "pj_2"]) {
      db.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
               VALUES ('${p}','项目${p}','甲方','目标','active',1)`);
    }
    // 四行旧事件:两种 consumed 形态 + 中文 / 引号 / 反斜杠
    // (逐字对比要能看出正文被动过 —— 所以样本里必须有不平凡的字符)
    const events: ReadonlyArray<
      readonly [string, string, string, string, number, number | null, string | null]
    > = [
      ["pj_1", "work_done", "w_1", "「完成」已完成", 11, null, null],
      ["pj_1", "work_failed", "w_2", '「失败」带"引号"与\\反斜杠', 12, 99, "bm"],
      ["pj_1", "work_blocked", "w_3", "「受阻」中文正文", 13, null, null],
      ["pj_2", "blocker_opened", "b_1", "阻塞开了", 14, 100, "bm"],
    ];
    for (const e of events) {
      db.prepare(
        `INSERT INTO dispatch_events (project_id,kind,subject_id,summary,created_at,consumed_at,consumed_by)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(...e);
    }
    db.exec(`INSERT INTO dispatch_attempts
               (project_id,todo_key,attempts,target_state,first_attempt_at,last_attempt_at,notified_at)
             VALUES ('pj_1','execute_work:w_1',2,111,5,6,NULL)`);
    db.exec(`INSERT INTO dispatch_attempts
               (project_id,todo_key,attempts,target_state,first_attempt_at,last_attempt_at,notified_at)
             VALUES ('pj_1','answer_ask:a_1',3,NULL,7,8,9)`);
    return db;
  }

  function migration015() {
    const m15 = FILES.find((f) => f.version === 15);
    expect(m15, "015 迁移文件缺失").toBeDefined();
    return m15!;
  }

  function apply015(db: Awaited<ReturnType<typeof upTo014>>): void {
    db.exec(migration015().sql);
  }

  /** 一个必然命中的 kind 闭集探测器:只认 `kind TEXT NOT NULL CHECK (kind IN (...))` */
  function kindsInSchema(db: Awaited<ReturnType<typeof upTo014>>): string[] {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='dispatch_events'`)
      .get() as { sql: string } | undefined;
    expect(row, "dispatch_events 表不存在").toBeDefined();
    const m = row!.sql.match(
      /kind\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/i,
    );
    expect(m, "没在表定义里找到 kind 的 CHECK 闭集(正则写歪了?)").not.toBeNull();
    return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  }

  function insertKind(db: Awaited<ReturnType<typeof upTo014>>, kind: string): void {
    db.prepare(
      `INSERT INTO dispatch_events (project_id,kind,subject_id,summary,created_at)
       VALUES ('pj_1',?,?,?,1)`,
    ).run(kind, "s", "x");
  }

  it("**负样本**:015 之前 work_cancelled 必须被拒(证明下一条断言有牙)", async () => {
    const db = await upTo014();
    expect(() => insertKind(db, "work_cancelled"), "schema 里居然已经有它 —— 这条就没牙了")
      .toThrow(/CHECK/i);
    // 正样本:同一个探针在合法取值上不报错(否则上一条可能是「什么都拒」)
    expect(() => insertKind(db, "work_done")).not.toThrow();
    expect(kindsInSchema(db)).toHaveLength(4);
    db.close();
  });

  it("015 之后:work_cancelled 真的落库;旧 4 个取值仍可用;未知取值仍被拒", async () => {
    const db = await upTo014();
    apply015(db);
    expect(() => insertKind(db, "work_cancelled")).not.toThrow();
    for (const k of ["work_done", "work_failed", "work_blocked", "blocker_opened"]) {
      expect(() => insertKind(db, k), `${k} 被误伤`).not.toThrow();
    }
    // 负样本两条:CHECK 只是放宽了一个取值,不是被拆掉
    expect(() => insertKind(db, "work_exploded")).toThrow(/CHECK/i);
    expect(
      () => insertKind(db, "work_reopened"),
      "本次裁决**不加**这个 kind —— 它必须仍然被拒(理由见本 describe 头)",
    ).toThrow(/CHECK/i);
    db.close();
  });

  it("闭集与代码同步:015 之后的 kind 列表**恰好等于** DISPATCH_EVENT_KINDS", async () => {
    const db = await upTo014();
    apply015(db);
    expect(
      kindsInSchema(db),
      "schema 的闭集与 repo/dispatch.ts 的 DISPATCH_EVENT_KINDS 不同步" +
        "(加了常量却忘了加迁移,或迁移加了而常量没加)",
    ).toEqual([...DISPATCH_EVENT_KINDS]);
    db.close();
  });

  it("重建不吃数据:行数一条不少、内容逐字不变;attempts 不受影响;检查干净", async () => {
    const db = await upTo014();
    const snap = () => ({
      events: db.prepare(`SELECT * FROM dispatch_events ORDER BY seq`).all(),
      seqs: (db.prepare(`SELECT seq FROM dispatch_events ORDER BY seq`).all() as
        Array<{ seq: number }>).map((r) => r.seq),
      attempts: db.prepare(`SELECT * FROM dispatch_attempts ORDER BY project_id,todo_key`).all(),
      objects: db.prepare(
        `SELECT type,name FROM sqlite_master WHERE tbl_name='dispatch_events' ORDER BY type,name`,
      ).all(),
      fks: db.pragma("foreign_key_list(dispatch_events)"),
      autoinc: db.prepare(`SELECT * FROM sqlite_sequence WHERE name='dispatch_events'`).all(),
      tableSql: (db.prepare(`SELECT sql FROM sqlite_master WHERE name='dispatch_events'`)
        .get() as { sql: string }).sql,
    });
    const before = snap();
    // 前置:样本非空 —— 否则下面的「相等」是空的(一个坏掉的检查)
    expect(before.events).toHaveLength(4);
    expect(before.attempts).toHaveLength(2);
    expect(before.objects.length).toBeGreaterThan(0);
    expect(before.autoinc).toHaveLength(1);

    apply015(db);
    const after = snap();

    expect(after.events, "重建后事件行变了 —— 这是 012 那类静默数据事故").toEqual(before.events);
    expect(after.seqs, "seq(这批事件的版本号)变了").toEqual(before.seqs);
    expect(after.attempts, "dispatch_attempts 受到了重建的影响").toEqual(before.attempts);
    expect(after.fks, "外键(projects CASCADE / agents)没原样保留").toEqual(before.fks);
    expect(after.objects, "表上的对象(索引)集合变了").toEqual(before.objects);
    expect(after.autoinc, "AUTOINCREMENT 记账被抹掉了 —— 版本号会回退").toEqual(before.autoinc);
    // 正控制:schema 必须**真的**变了,否则上面那些「不变」可能只是 015 什么都没做
    expect(after.tableSql, "schema 没变 —— 015 什么都没做").not.toBe(before.tableSql);

    expect(
      (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%\\_backup' ESCAPE '\\'`)
        .get() as { n: number }).n,
      "中转备份表残留了(迁移没跑完或忘了 DROP)",
    ).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")[0]).toEqual({ integrity_check: "ok" });
    db.close();
  });

  it("被 DROP 掉的索引真的重建了,而且是同一条**部分索引**(谓词不能丢)", async () => {
    const db = await upTo014();
    const indexOf = (d: Awaited<ReturnType<typeof upTo014>>) =>
      d.prepare(`SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='dispatch_events'`)
        .all() as Array<{ name: string; sql: string }>;
    const before = indexOf(db);
    expect(before.map((i) => i.name), "015 之前的样本索引不对 —— 这条断言会失去意义")
      .toEqual(["idx_dispatch_events_pending"]);

    apply015(db);
    const after = indexOf(db);
    expect(after.map((i) => i.name), "DROP TABLE 把索引一起带走了,而 015 没有重建它").toEqual(
      before.map((i) => i.name),
    );
    expect(after[0]!.sql, "重建出来了,但不再是部分索引(谓词丢了 = 静默的语义漂移)").toMatch(
      /WHERE\s+consumed_at\s+IS\s+NULL/i,
    );
    expect(after[0]!.sql).toMatch(/ON\s+dispatch_events\s*\(\s*project_id\s*,\s*created_at\s*\)/i);
    db.close();
  });

  it("**重建前提**:没有任何表引用 dispatch_events(否则 DROP 会静默级联删掉子表的行)", async () => {
    const db = await upTo014();
    apply015(db);
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);
    const referenced = new Set<string>();
    for (const t of tables) {
      for (const fk of db.pragma(`foreign_key_list(${t})`) as Array<{ table: string }>) {
        referenced.add(fk.table);
      }
    }
    // 正样本:探测器真的看得见外键(projects / agents 明明被一大票表引用)
    expect(referenced.has("projects"), "探测器坏了:projects 明明被多张表引用").toBe(true);
    expect(referenced.has("agents"), "探测器坏了:agents 明明被多张表引用").toBe(true);
    // 被测事实
    const children = [...referenced].filter((t) => t === "dispatch_events");
    expect(
      children,
      "有表引用了 dispatch_events —— 015 的 DROP TABLE 会隐式 DELETE 并级联删掉那张子表的行," +
        "(012 就是这样删光 session_messages 的),而 foreign_key_check 不会响。" +
        "加子表的那笔迁移必须同时改掉 015 的重建方式(先把子表内容移出去再灌回),并更新本用例。",
    ).toEqual([]);
    db.close();
  });

  it("迁移文件形态:重建表(不是 ALTER),且关键语句不带 IF NOT EXISTS(要响亮不要静默)", () => {
    const body = stripSqlComments(migration015().sql);
    // 一行 ALTER 都没有:ADD CONSTRAINT 只能收紧,拿它放宽是「无错而无效」(见文件头实测)
    expect(body, "015 里出现了 ALTER TABLE —— 那条路只能收紧,放宽会静默无效").not.toMatch(
      /\bALTER\s+TABLE\b/i,
    );
    expect(body, "重建路径上不能有 IF NOT EXISTS:撞名时它会静默无操作(批次 5 的事故形态)")
      .not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(body, "015 没有 DROP 旧表 —— 那它就不是重建").toMatch(/\bDROP\s+TABLE\s+dispatch_events\b/i);
    expect(body, "015 没有重建那条部分索引(DROP TABLE 会静默丢掉它)").toMatch(
      /CREATE\s+INDEX\s+idx_dispatch_events_pending/i,
    );
    expect(createdTables(migration015().sql)).toContain("dispatch_events");
  });
});
