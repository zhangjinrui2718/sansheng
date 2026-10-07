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
import { ARTIFACT_KINDS } from "../../src/platform/identity/role.js";

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
  {
    table: "artifacts",
    files: ["008_blackboard_change.sql", "016_artifacts_deliverable.sql", "026_worker_split_and_code_service.sql", "027_artifact_body_files.sql"],
    why:
      "016 把 kind 的 CHECK 闭集从 10 个取值放宽到 11 个(加 deliverable —— 设计 1 §2.11.5:" +
      "「整合完没有 / 交付了没有」由 deliverable 工件的存在性表达)。同 015:SQLite 改不了已有 " +
      "CHECK 的表达式,ADD CONSTRAINT 只能收紧(016 文件头有独立复核),所以只能重建表。" +
      "⚠️ 本表与 dispatch_events 有两处关键不同,两处都在 016 里显式处置:" +
      "(1) 它**有子表**:artifact_links 两条 ON DELETE CASCADE + asks.resolution_artifact_id 一条 " +
      "NO ACTION —— 朴素重建会静默清空 artifact_links(实测 1 → 0,foreign_key_check 一声不响)," +
      "所以必须先备份子表再灌回;asks 那条 NO ACTION 会让 DROP 响亮失败,所以先置 NULL 再回填。" +
      "(2) 它有 **6** 条索引(008 五条 + 014 的 idx_artifacts_work),DROP TABLE 会全部带走;" +
      "新表还必须带上 014 的 work_id 列(用户真机库 11 条工件里 10 条 work_id 非空)。" +
      "⚠️ 026 **又重建了一次**(交付物类型闭集加 code_service)—— 同一条理由(SQLite 改不了 CHECK)," +
      "而这次多了一个 016 没遇到的坑:**025 注释里那份子表清单是错的**,漏了 client_questions ×2 " +
      "与 review_verdicts ×1 三条外键。`DROP TABLE artifacts` 会**级联清空整张 client_questions**" +
      "(待答台账),而 foreign_key_check 一声不响。判据是**动态的**:`PRAGMA foreign_key_list(<每张表>)`," +
      "不是 `grep -rn 'REFERENCES artifacts' migrations/`(那只数历史文件里的行)。" +
      "⚠️ 027 **第三次重建**(工件正文从 `body` 一列搬去文件,落点四列;设计-DESIGN-WORKSPACE §4.1 / §5)。" +
      "SQLite 没有 ALTER COLUMN,而 `ADD COLUMN body_path TEXT NOT NULL` 在有存量行时也装不上" +
      "(NOT NULL 要每一行都有值)。**这次与前两次的关键不同是没有数据要搬**(输入 6:存量数据全不要)," +
      "所以没有 `_backup` 中转表、没有 `INSERT … SELECT`;取而代之的是第 1 步一条**会响的前置检查**" +
      "(`CHECK (n = 0)`):非空库上迁移响亮失败并整体回滚,而不是静默清空 artifacts 与它的 CASCADE 子表",
  },
  {
    table: "agents",
    files: ["007_platform_core.sql", "026_worker_split_and_code_service.sql"],
    why:
      "026 把 role 的 CHECK 闭集从 4 个取值放宽到 5 个(worker 改名 research_worker + 新增 coding_worker," +
      "并同步放宽了 `agents_spec_only_worker` 触发器的判据)。SQLite 改不了已有 CHECK,只能重建表。" +
      "⚠️ 本表的失败形态与 artifacts 不同,026 文件头有完整实测:它被 **15 条**外键指着,其中" +
      "**只有 project_assignments 一条是 CASCADE**(动态核对:`PRAGMA foreign_key_list`;静态 grep 会数出 16," +
      "因为 016/015 重建过的表会被数两次)。所以处置是 `PRAGMA defer_foreign_keys = ON`" +
      "(唯一能在事务里生效的放宽手段,`PRAGMA foreign_keys` 在事务内是 no-op)+ 备份那一条 CASCADE 子表。" +
      "⚠️ 另一条路「改名 agents_old → 建新表 → DROP agents_old」**看起来最干净、实测最危险**:" +
      "数据少时它不报错而**静默清空 project_assignments**(foreign_key_check 干净)," +
      "数据多时同一套 SQL 才响亮失败 —— 「在我机器上它报错了」不可移植",
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

/**
 * 016 是**重建表**的迁移,而且是本仓**唯一**一张「重建一张带 `ON DELETE CASCADE`
 * 子表的表」—— 012 是同一个形态,而它已经删光过一次全部 `session_messages`。
 *
 * 它的失败方式全在暗处,这次实测到的有**四处**(每一条都在下面被钉住):
 *   1. 朴素重建「建 _new → 拷 → DROP 旧的 → 改名」会**静默清空** `artifact_links`
 *      (实测 1 → 0,而 `foreign_key_check` 一声不响 —— 用户真机库今天
 *      `artifact_links = 0`,所以这条在真机上连行数变化都看不出来);
 *   2. `DROP TABLE` 会连表上的索引一起丢掉,本次丢 **6** 条 ——
 *      **不是设计稿 §2.11.5 写的 5 条**(014 又加了 `idx_artifacts_work`);
 *   3. 新表若照 008 抄列清单,会漏掉 014 的 `work_id` —— 用户真机库实测
 *      **11 条工件里 10 条 `work_id` 非空**;同一条 recipe 还让
 *      `idx_artifacts_work` 消失(设计稿字面 recipe 的复现在下面第 5 组);
 *   4. `ALTER TABLE ... ADD CONSTRAINT` 拿去放宽会**无错应用而约束一字节没变**。
 *
 * 核对方式沿用 015 那套:静态(文件形态)+ 动态(真 schema + `foreign_keys = ON`),
 * 每一组都带一个**已知答案**的样本自检 —— 一个必须命中的正样本 + 一个必须不命中的
 * 负样本(AGENTS.md §三类静默失败:一个坏掉的检查不等于「检查失败」)。
 */
describe("016 放宽 artifacts.kind(重建表:两条 CASCADE 子表 + 一条 NO ACTION)", () => {
  const ART_COLS = ["id", "project_id", "conversation_id", "kind", "status", "author_agent_id",
    "title", "body", "metadata_json", "created_at", "updated_at", "work_id"] as const;
  const KINDS_015 = ["decision", "note", "evidence", "hypothesis", "project_brief",
    "work_brief", "meeting_note", "review_finding", "change_record", "client_question"] as const;

  /**
   * 到 015 为止的真 schema。**016 不在里面** —— 每个用例显式决定应不应用它,
   * 因为「之前」与「之后」两个方向都要有牙地测(负样本靠「之前」)。
   */
  async function upTo015(opts: { answeredAsk?: boolean; link?: boolean } = {}) {
    const answeredAsk = opts.answeredAsk ?? true;
    const link = opts.link ?? true;
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version >= 16) break;
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
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('bm','business_manager',NULL,'业务经理',1)`);
    db.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
             VALUES ('pj_1','语音机器人调研','甲方','目标','active',1)`);
    db.exec(`INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
             VALUES ('w_1','pj_1',NULL,'做','g','in_progress','wk',1,1)`);
    // 两条工件:一条有产出边(work_id),一条没有。
    // 正文带中文 / 引号 / 反斜杠 —— 逐字对比要能看出正文被动过。
    db.exec(`INSERT INTO artifacts (${ART_COLS.join(",")})
             VALUES ('a_1','pj_1','conv-1','evidence','open','wk','证据','现场 "引号" \\反斜杠 中文','{"k":1}',11,12,'w_1')`);
    db.exec(`INSERT INTO artifacts (${ART_COLS.join(",")})
             VALUES ('a_2','pj_1',NULL,'decision','accepted','bm','决策','正文二',NULL,13,14,NULL)`);
    if (link) {
      db.exec(`INSERT INTO artifact_links (artifact_id,rel,target_artifact_id) VALUES ('a_1','answers','a_2')`);
    }
    db.exec(`INSERT INTO asks (id,project_id,from_agent_id,to_agent_id,parent_ask_id,question,hypothesis,
                               options_json,needs,status,created_at,deadline_at,resolved_at,resolution_artifact_id)
             VALUES ('q_1','pj_1','bm','wk',NULL,'这条决策依据是什么?','假设:证据 a_1',NULL,NULL,'answered',21,NULL,22,
                     ${answeredAsk ? "'a_2'" : "NULL"})`);
    db.exec(`INSERT INTO asks (id,project_id,from_agent_id,to_agent_id,parent_ask_id,question,hypothesis,
                               options_json,needs,status,created_at,deadline_at,resolved_at,resolution_artifact_id)
             VALUES ('q_2','pj_1','bm','wk',NULL,'还没答的问','假设二',NULL,NULL,'open',23,NULL,NULL,NULL)`);
    return db;
  }

  type Db = Awaited<ReturnType<typeof upTo015>>;

  function migration016() {
    const m16 = FILES.find((f) => f.version === 16);
    expect(m16, "016 迁移文件缺失").toBeDefined();
    return m16!;
  }

  function apply016(db: Db): void {
    db.exec(migration016().sql);
  }

  /** 必然命中的 kind 闭集探测器:只认 `kind TEXT NOT NULL CHECK (kind IN (...))` */
  function kindsInSchema(db: Db): string[] {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'`)
      .get() as { sql: string } | undefined;
    expect(row, "artifacts 表不存在").toBeDefined();
    const m = row!.sql.match(/kind\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*kind\s+IN\s*\(([^)]*)\)/i);
    expect(m, "没在表定义里找到 kind 的 CHECK 闭集(正则写歪了?)").not.toBeNull();
    return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
  }

  function insertKind(db: Db, id: string, kind: string): void {
    db.prepare(
      `INSERT INTO artifacts (${ART_COLS.join(",")}) VALUES (?,?,NULL,?,'open','wk',?,?,NULL,1,1,NULL)`,
    ).run(id, "pj_1", kind, "t", "b");
  }

  /**
   * 索引的**语义**签名。
   *
   * ⚠️ 不能拿 `sqlite_master.sql` 做「逐字不变」:索引是被 016 **新写一条
   * CREATE INDEX** 建出来的,存储的 DDL 文本必然与 008/014 那条不同(008 带
   * `IF NOT EXISTS`、空格数也不同)。文本相等做不到,拿它当判据只会得到一条
   * **永远红**的假断言 —— 一个坏掉的检查。真正要守的是:
   * 名字 / 唯一性 / 部分性 / 列与次序 / DESC / 谓词。
   */
  function indexSig(db: Db) {
    return (db.pragma("index_list(artifacts)") as Array<{
      name: string; unique: number; origin: string; partial: number;
    }>)
      .filter((r) => !r.name.startsWith("sqlite_autoindex"))
      .map((r) => {
        const xinfo = (db.pragma(`index_xinfo(${r.name})`) as Array<{
          seqno: number; name: string | null; desc: number; key: number;
        }>).map((x) => ({ seqno: x.seqno, name: x.name, desc: x.desc, key: x.key }));
        const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
          .get(r.name) as { sql: string } | undefined)?.sql ?? "";
        const w = sql.match(/WHERE\s+([\s\S]+)$/i);
        return {
          name: r.name, unique: r.unique, origin: r.origin, partial: r.partial,
          xinfo, where: w ? w[1]!.replace(/\s+/g, " ").trim() : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 列结构签名(列名 / 类型 / NOT NULL / DEFAULT / 主键位次) */
  function tableSig(db: Db) {
    return (db.pragma("table_info(artifacts)") as Array<{
      name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
    }>).map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }));
  }

  function snapshot(db: Db) {
    return {
      artifacts: db.prepare(`SELECT * FROM artifacts ORDER BY id`).all(),
      links: db.prepare(`SELECT * FROM artifact_links ORDER BY artifact_id,rel,target_artifact_id`).all(),
      asks: db.prepare(`SELECT * FROM asks ORDER BY id`).all(),
      idx: indexSig(db),
      cols: tableSig(db),
      fks: db.pragma("foreign_key_list(artifacts)"),
      tableSql: (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'`)
        .get() as { sql: string }).sql,
    };
  }

  function backupTables(db: Db): number {
    return (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%\\_backup' ESCAPE '\\'`)
      .get() as { n: number }).n;
  }

  /** 015 在 dispatch_events 上用的那套朴素重建;列清单是完整的,所以 work_id 不丢 */
  const naiveRebuild = (kinds: string) => `
    CREATE TABLE artifacts_new (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN (${kinds})),
      status TEXT NOT NULL CHECK (status IN ('open','accepted','rejected','superseded')),
      author_agent_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL, body TEXT NOT NULL, metadata_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      work_id TEXT REFERENCES works(id) ON DELETE SET NULL
    );
    INSERT INTO artifacts_new (${ART_COLS.join(",")})
      SELECT ${ART_COLS.join(",")} FROM artifacts;
    DROP TABLE artifacts;
    ALTER TABLE artifacts_new RENAME TO artifacts;
  `;

  const KINDS_016 = [...KINDS_015, "deliverable"].map((k) => `'${k}'`).join(",");

  // ── 1. 闭集:负样本在前 ────────────────────────────────────────
  it("**负样本**:016 之前 kind='deliverable' 必须被拒(证明下一条断言有牙)", async () => {
    const db = await upTo015();
    expect(() => insertKind(db, "a_pre", "deliverable"), "schema 里居然已经有它 —— 这条就没牙了")
      .toThrow(/CHECK/i);
    // 正样本:同一个探针在合法取值上不报错(否则上一条可能是「什么都拒」)
    expect(() => insertKind(db, "a_pre_ok", "evidence")).not.toThrow();
    expect(kindsInSchema(db), "016 之前的闭集不是 10 个 —— 这条断言的基准漂了").toEqual([...KINDS_015]);
    db.close();
  });

  it("016 之后:deliverable 真的落库;旧 10 个取值仍可用;未知取值仍被拒", async () => {
    const db = await upTo015();
    apply016(db);
    expect(() => insertKind(db, "a_new", "deliverable")).not.toThrow();
    for (const k of KINDS_015) {
      expect(() => insertKind(db, `a_${k}`, k), `${k} 被误伤`).not.toThrow();
    }
    // 负样本两条:CHECK 只是放宽了一个取值,不是被拆掉
    expect(() => insertKind(db, "a_bad", "nonsense")).toThrow(/CHECK/i);
    expect(() => insertKind(db, "a_bad2", "deliverables")).toThrow(/CHECK/i);
    expect(
      kindsInSchema(db),
      "schema 的闭集不是『原 10 个 + deliverable』—— 放宽时动了别的取值(静默的语义漂移)",
    ).toEqual([...KINDS_015, "deliverable"]);
    db.close();
  });

  it("闭集 **⊇** 代码的 ARTIFACT_KINDS(加了常量却忘了加迁移 → 先红的是这条)", async () => {
    const db = await upTo015();
    apply016(db);
    const schemaKinds = new Set(kindsInSchema(db));
    // 方向是刻意的、单向的:`代码 ⊆ schema` 必须永远成立,否则那条 kind 会
    // 「写到一半被 CHECK 拒掉」。反过来 (`schema ⊆ 代码`) 在 016 与 C2 之间
    // **不成立而且是正常的** —— 016 总是先落地,schema 先开口、代码随后跟上。
    // 若这条断言反过来写,它会一直红到 C2 落地;那样一条常年红的守卫
    // 会训练人忽略红灯(015 的「闭集与代码同步」是等号,因为它的代码侧
    // `DISPATCH_EVENT_KINDS` 与迁移是同一批次落的)。
    const orphans = ARTIFACT_KINDS.filter((k) => !schemaKinds.has(k));
    expect(
      orphans,
      "ARTIFACT_KINDS 里有 schema 闭集不认的取值 —— 那意味着有人给代码加了 kind 却没加迁移" +
        "(写入会在 CHECK 上响亮失败,「写到一半」的形态)。补一笔重建表的迁移,并登记进 INTENTIONAL_REBUILDS。",
    ).toEqual([]);
    // 正样本:探测器真的读到了 11 个取值(否则上面那条可能是「什么都没读到」而恒真)
    expect(schemaKinds.size).toBe(KINDS_015.length + 1);
    db.close();
  });

  // ── 2. 数据:逐字回归 ────────────────────────────────────────
  it("重建不吃数据:artifacts / artifact_links / asks 行数与内容逐字不变,work_id 那条边还在", async () => {
    const db = await upTo015();
    const before = snapshot(db);

    // 正样本:样本必须非空 —— 否则下面的「相等」是空的(一个坏掉的检查)
    expect(before.artifacts, "artifacts 样本是空的 —— 逐字对比失去意义").toHaveLength(2);
    expect(before.links, "artifact_links 样本是空的 —— 而它正是会被静默清空的那张表").toHaveLength(1);
    expect(before.asks).toHaveLength(2);
    expect(before.cols.map((c) => c.name)).toContain("work_id");
    expect(
      (before.artifacts as Array<{ id: string; work_id: string | null }>).find((a) => a.id === "a_1")!.work_id,
      "样本里必须有一条非空 work_id —— 否则漏掉 014 那一列也测不出来",
    ).toBe("w_1");

    apply016(db);
    const after = snapshot(db);

    expect(after.artifacts, "重建后工件行变了 —— 这是 012 那类静默数据事故").toEqual(before.artifacts);
    expect(
      after.links,
      "重建后 artifact_links 变了(少一行就是被 DROP TABLE 的隐式 DELETE 级联删掉," +
        "而 foreign_key_check 不会响)—— 016 第 1/7 步(先备份子表再灌回)不能删",
    ).toEqual(before.links);
    expect(after.asks, "重建后 asks 变了 —— 第 3/8 步(置 NULL + 回填)不能删").toEqual(before.asks);
    expect(after.fks, "外键(projects CASCADE / agents / works SET NULL)没原样保留").toEqual(before.fks);
    expect(after.cols, "列结构变了(名字/类型/NOT NULL/DEFAULT/主键位次)—— 016 第 5 步抄漏了列").toEqual(before.cols);
    // 正控制:schema 必须**真的**变了,否则上面那些「不变」可能只是 016 什么都没做
    expect(after.tableSql, "schema 没变 —— 016 什么都没做").not.toBe(before.tableSql);
    // 正控制:denormalized 的两行确实是那两行(不是被别的行顶替)
    expect((after.artifacts as Array<{ id: string }>).map((a) => a.id)).toEqual(["a_1", "a_2"]);

    expect(backupTables(db), "中转备份表残留了(迁移没跑完或忘了 DROP)").toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check")[0]).toEqual({ integrity_check: "ok" });
    db.close();
  });

  // ── 3. 索引 ─────────────────────────────────────────────────
  it("被 DROP 掉的索引真的重建了 —— **6 条**(008 五条 + 014 一条),谓词与 DESC 都在", async () => {
    const db = await upTo015();
    const before = indexSig(db);
    expect(
      before.map((i) => i.name),
      "016 之前的样本索引不对(应当是 008 五条 + 014 的 idx_artifacts_work)—— 这条断言会失去意义",
    ).toEqual([
      "idx_artifacts_author", "idx_artifacts_kind", "idx_artifacts_project",
      "idx_artifacts_recent", "idx_artifacts_status", "idx_artifacts_work",
    ]);

    apply016(db);
    const after = indexSig(db);
    expect(
      after.map((i) => i.name),
      "DROP TABLE 把索引一起带走了,而 016 没把它们全部重建 —— " +
        "设计稿 §2.11.5 写的是『五个索引』,那是 014 之前的数字;" +
        "014 又加了 idx_artifacts_work,漏掉它不报错、只是悄悄退化成全表扫",
    ).toEqual(before.map((i) => i.name));
    expect(after, "索引的语义变了(唯一性 / 部分性 / 列与次序 / DESC / 谓词)").toEqual(before);
    // 部分索引的谓词单独再钉一次(丢了它 = 静默的语义漂移)
    const work = after.find((i) => i.name === "idx_artifacts_work")!;
    expect(work.partial, "idx_artifacts_work 不再是部分索引").toBe(1);
    expect(work.where).toMatch(/work_id\s+IS\s+NOT\s+NULL/i);
    const recent = after.find((i) => i.name === "idx_artifacts_recent")!;
    expect(recent.xinfo.filter((x) => x.key === 1).map((x) => `${x.name}:${x.desc}`))
      .toEqual(["project_id:0", "created_at:1"]);
    db.close();
  });

  // ── 4. 重建前提:子表清单 ────────────────────────────────────
  it("**重建前提**:引用 artifacts 的外键恰好那 3 条(CASCADE×2 + NO ACTION×1)", async () => {
    const db = await upTo015();
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);
    const children: Array<{ table: string; from: string; onDelete: string }> = [];
    const referenced = new Set<string>();
    for (const t of tables) {
      for (const fk of db.pragma(`foreign_key_list(${t})`) as Array<{
        table: string; from: string; on_delete: string;
      }>) {
        referenced.add(fk.table);
        if (fk.table === "artifacts") children.push({ table: t, from: fk.from, onDelete: fk.on_delete });
      }
    }
    // 正样本:探测器真的看得见外键(projects / agents 明明被一大票表引用)
    expect(referenced.has("projects"), "探测器坏了:projects 明明被多张表引用").toBe(true);
    expect(referenced.has("agents"), "探测器坏了:agents 明明被多张表引用").toBe(true);
    expect(
      children.sort((a, b) => `${a.table}.${a.from}`.localeCompare(`${b.table}.${b.from}`)),
      "引用 artifacts 的外键集合变了 —— 016 的重建步骤(备份哪张子表 / 谁会被隐式 DELETE 级联)" +
        "与这个集合一一对应:多一条 CASCADE 就要多备份一张子表,多一条 NO ACTION 就要多处置一列;" +
        "改这里之前先读 016 文件头的『三条外键』那一节",
    ).toEqual([
      { table: "artifact_links", from: "artifact_id", onDelete: "CASCADE" },
      { table: "artifact_links", from: "target_artifact_id", onDelete: "CASCADE" },
      { table: "asks", from: "resolution_artifact_id", onDelete: "NO ACTION" },
    ]);
    db.close();
  });

  // ── 5. 负样本:证明上面那些断言不是空的 ──────────────────────
  it("**负样本**:朴素重建确实会出事 —— asks 全 NULL 时静默清空子表 / 非空时响亮失败", async () => {
    // (a) asks 全 NULL:朴素重建**成功**,而 artifact_links 没了 —— 一声不响
    const silent = await upTo015({ answeredAsk: false });
    const linksBefore = (silent.prepare(`SELECT COUNT(*) n FROM artifact_links`).get() as { n: number }).n;
    expect(linksBefore, "正样本:artifact_links 必须 > 0,否则这条负样本是空的").toBe(1);
    expect(() => silent.exec(naiveRebuild(KINDS_016)), "朴素重建居然报错了 —— 那这条负样本没测到它").not.toThrow();
    expect(
      (silent.prepare(`SELECT COUNT(*) n FROM artifact_links`).get() as { n: number }).n,
      "⚠️ 这条断言失败说明:朴素重建**没有**静默清空子表 —— " +
        "那么 016 的先备份后灌回就不是必需的了,请重新论证(而 012 的事故是真的)",
    ).toBe(0);
    expect(silent.pragma("foreign_key_check"), "foreign_key_check 在这条路上是一声不响的").toEqual([]);
    // 而且索引也全没了
    expect(indexSig(silent), "朴素重建把 6 条索引全丢了").toEqual([]);
    silent.close();

    // (b) asks 有一条非空 resolution_artifact_id:朴素重建**响亮失败**,事务回滚
    const loud = await upTo015({ answeredAsk: true });
    const before = snapshot(loud);
    expect(
      () => loud.transaction(() => loud.exec(naiveRebuild(KINDS_016)))(),
      "朴素重建居然没被 NO ACTION 那条外键拦住",
    ).toThrow(/FOREIGN KEY/i);
    expect(snapshot(loud).artifacts, "回滚不完整:工件被改了").toEqual(before.artifacts);
    expect(snapshot(loud).links, "回滚不完整:子表被改了").toEqual(before.links);
    expect(snapshot(loud).asks, "回滚不完整:asks 被改了").toEqual(before.asks);
    loud.close();
  });

  it("**负样本**复现设计稿字面 recipe 的两处漏:漏重建 idx_artifacts_work / 漏抄 work_id", async () => {
    const db = await upTo015({ answeredAsk: false });
    // 设计稿 §2.11.5 那 8 行 recipe 的字面实现:008 的 11 列 + 008 的五个索引
    db.exec(`
      CREATE TABLE artifact_links_backup AS SELECT * FROM artifact_links;
      CREATE TABLE artifacts_backup AS SELECT * FROM artifacts;
      DROP TABLE artifacts;
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        conversation_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN (${KINDS_016})),
        status TEXT NOT NULL CHECK (status IN ('open','accepted','rejected','superseded')),
        author_agent_id TEXT NOT NULL REFERENCES agents(id),
        title TEXT NOT NULL, body TEXT NOT NULL, metadata_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO artifacts (id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at)
        SELECT id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at FROM artifacts_backup;
      INSERT INTO artifact_links (artifact_id,rel,target_artifact_id)
        SELECT artifact_id,rel,target_artifact_id FROM artifact_links_backup;
      DROP TABLE artifacts_backup;
      DROP TABLE artifact_links_backup;
      CREATE INDEX idx_artifacts_project ON artifacts(project_id);
      CREATE INDEX idx_artifacts_kind    ON artifacts(project_id, kind);
      CREATE INDEX idx_artifacts_status  ON artifacts(project_id, status);
      CREATE INDEX idx_artifacts_author  ON artifacts(author_agent_id);
      CREATE INDEX idx_artifacts_recent  ON artifacts(project_id, created_at DESC);
    `);
    // 漏①:设计稿说「五个索引」,照它做 idx_artifacts_work 就没了(零报错)
    expect(indexSig(db).map((i) => i.name)).not.toContain("idx_artifacts_work");
    expect(indexSig(db)).toHaveLength(5);
    // 漏②:照 008 抄列清单,014 的 work_id 整列消失(数据被销毁,零报错)
    expect(tableSig(db).map((c) => c.name)).not.toContain("work_id");
    // 「迁移静默、下游响亮」—— 与批次 5 同形:报错落在离根因很远的地方
    expect(() => db.exec(`SELECT work_id FROM artifacts`)).toThrow(/no such column: work_id/i);
    db.close();
  });

  // ── 6. 文件形态 ─────────────────────────────────────────────
  it("迁移文件形态:重建表(不是 ALTER);备份两张子表;显式重建 6 条索引;不带 IF NOT EXISTS", () => {
    const sql = migration016().sql;
    const body = stripSqlComments(sql);
    // 一行 ALTER 都没有:ADD CONSTRAINT 只能收紧,拿它放宽是「无错而无效」(见文件头实测)
    expect(body, "016 里出现了 ALTER TABLE —— 那条路只能收紧,放宽会静默无效")
      .not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(body, "重建路径上不能有 IF NOT EXISTS:撞名时它会静默无操作(批次 5 的事故形态)")
      .not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(body, "016 没有 DROP 旧表 —— 那它就不是重建").toMatch(/\bDROP\s+TABLE\s+artifacts\b/i);
    // 子表必须先备份(012 那套 recipe 的第 1 步)
    expect(body, "没有备份 artifact_links —— 它的两条外键都是 ON DELETE CASCADE,DROP 会静默清空它")
      .toMatch(/CREATE\s+TABLE\s+artifact_links_backup\s+AS\s+SELECT/i);
    expect(body, "少了一句 `INSERT INTO artifact_links ... FROM artifact_links_backup` —— 备份了却不灌回")
      .toMatch(/INSERT\s+INTO\s+artifact_links[\s\S]*?FROM\s+artifact_links_backup/i);
    // 6 条索引,一条不少(设计稿的「五个」是 014 之前的数字)
    const created = [...body.matchAll(/CREATE\s+INDEX\s+(idx_artifacts_[a-z_]+)\s+ON\s+artifacts/gi)]
      .map((m) => m[1]!);
    expect(created.sort(), "016 没有把 6 条索引全部显式重建").toEqual([
      "idx_artifacts_author", "idx_artifacts_kind", "idx_artifacts_project",
      "idx_artifacts_recent", "idx_artifacts_status", "idx_artifacts_work",
    ]);
    expect(body).toMatch(/WHERE\s+work_id\s+IS\s+NOT\s+NULL/i);
    expect(body).toMatch(/created_at\s+DESC/i);
    // 014 的列必须在新建表里(否则 10 条真机产出边会被静默销毁)
    expect(body, "新表的列清单里没有 work_id —— 014 那条产出边会被静默销毁")
      .toMatch(/work_id\s+TEXT\s+REFERENCES\s+works\(id\)\s+ON\s+DELETE\s+SET\s+NULL/i);
    // asks 那条 NO ACTION 的处置:先置 NULL,再回填
    expect(body, "没有把 asks.resolution_artifact_id 移出/置 NULL —— 那条 NO ACTION 会让 DROP 响亮失败")
      .toMatch(/UPDATE\s+asks\s+SET\s+resolution_artifact_id\s*=\s*NULL/i);
    expect(body, "没有回填 asks.resolution_artifact_id —— 那会静默丢掉作答边")
      .toMatch(/UPDATE\s+asks\s+SET\s+resolution_artifact_id\s*=\s*\(/i);
    // 6 条外键动作必须原样出现在新表里
    expect(body).toMatch(/project_id\s+TEXT\s+NOT\s+NULL\s+REFERENCES\s+projects\(id\)\s+ON\s+DELETE\s+CASCADE/i);
    expect(createdTables(sql)).toContain("artifacts");
  });

  // ── 7. ⚠️ 这条守卫**看不见** 017 加的第 4 条外键 ────────────────
  it("守卫的作用域:它跑的是 `upTo015` 的 schema,**017 加的第 4 条外键不在它的视野里**", async () => {
    // 这不是「守卫失效」,是它的作用域本来就只有 016 重建前的那张表 —— 但它是一处
    // **容易被误读成全面覆盖**的地方(AGENTS.md:一个坏掉的检查不等于「检查失败」,
    // 它可能返回一个看起来正常的答案)。所以这里把作用域钉成断言:
    const db = await upTo015();
    expect(
      (db.pragma(`foreign_key_list(project_sessions)`) as Array<{ table: string }>)
        .filter((fk) => fk.table === "artifacts"),
      "upTo015 的 schema 里 project_sessions 还没有指向 artifacts 的外键(017 才加)",
    ).toEqual([]);
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════════
// 017 · 交付会话(纯加法:两个新列)
// ══════════════════════════════════════════════════════════════════

/**
 * C4 的 migration:给 `project_sessions` 加 `deliverable_artifact_id` 与 `channel`。
 *
 * 与 015 / 016 的关键不同:**它是纯加法,不是重建**。015 / 016 只能重建表,是因为
 * 它们要**放宽已有 CHECK 的表达式**(SQLite 改不了,ADD CONSTRAINT 只能收紧);
 * 017 加的是两个全新列,不碰任何既有约束,所以两行 `ALTER TABLE ADD COLUMN` 就够。
 *
 * 于是这个 describe 的重点与 016 相反 —— 不是「重建有没有吃数据」,而是
 * **「存量行有没有被改一个字」**:
 *   - 行数与内容**逐字不变**(这正是纯加法的验收判据);
 *   - 存量行 `channel='internal'`(DEFAULT 生效)、`deliverable_artifact_id IS NULL`;
 *   - `foreign_key_check` / `integrity_check` 干净;
 *   - 新列可空、无 DROP、外键是 `REFERENCES artifacts(id)`(⚠️ 它让
 *     `artifacts` 的**第 4 条**外键出现 —— 016 的重建前提守卫跑的是 `upTo015`,
 *     看不见它,所以在下面单独钉住全 schema 的那个数)。
 */
describe("017 交付会话(纯加法:两个新列)", () => {
  /** 到 `maxVersion` 为止的真 schema(002 的 vec0 不可用时跳过,与 `upTo015` 同形)。 */
  async function upTo(maxVersion: number) {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version > maxVersion) break;
      try {
        db.exec(f.sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        throw err;
      }
    }
    return db;
  }

  function migration017() {
    const m = FILES.find((f) => f.version === 17);
    expect(m, "017 迁移文件缺失").toBeDefined();
    return m!;
  }

  /** 一个**有数据**的 016 库:`project_sessions` 那条会话 + 它的消息都要逐字活下来。 */
  async function seeded016() {
    const db = await upTo(16);
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('wk','worker','engineering','工人',1)`);
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('bm','business_manager',NULL,'业务经理',1)`);
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('pm','project_manager',NULL,'项目经理',1)`);
    db.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
             VALUES ('pj_1','语音机器人调研','甲方','目标','active',1)`);
    // 存量会话行:正文带中文 / 引号 / 反斜杠 —— 逐字对比要能看出被动过
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at)
             VALUES ('s_old','pj_1',11)`);
    db.exec(`INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
             VALUES ('m_1','s_old',NULL,'user','甲方说:"我要三条路线的对比" \\ 现场',12)`);
    db.exec(`INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
             VALUES ('m_2','s_old','bm','assistant','收到,先看约束',13)`);
    db.exec(`INSERT INTO artifacts (id,project_id,conversation_id,kind,status,author_agent_id,
                                    title,body,metadata_json,created_at,updated_at,work_id)
             VALUES ('d_1','pj_1',NULL,'deliverable','accepted','pm','交付物','正文',NULL,14,14,NULL)`);
    return db;
  }

  type Db = Awaited<ReturnType<typeof seeded016>>;

  /** 存量行的快照 —— **只取老列**,所以「新列加了没有」不会污染「老列变没变」。 */
  const snapshot = (db: Db) => ({
    rows: db.prepare(`SELECT id, project_id, created_at FROM project_sessions ORDER BY id`).all(),
    messages: db.prepare(`SELECT * FROM session_messages ORDER BY id`).all(),
    artifacts: db.prepare(`SELECT * FROM artifacts ORDER BY id`).all(),
  });

  // ── 1. 纯加法:存量行逐字不变 ────────────────────────────────
  it("**存量行逐字不变**:行数 / `project_sessions` / `session_messages` / `artifacts` 一模一样", async () => {
    const db = await seeded016();
    const before = snapshot(db);
    // 正样本自检:样本不是空的(逐字对比在空集上毫无意义)
    expect(before.rows, "样本是空的 —— 逐字对比失去意义").toHaveLength(1);
    expect(before.messages).toHaveLength(2);
    expect(before.artifacts).toHaveLength(1);

    db.exec(migration017().sql);

    expect(snapshot(db), "017 动了存量数据 —— 纯加法不该改任何一个老列").toEqual(before);
    db.close();
  });

  it("存量行 `channel='internal'`、`deliverable_artifact_id IS NULL`(DEFAULT 生效)", async () => {
    const db = await seeded016();
    db.exec(migration017().sql);
    expect(
      db.prepare(`SELECT id, channel, deliverable_artifact_id FROM project_sessions`).all(),
    ).toEqual([{ id: "s_old", channel: "internal", deliverable_artifact_id: null }]);
    db.close();
  });

  it("`foreign_key_check` 与 `integrity_check` 干净", async () => {
    const db = await seeded016();
    db.exec(migration017().sql);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect((db.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check)
      .toBe("ok");
    db.close();
  });

  // ── 2. 列的形状 ──────────────────────────────────────────────
  it("新列的形状:`deliverable_artifact_id` 可空、`channel` NOT NULL DEFAULT 'internal' + CHECK", async () => {
    const db = await seeded016();
    db.exec(migration017().sql);
    const cols = db.pragma("table_info(project_sessions)") as Array<{
      name: string; notnull: number; dflt_value: string | null; type: string;
    }>;
    const deliv = cols.find((c) => c.name === "deliverable_artifact_id")!;
    expect(deliv, "`deliverable_artifact_id` 没建出来 —— 那条握手协议的名字不能改").toBeDefined();
    expect(deliv.type).toBe("TEXT");
    expect(deliv.notnull, "它必须可空(NULL = 这条会话不是交付开出来的)").toBe(0);
    expect(deliv.dflt_value).toBeNull();

    const channel = cols.find((c) => c.name === "channel")!;
    expect(channel.type).toBe("TEXT");
    expect(channel.notnull, "`channel` 必须 NOT NULL —— 否则「这条消息属于哪条对话」又有第三种答案").toBe(1);
    expect(channel.dflt_value).toBe("'internal'");
    db.close();
  });

  it("`channel` 的闭集:两个合法值写得进,**非法值被 CHECK 拒掉**(负样本)", async () => {
    const db = await seeded016();
    db.exec(migration017().sql);
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at,channel) VALUES ('s_c','pj_1',20,'client')`);
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at,channel) VALUES ('s_i','pj_1',21,'internal')`);
    expect(
      db.prepare(`SELECT id, channel FROM project_sessions WHERE id IN ('s_c','s_i') ORDER BY id`).all(),
    ).toEqual([
      { id: "s_c", channel: "client" },
      { id: "s_i", channel: "internal" },
    ]);
    expect(
      () => db.exec(`INSERT INTO project_sessions (id,project_id,created_at,channel) VALUES ('s_x','pj_1',22,'甲方')`),
      "非法通道值必须被 schema 拦住 —— 它在应用层是 `SessionChannel` 联合,漏进来就是静默错分",
    ).toThrow(/CHECK constraint failed/i);
    db.close();
  });

  it("外键:`deliverable_artifact_id` → `artifacts(id)`,**NO ACTION**(悬空引用响亮被拒)", async () => {
    const db = await seeded016();
    db.exec(migration017().sql);
    const fks = (db.pragma(`foreign_key_list(project_sessions)`) as Array<{
      table: string; from: string; on_delete: string;
    }>).filter((fk) => fk.table === "artifacts");
    expect(fks).toEqual([
      { id: 0, seq: 0, table: "artifacts", from: "deliverable_artifact_id",
        to: "id", on_update: "NO ACTION", on_delete: "NO ACTION", match: "NONE" },
    ]);
    // 正样本:挂到那条真的交付物上 —— 成功
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at,deliverable_artifact_id)
             VALUES ('s_deliv','pj_1',30,'d_1')`);
    // 负样本:悬空引用 —— 被外键拒掉,而且必须**响亮**
    expect(
      () => db.exec(`INSERT INTO project_sessions (id,project_id,created_at,deliverable_artifact_id)
                     VALUES ('s_bad','pj_1',31,'d_不存在')`),
    ).toThrow(/FOREIGN KEY constraint failed/i);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  // ── 3. ⚠️ `artifacts` 的第 4 条外键(016 的守卫看不见它)────────
  it("**全 schema 的核对**:引用 `artifacts` 的外键从 3 条变 **4** 条(第 4 条是这个新列)", async () => {
    const db = await seeded016();
    db.exec(migration017().sql);
    const tables = (db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    ).all() as Array<{ name: string }>).map((r) => r.name);
    const children: Array<{ table: string; from: string; onDelete: string }> = [];
    const referenced = new Set<string>();
    for (const t of tables) {
      for (const fk of db.pragma(`foreign_key_list(${t})`) as Array<{
        table: string; from: string; on_delete: string;
      }>) {
        referenced.add(fk.table);
        if (fk.table === "artifacts") children.push({ table: t, from: fk.from, onDelete: fk.on_delete });
      }
    }
    // 正样本:探测器真的看得见外键
    expect(referenced.has("projects"), "探测器坏了:projects 明明被多张表引用").toBe(true);
    expect(
      children.sort((a, b) => `${a.table}.${a.from}`.localeCompare(`${b.table}.${b.from}`)),
      "引用 artifacts 的外键集合变了 —— 016 的重建步骤(备份哪张子表 / 谁会被隐式 DELETE 级联)" +
        "与这个集合一一对应。**第 4 条是 017 加的 `project_sessions.deliverable_artifact_id`" +
        "(NO ACTION)**:将来若第二次重建 `artifacts`,处置方式与 `asks.resolution_artifact_id` 同形" +
        "(先置 NULL、重建后回填),而不是备份成子表",
    ).toEqual([
      { table: "artifact_links", from: "artifact_id", onDelete: "CASCADE" },
      { table: "artifact_links", from: "target_artifact_id", onDelete: "CASCADE" },
      { table: "asks", from: "resolution_artifact_id", onDelete: "NO ACTION" },
      { table: "project_sessions", from: "deliverable_artifact_id", onDelete: "NO ACTION" },
    ]);
    db.close();
  });

  // ── 4. 变异验证:文件形态 ────────────────────────────────────
  it("文件形态:两行 `ALTER TABLE ADD COLUMN`,**一行 DROP 都没有**,不建表、不带 IF NOT EXISTS", () => {
    const sql = migration017().sql;
    const body = stripSqlComments(sql);
    const alters = [...body.matchAll(/ALTER\s+TABLE\s+([a-z_]+)\s+ADD\s+COLUMN\s+([a-z_]+)/gi)]
      .map((m) => `${m[1]}.${m[2]}`);
    expect(alters, "017 只该加两列,而且列名是握手协议(读面按名字查 schema)").toEqual([
      "project_sessions.deliverable_artifact_id",
      "project_sessions.channel",
    ]);
    expect(body, "017 里出现了 DROP —— 纯加法不该有它(批次 18 的静默删数据就是 DROP 那条路)")
      .not.toMatch(/\bDROP\b/i);
    expect(createdTables(sql), "017 不该建表(建表就带回「IF NOT EXISTS 撞名静默无操作」那个面)")
      .toEqual([]);
    expect(body).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    // ⚠️ 关键:它不是重建表 ⇒ 不该被登记进 `INTENTIONAL_REBUILDS`
    const rebuilt = INTENTIONAL_REBUILDS.some((r) => r.files.includes("017_deliverable_session.sql"));
    expect(rebuilt, "017 是纯加法,不该出现在 INTENTIONAL_REBUILDS 里").toBe(false);
  });

  it("**变异验证**:删掉 CHECK 或删掉列,守卫必须红", async () => {
    // 这条不是断言迁移文件,而是断言**上面那些断言有牙**:同一个库,把 017 的两个
    // 关键成分分别拿掉之后,判据必须立刻不成立。
    const noCheck = await seeded016();
    noCheck.exec(`ALTER TABLE project_sessions ADD COLUMN deliverable_artifact_id TEXT REFERENCES artifacts(id)`);
    noCheck.exec(`ALTER TABLE project_sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'internal'`);
    expect(
      () => noCheck.exec(`INSERT INTO project_sessions (id,project_id,created_at,channel) VALUES ('s_x','pj_1',22,'甲方')`),
      "没有 CHECK 时非法通道值写得进去 —— 上面那条「闭集」断言不是空话",
    ).not.toThrow();
    noCheck.close();

    const noColumn = await seeded016();
    noColumn.exec(`ALTER TABLE project_sessions ADD COLUMN channel TEXT NOT NULL DEFAULT 'internal' CHECK (channel IN ('internal','client'))`);
    const cols = (noColumn.pragma("table_info(project_sessions)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols, "少了那一列,读面(`deliveredArtifactIds`)就只能如实退化 —— 上面那条存在性断言不是空话")
      .not.toContain("deliverable_artifact_id");
    noColumn.close();
  });
});

/**
 * 026 · 两段重建 + 一处改名(执行角色一分为二 + 交付物类型加 code_service)
 *
 * ── 这个迁移的失败方式全是静默的,所以守卫必须逐条钉 ────────────────
 *
 * 发布前用 `.probe/026-rebuild-probe.mjs` 做过一轮探针(带正负样本自检,
 * 33/33 通过),本组把它**固化成回归** —— 探针是临时的,测试是留下的。
 *
 * 三条判据尤其重要:
 *   ① `agents` 被 **15 条**外键指着,其中只有 `project_assignments` 是 CASCADE。
 *      朴素 `DROP TABLE agents` 会**响亮失败**(安全),但「改名换表法」在
 *      **数据少时静默清空 project_assignments 而 foreign_key_check 干净**。
 *   ② `025` 注释里那份 artifacts 子表清单**是错的**,漏了 `client_questions`
 *      (两条,含主键)与 `review_verdicts`(一条)。照它处置会静默删光待答台账。
 *   ③ `defer_foreign_keys` 是唯一能在事务里生效的放宽手段,而它**提交后必须复位**
 *      —— 漏给后续迁移会让之后每一次写库都变成「提交时才报错」。
 */
describe("026 执行角色一分为二 + 交付物类型加 code_service", () => {
  function migration026() {
    const m = FILES.find((f) => f.version === 26);
    expect(m, "026 迁移文件缺失").toBeDefined();
    return m!;
  }

  /** 到 025 为止的真 schema + **每一条子表外键都有非空行**的种子数据。 */
  async function seeded025() {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version >= 26) break;
      try {
        db.exec(f.sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        throw err;
      }
    }
    // ⚠️ 数据必须**非空**:016 探针的教训是「不变」在空数据上是空话
    // (artifact_links 1 → 0 而 foreign_key_check 一声不响)。
    db.exec(`
      INSERT INTO projects (id,name,client,goal,status,created_at)
        VALUES ('pj_1','项目','甲方','目标','active',1);
      INSERT INTO agents (id,role,specialization,display_name,created_at) VALUES
        ('bm','business_manager',NULL,'业务经理',1),
        ('pm','project_manager',NULL,'项目经理',1),
        ('wk','worker','engineering','工程师',1),
        ('qa','quality_reviewer',NULL,'质检',1);
      INSERT INTO project_assignments (project_id,agent_id,added_at) VALUES
        ('pj_1','bm',1),('pj_1','pm',1),('pj_1','wk',1),('pj_1','qa',1);
      INSERT INTO works (id,project_id,title,goal,status,assignee_agent_id,created_at,updated_at)
        VALUES ('w_1','pj_1','活','做完','open','wk',1,1);
      INSERT INTO works (id,project_id,title,goal,status,assignee_agent_id,created_at,updated_at)
        VALUES ('w_2','pj_1','活2','做完','open','qa',1,1);
      INSERT INTO artifacts (id,project_id,kind,status,author_agent_id,title,body,created_at,updated_at,work_id)
        VALUES ('a_1','pj_1','evidence','open','wk','证据','正文 "引号" 中文',1,1,'w_1');
      INSERT INTO artifacts (id,project_id,kind,status,author_agent_id,title,body,created_at,updated_at,deliverable_type)
        VALUES ('a_2','pj_1','deliverable','open','pm','交付','正文',1,1,'html_report');
      INSERT INTO artifact_links (artifact_id,rel,target_artifact_id) VALUES ('a_2','depends_on','a_1');
      INSERT INTO asks (id,project_id,from_agent_id,to_agent_id,question,hypothesis,status,created_at,resolution_artifact_id)
        VALUES ('q_1','pj_1','wk','pm','问题','假设','answered',1,'a_1');
      INSERT INTO project_sessions (id,project_id,created_at,channel,kind,title,deliverable_artifact_id)
        VALUES ('s_1','pj_1',1,'internal','main','主对话','a_2');
      INSERT INTO client_questions (question_artifact_id,project_id,asked_by,asked_at,answer_artifact_id,answered_at,consumed_at,consumed_by)
        VALUES ('a_1','pj_1','bm',1,'a_2',2,3,'pm');
      INSERT INTO review_verdicts (work_id,project_id,verdict,severity,finding_artifact_id,reviewed_by,created_at)
        VALUES ('w_1','pj_1','pass','low','a_1','qa',1);
      INSERT INTO turn_usage (id,project_id,session_id,agent_id,work_id,created_at)
        VALUES ('tu_1','pj_1','s_1','wk','w_1',1);
      INSERT INTO blockers (id,project_id,raised_by_agent_id,title,detail,severity,status,created_at)
        VALUES ('b_1','pj_1','wk','阻塞','细节','high','open',1);
      INSERT INTO change_requests (id,project_id,title,rationale,status,created_at,decided_by_agent_id)
        VALUES ('c_1','pj_1','变更','理由','accepted',1,'pm');
      INSERT INTO sessions_backup_probe (x) VALUES (1);
    `.replace("INSERT INTO sessions_backup_probe (x) VALUES (1);", ""));
    return db;
  }

  type Db = Awaited<ReturnType<typeof seeded025>>;

  /**
   * 应用 026。**必须走事务** —— `PRAGMA defer_foreign_keys` 只在事务**之内**有意义
   * (`PRAGMA foreign_keys` 在事务内是 no-op,而 defer 需要有一个「提交点」去推迟到)。
   * 生产路径天然满足:`infra/migrations.ts` 用 `db.transaction(() => db.exec(sql))`。
   *
   * ⚠️ 事务外直接 `db.exec(026)` 会得到 `FOREIGN KEY constraint failed` —— 那是
   * **响亮失败**(不是静默删数据),所以这个前提不成立时不会有人看不出。
   * 本组有一条负样本专门钉这件事。
   */
  function apply026(db: Db): void {
    db.transaction(() => { db.exec(migration026().sql); })();
  }

  /** 逐表行数 —— 重建前后必须逐项相同。 */
  const TABLES = [
    "agents", "project_assignments", "works", "artifacts", "artifact_links", "asks",
    "project_sessions", "client_questions", "review_verdicts", "turn_usage",
    "blockers", "change_requests",
  ];
  const counts = (db: Db) =>
    Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }]));

  /** 动态判据:某张表上指向 parent 的外键(不是 grep 历史文件)。 */
  function inboundFks(db: Db, parent: string) {
    const out: Array<{ table: string; from: string; onDelete: string }> = [];
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    for (const t of tables) {
      for (const fk of db.pragma(`foreign_key_list(${t})`) as Array<{ table: string; from: string; on_delete: string }>) {
        if (fk.table === parent) out.push({ table: t, from: fk.from, onDelete: fk.on_delete });
      }
    }
    return out;
  }

  it("探测器自检:指向 agents 的 CASCADE **只有** project_assignments(负样本:数错表名得 0)", async () => {
    const db = await seeded025();
    const fks = inboundFks(db, "agents");
    expect(fks.length, "指向 agents 的外键条数(静态 grep 会数出 16,因为重建过的表被数两次)").toBe(15);
    expect([...new Set(fks.filter((f) => f.onDelete === "CASCADE").map((f) => f.table))])
      .toEqual(["project_assignments"]);
    expect(inboundFks(db, "agentz"), "负样本:错误表名必须是 0 —— 否则上面的探测器在数空气").toEqual([]);
    // 025 注释漏掉的那张表:这条就是「那份清单是错的」的判据
    expect(inboundFks(db, "artifacts").filter((f) => f.table === "client_questions").length).toBe(2);
    expect(inboundFks(db, "artifacts").filter((f) => f.table === "review_verdicts").length).toBe(1);
    db.close();
  });

  it("正样本:应用 026 —— 不报错、行数逐项不变、外键干净、中转表不残留", async () => {
    const db = await seeded025();
    const before = counts(db);
    expect(() => apply026(db)).not.toThrow();

    expect(counts(db), "重建前后行数漂了 —— 那就是静默删数据").toEqual(before);
    expect(db.pragma("foreign_key_check"), "外键检查必须干净").toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'm026_%'").get(),
      "中转表用完必须删干净(留着会永久占一份快照)",
    ).toEqual({ n: 0 });
    // ⚠️ defer_foreign_keys 必须**提交后自动复位**:漏给后续迁移 = 之后每次写库
    // 都变成「提交时才报错」,而那时错误已经离现场很远了。
    expect(db.pragma("defer_foreign_keys", { simple: true })).toBe(0);
    db.close();
  });

  it("正样本:角色改名落库、specialization 原样保留、成员关系一条不少", async () => {
    const db = await seeded025();
    apply026(db);
    expect(db.prepare("SELECT COUNT(*) n FROM agents WHERE role='worker'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT role,specialization,display_name FROM agents WHERE id='wk'").get())
      .toEqual({ role: "research_worker", specialization: "engineering", display_name: "工程师" });
    expect(
      (db.prepare("SELECT agent_id FROM project_assignments ORDER BY agent_id").all() as Array<{ agent_id: string }>)
        .map((r) => r.agent_id),
      "成员关系被 CASCADE 清空了 —— 这就是「D 级静默失败」那一类",
    ).toEqual(["bm", "pm", "qa", "wk"]);
    db.close();
  });

  it("正样本:待答台账(client_questions)逐字未变 —— 025 清单漏掉的那张表", async () => {
    const db = await seeded025();
    const before = db.prepare("SELECT * FROM client_questions").get();
    apply026(db);
    expect(db.prepare("SELECT * FROM client_questions").get()).toEqual(before);
    // 另外三条 NO ACTION 的边也要还在(靠 defer,不是靠置 NULL 再回填)
    expect(db.prepare("SELECT resolution_artifact_id FROM asks WHERE id='q_1'").get())
      .toEqual({ resolution_artifact_id: "a_1" });
    expect(db.prepare("SELECT deliverable_artifact_id FROM project_sessions WHERE id='s_1'").get())
      .toEqual({ deliverable_artifact_id: "a_2" });
    expect(db.prepare("SELECT finding_artifact_id FROM review_verdicts WHERE work_id='w_1'").get())
      .toEqual({ finding_artifact_id: "a_1" });
    db.close();
  });

  it("正样本:两个新闭集**真的生效**(四个方向都要有牙)", async () => {
    const db = await seeded025();
    apply026(db);
    const rejects = (sql: string) => {
      try { db.exec(sql); return false; } catch { return true; }
    };
    // ① 旧角色值必须被拒
    expect(rejects("INSERT INTO agents VALUES ('x1','worker',NULL,'旧名',1)"), "worker 该被拒").toBe(true);
    // ② 两个新角色值必须可写
    expect(() => db.exec(`
      INSERT INTO agents VALUES ('x2','research_worker','algorithm','研究员',1);
      INSERT INTO agents VALUES ('x3','coding_worker','engineering','工程师',1);
    `)).not.toThrow();
    // ③ 触发器判据跟着放宽 / 跟着收紧
    expect(rejects("INSERT INTO agents VALUES ('x4','business_manager','data','越权',1)"),
      "非执行角色带 specialization 必须被触发器拒").toBe(true);
    // ④ 交付物类型:旧的预留名仍被拒,新值可写,存量 NULL 合法
    expect(rejects("UPDATE artifacts SET deliverable_type='git_repo' WHERE id='a_2'")).toBe(true);
    expect(() => db.exec("UPDATE artifacts SET deliverable_type='code_service' WHERE id='a_2'")).not.toThrow();
    expect(() => db.exec("UPDATE artifacts SET deliverable_type=NULL WHERE id='a_2'")).not.toThrow();
    db.close();
  });

  it("正样本:索引一条不少也不多(agents 1 条 / artifacts 7 条)", async () => {
    const db = await seeded025();
    const idx = (t: string) =>
      (db.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
      ).all(t) as Array<{ name: string }>).map((r) => r.name);
    const before = { agents: idx("agents"), artifacts: idx("artifacts") };
    expect(before.artifacts.length, "025 之后 artifacts 上是 7 条索引,少了就说明读面在退化").toBe(7);
    apply026(db);
    expect({ agents: idx("agents"), artifacts: idx("artifacts") }, "DROP TABLE 会带走索引,必须逐条重建").toEqual(before);
    db.close();
  });

  it("负样本:朴素 `DROP TABLE agents` **响亮失败**(安全分支,但不能靠它)", async () => {
    const db = await seeded025();
    const before = counts(db);
    expect(() => db.transaction(() => { db.exec("DROP TABLE agents;"); })())
      .toThrow(/FOREIGN KEY/i);
    expect(counts(db), "失败必须整体回滚").toEqual(before);
    db.close();
  });

  it("负样本:改名换表法在**数据少**时会**静默清空** project_assignments", async () => {
    // 这一条是 026 不用「改名法」的判据,也是本项目最贵的那条教训的又一次现身:
    // 同一个 recipe,数据少时不报错而删数据、数据多时才响亮失败 ——
    // 「在我机器上它报错了,所以我加了对的处置」不可移植。
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version >= 26) break;
      try { db.exec(f.sql); } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        throw err;
      }
    }
    db.exec(`
      INSERT INTO projects (id,name,client,goal,status,created_at) VALUES ('pj_1','p','c','g','active',1);
      INSERT INTO agents (id,role,display_name,created_at) VALUES
        ('wk','worker','工程师',1),('qa','quality_reviewer','质检',1);
      INSERT INTO project_assignments (project_id,agent_id,added_at) VALUES ('pj_1','wk',1),('pj_1','qa',1);
    `);
    expect(() =>
      db.transaction(() => {
        db.exec(`
          PRAGMA legacy_alter_table = ON;
          ALTER TABLE agents RENAME TO agents_old;
          CREATE TABLE agents (
            id TEXT PRIMARY KEY,
            role TEXT NOT NULL CHECK (role IN ('business_manager','project_manager','research_worker','coding_worker','quality_reviewer')),
            specialization TEXT CHECK (specialization IS NULL OR specialization IN ('engineering','algorithm','data')),
            display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
          INSERT INTO agents (id,role,specialization,display_name,created_at)
            SELECT id, CASE role WHEN 'worker' THEN 'research_worker' ELSE role END, specialization, display_name, created_at FROM agents_old;
          DROP TABLE agents_old;
        `);
      })(),
      "改名法在数据少时**不报错** —— 那正是危险处",
    ).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) n FROM project_assignments").get(),
      "而它静默清空了成员关系(负样本的判据:这条必须为 0,否则本条的结论被推翻,要重新判定)")
      .toEqual({ n: 0 });
    expect(db.pragma("foreign_key_check"), "而检查依旧干净 —— 所以检查也抓不住它").toEqual([]);
    db.close();
  });

  it("负样本:026 在**事务之外**应用会响亮失败(defer 需要事务)", async () => {
    // 不是缺陷,是**判据的边界**:`PRAGMA defer_foreign_keys` 需要一个提交点才能
    // 「推迟到提交时」。生产路径(`infra/migrations.ts`)天然包在 `db.transaction` 里;
    // 这一条钉的是「前提不成立时失败**响亮**」—— 静默删数据才是要防的。
    const db = await seeded025();
    const before = counts(db);
    expect(() => db.exec(migration026().sql)).toThrow(/FOREIGN KEY/i);
    expect(counts(db), "响亮失败之后什么都不该变").toEqual(before);
    db.close();
  });

  it("文件形态:两段重建 + 一处改名,登记进 INTENTIONAL_REBUILDS", () => {
    const sql = migration026().sql;
    const rebuilt = INTENTIONAL_REBUILDS.filter((r) => r.files.includes("026_worker_split_and_code_service.sql"));
    expect(rebuilt.map((r) => r.table).sort(), "026 重建的两张表必须逐条登记").toEqual(["agents", "artifacts"]);
    // 它是**重建表**那一类 ⇒ 允许出现 CREATE TABLE 同名;但中转表必须带前缀,
    // 免得与 016 的 `artifacts_backup` 撞名(撞名就被上面那条不变量抓红)。
    expect(createdTables(sql).filter((t) => t.endsWith("_backup")).every((t) => t.startsWith("m026_")),
      "中转表必须带 m026_ 前缀:与 016 的 artifacts_backup 撞名会被守卫抓到").toBe(true);
  });
});

/**
 * 027 · 工件正文落文件(`artifacts.body` → `body_path` / `body_sha256` / `body_bytes`
 *       / `commit_sha`)—— 设计 `docs/DESIGN-WORKSPACE.md` §4.1 / §5。
 *
 * 这一组守三件事:
 *   ① **空库上装得上**,四列形状正确(落点三列 NOT NULL、`commit_sha` 可空),
 *      而 `body` 真的没了(`SELECT body` 响亮报错,不是回一个空值);
 *   ② 被 `DROP TABLE` 带走的 **7** 条索引逐条原样重建(谓词 / DESC 不能丢),
 *      三个外键与三个闭集一字未变 —— 重建最容易静默漂的正是这两处;
 *   ③ **「老数据不要」是一条真的会响的约束**:非空库上 027 响亮失败并整体回滚,
 *      而不是静默清空 `artifacts` 与它的 CASCADE 子表(012/016 那类事故形态)。
 */
describe("027 工件正文落文件(重建 artifacts:body → 落点四列)", () => {
  function migration027() {
    const m = FILES.find((f) => f.version === 27);
    expect(m, "027 迁移文件缺失").toBeDefined();
    return m!;
  }

  /**
   * 到 026 为止的真 schema,**空表**。
   *
   * 「空」不是偷懒:027 的**前提**就是这一步 `artifacts` 是空的(输入 6:存量数据不要,
   * 用户会 reset)。非空那一支由下面第 6 条专门钉住。
   */
  async function upTo026() {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of FILES) {
      if (f.version >= 27) break;
      try {
        db.exec(f.sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (f.version === 2 && /vec0|no such module/i.test(msg)) continue;
        throw err;
      }
    }
    return db;
  }

  type Db = Awaited<ReturnType<typeof upTo026>>;

  /**
   * 应用 027。**必须走事务** —— 生产路径(`infra/migrations.ts`)就是
   * `db.transaction`,而第 1 步的前置检查失败时要靠它整体回滚(负样本钉这一条)。
   */
  function apply027(db: Db): void {
    db.transaction(() => { db.exec(migration027().sql); })();
  }

  /** 027 **之前**的工件写入(那时正文还在 `body` 列里)。 */
  function rawArtifact026(db: Db, id: string, projectId: string, authorId: string, body: string): void {
    db.prepare(
      `INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                              title, body, metadata_json, created_at, updated_at, work_id, deliverable_type)
       VALUES (?, ?, NULL, 'note', 'open', ?, '标题', ?, NULL, 1, 1, NULL, NULL)`,
    ).run(id, projectId, authorId, body);
  }

  /** 027 **之后**的工件写入(落点与哈希)。`commitSha` 传 null 是合法状态。 */
  function rawArtifact027(
    db: Db,
    id: string,
    projectId: string,
    authorId: string,
    bodyPath: string,
    commitSha: string | null,
  ): void {
    db.prepare(
      `INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                              title, body_path, body_sha256, body_bytes, metadata_json,
                              created_at, updated_at, work_id, deliverable_type, commit_sha)
       VALUES (?, ?, NULL, 'note', 'open', ?, '标题', ?, 'sha256-of-content', 7, NULL, 1, 1, NULL, NULL, ?)`,
    ).run(id, projectId, authorId, bodyPath, commitSha);
  }

  function seedProjectAndAgent(db: Db): { projectId: string; agentId: string } {
    db.exec(`
      INSERT INTO projects (id,name,client,goal,status,created_at)
        VALUES ('pj_1','项目','甲方','目标','active',1);
      INSERT INTO agents (id,role,specialization,display_name,created_at)
        VALUES ('pm','project_manager',NULL,'项目经理',1);
    `);
    return { projectId: "pj_1", agentId: "pm" };
  }

  const column = (db: Db, name: string) =>
    (db.pragma("table_info(artifacts)") as Array<{ name: string; type: string; notnull: number }>)
      .find((c) => c.name === name);

  const indexNames = (db: Db) =>
    (db.pragma("index_list(artifacts)") as Array<{ name: string }>)
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_autoindex"))
      .sort();

  it("正样本:空库上装得上;落点三列 NOT NULL、commit_sha 可空、body 不在", async () => {
    const db = await upTo026();
    expect(column(db, "body"), "前提不成立:026 的 schema 里 artifacts 应该还有 body 列").toBeDefined();
    apply027(db);

    expect(column(db, "body"), "027 之后 body 列必须消失(正文不再住库)").toBeUndefined();
    expect(column(db, "body_path")).toMatchObject({ type: "TEXT", notnull: 1 });
    expect(column(db, "body_sha256")).toMatchObject({ type: "TEXT", notnull: 1 });
    expect(column(db, "body_bytes")).toMatchObject({ type: "INTEGER", notnull: 1 });
    // `commit_sha` 是**后填**的 ⇒ 可空是判据的一部分(刚插行、还没提交)
    expect(column(db, "commit_sha")).toMatchObject({ type: "TEXT", notnull: 0 });

    // 正样本:四列真的写得进、读得回
    const { projectId, agentId } = seedProjectAndAgent(db);
    rawArtifact027(db, "a_1", projectId, agentId, "artifacts/a_1-report.html", null);
    expect(db.prepare("SELECT body_path, commit_sha FROM artifacts WHERE id='a_1'").get())
      .toEqual({ body_path: "artifacts/a_1-report.html", commit_sha: null });
    // 提交回填之后同一行读得出 sha
    db.prepare("UPDATE artifacts SET commit_sha = ? WHERE id = 'a_1'").run("deadbeef");
    expect(db.prepare("SELECT commit_sha FROM artifacts WHERE id='a_1'").get())
      .toEqual({ commit_sha: "deadbeef" });
    db.close();
  });

  it("负样本:SELECT body 响亮报错(不是回空),落点缺一列被 NOT NULL 拒", async () => {
    const db = await upTo026();
    apply027(db);
    const { projectId, agentId } = seedProjectAndAgent(db);

    // 自检正样本:同一支探针在**存在**的列上不报错 —— 否则下面那条可能是「什么都拒」
    expect(() => db.prepare("SELECT title FROM artifacts").all()).not.toThrow();
    expect(() => db.prepare("SELECT body FROM artifacts").all(),
      "body 列还在 —— 那就是「正文仍然住库」,读面会拿到一份假的正文").toThrow(/no such column: body/i);

    const insert = (id: string, bodyPath: string | null, sha: string | null, bytes: number | null) =>
      db.prepare(
        `INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                                title, body_path, body_sha256, body_bytes, metadata_json,
                                created_at, updated_at, work_id, deliverable_type, commit_sha)
         VALUES (?, ?, NULL, 'note', 'open', ?, '标题', ?, ?, ?, NULL, 1, 1, NULL, NULL, NULL)`,
      ).run(id, projectId, agentId, bodyPath, sha, bytes);

    expect(() => insert("a_missing_path", null, "s", 1), "body_path 缺失必须响亮被拒").toThrow(/NOT NULL/i);
    expect(() => insert("a_missing_sha", "artifacts/x.md", null, 1), "body_sha256 缺失必须响亮被拒").toThrow(/NOT NULL/i);
    expect(() => insert("a_missing_bytes", "artifacts/x.md", "s", null), "body_bytes 缺失必须响亮被拒").toThrow(/NOT NULL/i);
    // 正样本方向:三列齐了就写得进(证明上面三条不是「什么都拒」)
    expect(() => insert("a_ok", "artifacts/x.md", "s", 1)).not.toThrow();
    db.close();
  });

  it("正样本:7 条索引逐条重建 —— 名单、DESC 与部分谓词逐字不变", async () => {
    const db = await upTo026();
    const before = indexNames(db);
    expect(before, "026 之后 artifacts 上是 7 条索引;少了就说明读面在退化").toHaveLength(7);
    apply027(db);
    expect(indexNames(db), "DROP TABLE 会连索引一起丢掉 —— 027 必须把 7 条全部原样重建").toEqual(before);

    const sqlOf = (name: string) =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`).get(name) as
        | { sql: string }
        | undefined)?.sql ?? "";
    expect(sqlOf("idx_artifacts_work"), "部分索引的谓词丢了 = 静默退化成全表扫")
      .toMatch(/WHERE\s+work_id\s+IS\s+NOT\s+NULL/i);
    expect(sqlOf("idx_artifacts_deliverable"))
      .toMatch(/WHERE\s+deliverable_type\s+IS\s+NOT\s+NULL/i);
    expect(sqlOf("idx_artifacts_recent")).toMatch(/created_at\s+DESC/i);
    db.close();
  });

  it("正样本:三个外键与三个闭集一字未变(重建最容易静默漂的两处)", async () => {
    const db = await upTo026();
    const fkBefore = db.pragma("foreign_key_list(artifacts)") as Array<Record<string, unknown>>;
    apply027(db);
    const fkAfter = db.pragma("foreign_key_list(artifacts)") as Array<Record<string, unknown>>;
    expect(fkAfter, "外键及其动作(DROP/NO ACTION/SET NULL)必须逐条原样").toEqual(fkBefore);
    expect(
      fkAfter.map((f) => `${f.from}->${f.table}:${f.on_delete}`).sort(),
      "字面点名:漏一条就是静默的语义漂移",
    ).toEqual([
      "author_agent_id->agents:NO ACTION",
      "project_id->projects:CASCADE",
      "work_id->works:SET NULL",
    ]);

    const { projectId, agentId } = seedProjectAndAgent(db);
    const rejects = (sql: string, args: unknown[]) => {
      try { db.prepare(sql).run(...(args as never[])); return false; } catch { return true; }
    };
    const insertArtifact = (id: string, kind: string, status: string, dt: string | null) =>
      db.prepare(
        `INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                                title, body_path, body_sha256, body_bytes, metadata_json,
                                created_at, updated_at, work_id, deliverable_type, commit_sha)
         VALUES (?, ?, NULL, ?, ?, ?, '标题', 'artifacts/x.md', 's', 1, NULL, 1, 1, NULL, ?, NULL)`,
      ).run(id, projectId, kind, status, agentId, dt);

    // 正样本:合法取值写得进(否则下面四条负样本可能只是「什么都拒」)
    expect(() => insertArtifact("a_ok", "deliverable", "open", "code_service")).not.toThrow();
    // 负样本:kind 11 值闭集 / status 4 值闭集 / deliverable_type 2 值闭集都还有牙
    expect(() => insertArtifact("a_bad_kind", "nonsense", "open", null)).toThrow(/CHECK/i);
    expect(() => insertArtifact("a_bad_status", "note", "archived", null)).toThrow(/CHECK/i);
    expect(() => insertArtifact("a_bad_dt", "deliverable", "open", "git_repo")).toThrow(/CHECK/i);
    expect(() => insertArtifact("a_dt_null", "note", "open", null)).not.toThrow();
    db.close();
  });

  it("正样本:前置检查表不残留;外键与整体性检查干净", async () => {
    const db = await upTo026();
    apply027(db);
    expect(
      db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'm027_%'").get(),
      "中转 / 前置检查表用完必须删干净(留着会永久占一份工件快照)",
    ).toEqual({ n: 0 });
    expect(db.pragma("foreign_key_check"), "外键检查必须干净").toEqual([]);
    expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    db.close();
  });

  it("**前提**:非空库上 027 响亮失败,老行一条不少 —— 不做数据迁移 ⇒ 必须先 reset", async () => {
    const db = await upTo026();
    const { projectId, agentId } = seedProjectAndAgent(db);
    rawArtifact026(db, "a_old", projectId, agentId, "老正文");
    const before = db.prepare("SELECT id, title, body FROM artifacts ORDER BY id").all();

    expect(
      () => apply027(db),
      "非空库上 027 必须**响亮失败** —— 静默清空 artifacts(连同 CASCADE 子表)正是 012/016 的形态",
    ).toThrow(/requires_empty_artifacts/);
    // 失败整体回滚:行还在、正文还在、schema 还停在 026(body 列仍在)
    expect(db.prepare("SELECT id, title, body FROM artifacts ORDER BY id").all()).toEqual(before);
    expect(column(db, "body"), "失败之后 schema 不该被改到一半").toBeDefined();

    // 自检:把老行清掉(这正是「reset」的等价物)之后,同一份 SQL 必须装得上
    // —— 否则上面那条「响亮失败」可能只是「这条 SQL 永远失败」。
    db.prepare("DELETE FROM artifacts").run();
    expect(() => apply027(db)).not.toThrow();
    expect(column(db, "body_path")).toBeDefined();
    db.close();
  });

  it("文件形态:同名重建(不是 ALTER),没有数据搬运,登记进 INTENTIONAL_REBUILDS", () => {
    const sql = migration027().sql;
    // 登记:重名守卫要能命中,而且**只**登记 artifacts
    const rebuilt = INTENTIONAL_REBUILDS.filter((r) => r.files.includes("027_artifact_body_files.sql"));
    expect(rebuilt.map((r) => r.table), "027 重建的表必须逐条登记").toEqual(["artifacts"]);
    expect(createdTables(sql), "必须是**同名** CREATE TABLE:改名法会让上面那条登记当场过期")
      .toContain("artifacts");
    // 中转 / 前置检查表必须带 m027_ 前缀(与 016 的 artifacts_backup 撞名会被守卫抓红)
    expect(createdTables(sql).filter((t) => t !== "artifacts").every((t) => t.startsWith("m027_"))).toBe(true);
    // 「没有数据迁移」是可验证的:一行 INSERT … SELECT 都没有
    expect(stripSqlComments(sql), "027 不做数据迁移 —— 出现 INSERT INTO artifacts 就说明搬了老正文")
      .not.toMatch(/INSERT\s+INTO\s+artifacts/i);
    expect(stripSqlComments(sql)).not.toMatch(/ALTER\s+TABLE/i);
    // 响亮不静默:关键语句不带 IF NOT EXISTS / IF EXISTS
    expect(stripSqlComments(sql)).not.toMatch(/IF\s+(NOT\s+)?EXISTS/i);
  });
});
