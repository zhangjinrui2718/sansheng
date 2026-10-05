/**
 * 018 · `turn_usage`(纯加法:一条 `CREATE TABLE` + 一条 `CREATE INDEX`)
 *
 * ── 这个 describe 守什么 ────────────────────────────────────────
 *
 * 018 是**纯加法**:库里多一张新表,任何既有表一个字节都不动。这类迁移的失效
 * 方式与 012/015/016 那些重建表**不同**,所以守卫的重点也不同:
 *
 *   · 重建表的失效是「DROP 的隐式 DELETE 级联删掉子表 / 索引随 DROP 消失」;
 *   · 纯加法的失效是**写错形状**:列少一个、NOT NULL 写反、外键动作写成
 *     CASCADE(于是删项目顺手删掉账)、索引漏建(于是「今日/最近 7 天」退化成
 *     全表扫)—— 这些**一条都不会报错**。
 *
 * 所以这里逐条钉住:列结构、三条外键及其动作、索引与谓词、三条外键的**负样本**
 * (悬空引用必须被拒),以及**存量表逐字不变**。
 *
 * ── 为什么逐字对比前先断言「样本非空」──────────────────────────
 *
 * 在空表上做「前后逐字相等」永远成立 —— 那是**看起来正常的错答案**
 * (AGENTS.md「三类静默失败」第 3 条)。所以每个快照都先断言它真的有行。
 *
 * ── 登记问题 ────────────────────────────────────────────────────
 *
 * `MIGRATIONS` 的重名守卫(`tests/platform/migrations.test.ts` 的
 * `INTENTIONAL_REBUILDS`)**不需要**为 018 登记:本表 `turn_usage` 只被这一个
 * 迁移创建(下面有一条断言就地核对这一点),不是重建。**该文件一行都不用改。**
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

/** 与 migrations.test.ts 同一套:先剥注释再解析(注释里就写着那些 DDL 词)。 */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}
function createdTables(sql: string): string[] {
  return [...stripSqlComments(sql).matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)]
    .map((m) => m[1]!)
    .filter((t) => !/^(if|not|exists)$/i.test(t));
}

describe("018 turn_usage(纯加法:一条 CREATE TABLE + 一条索引)", () => {
  /** 到 `maxVersion` 为止的真 schema(002 的 vec0 不可用时跳过,与既有守卫同形)。 */
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

  function migration018() {
    const m = FILES.find((f) => f.version === 18);
    expect(m, "018 迁移文件缺失").toBeDefined();
    return m!;
  }

  /**
   * 一个**有数据**的 017 库:projects / works / artifacts / session_messages /
   * project_sessions / agents 六张表都要有行,否则「逐字不变」是在空集上成立的废话。
   */
  async function seeded017() {
    const db = await upTo(17);
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('wk','worker','engineering','工人',1)`);
    db.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
             VALUES ('bm','business_manager',NULL,'业务经理',1)`);
    db.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
             VALUES ('pj_1','语音机器人调研','甲方','目标','active',1)`);
    db.exec(`INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
             VALUES ('w_1','pj_1',NULL,'跑一轮对比','拿到三条路线的实测','in_progress','wk',1,1)`);
    db.exec(`INSERT INTO works (id,project_id,parent_work_id,title,goal,status,assignee_agent_id,created_at,updated_at)
             VALUES ('w_2','pj_1','w_1','子项','子目标','done','wk',2,2)`);
    db.exec(`INSERT INTO artifacts (id,project_id,conversation_id,kind,status,author_agent_id,
                                    title,body,metadata_json,created_at,updated_at,work_id)
             VALUES ('a_1','pj_1',NULL,'evidence','open','wk','实测记录','正文 \\ 带转义"与引号',NULL,3,3,'w_1')`);
    db.exec(`INSERT INTO project_sessions (id,project_id,created_at)
             VALUES ('s_1','pj_1',4)`);
    db.exec(`INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
             VALUES ('m_1','s_1',NULL,'user','甲方说:"我要三条路线的对比" \\ 现场',5)`);
    db.exec(`INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
             VALUES ('m_2','s_1','bm','assistant','收到,先看约束',6)`);
    return db;
  }

  type Db = Awaited<ReturnType<typeof seeded017>>;

  /** 存量快照 —— **只看既有表**;新表在不在不污染这一份对比。 */
  const snapshot = (db: Db) => ({
    agents: db.prepare(`SELECT * FROM agents ORDER BY id`).all(),
    projects: db.prepare(`SELECT * FROM projects ORDER BY id`).all(),
    works: db.prepare(`SELECT * FROM works ORDER BY id`).all(),
    artifacts: db.prepare(`SELECT * FROM artifacts ORDER BY id`).all(),
    sessions: db.prepare(`SELECT * FROM project_sessions ORDER BY id`).all(),
    messages: db.prepare(`SELECT * FROM session_messages ORDER BY id`).all(),
  });

  const tableExists = (db: Db, name: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { n: number }).n;

  // ── 1. 负样本:018 之前没有这张表(证明下一条断言有牙)────────
  it("**负样本**:018 之前 `turn_usage` 不存在(否则「迁移建了表」这条断言是空的)", async () => {
    const db = await upTo(17);
    expect(tableExists(db, "turn_usage"), "017 的 schema 里已经有 turn_usage?那 018 的 CREATE TABLE 会撞名").toBe(0);
    expect(
      () => db.exec(`INSERT INTO turn_usage (id) VALUES ('x')`),
      "表不该存在 —— 这条报错正是「迁移真的建了表」的对照面",
    ).toThrow(/no such table/i);
    db.close();
  });

  // ── 2. 纯加法:存量表逐字不变 ─────────────────────────────────
  it("**存量数据零影响**:018 只 CREATE,projects/works/artifacts/session_messages/project_sessions/agents 逐字不变", async () => {
    const db = await seeded017();
    const before = snapshot(db);
    // 正样本自检:样本非空,逐字对比才有意义
    expect(before.projects, "projects 样本是空的 —— 逐字对比失去意义").toHaveLength(1);
    expect(before.works).toHaveLength(2);
    expect(before.artifacts).toHaveLength(1);
    expect(before.sessions).toHaveLength(1);
    expect(before.messages).toHaveLength(2);
    expect(before.agents).toHaveLength(2);

    db.exec(migration018().sql);

    expect(tableExists(db, "turn_usage"), "018 没有把表建出来").toBe(1);
    expect(snapshot(db), "018 动了存量数据 —— 纯加法不该改任何一张既有表").toEqual(before);
    db.close();
  });

  // ── 3. 列结构:与迁移文件里的定义逐个字段一致 ─────────────────
  it("列结构与你/我写下的定义一致(名字 / 类型 / NOT NULL / DEFAULT / 主键)", async () => {
    const db = await seeded017();
    db.exec(migration018().sql);
    const cols = (db.pragma("table_info(turn_usage)") as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>).map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }));
    expect(cols, "列清单/可空性/默认值/主键漂了 —— 这一层不对,写入侧的形状假设全部作废").toEqual([
      { name: "id", type: "TEXT", notnull: 0, dflt: null, pk: 1 },
      // ⚠️ **可空是刻意的**:接待会话(还没有项目)也要落账 —— 见 migration 018 文件头
      { name: "project_id", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
      // 刻意**无外键**:`adoptIntakeMessages` 立项后会真删掉接待会话行
      { name: "session_id", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
      { name: "agent_id", type: "TEXT", notnull: 1, dflt: null, pk: 0 },
      { name: "work_id", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
      { name: "model", type: "TEXT", notnull: 0, dflt: null, pk: 0 },
      { name: "input_tokens", type: "INTEGER", notnull: 1, dflt: "0", pk: 0 },
      { name: "output_tokens", type: "INTEGER", notnull: 1, dflt: "0", pk: 0 },
      { name: "cache_read", type: "INTEGER", notnull: 1, dflt: "0", pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, dflt: null, pk: 0 },
    ]);
    db.close();
  });

  // ── 4. 三条外键 + 动作(顺序无关,按 from 排序比)──────────────
  it("三条外键:projects CASCADE · agents NO ACTION · works SET NULL;`session_id` **没有**外键", async () => {
    const db = await seeded017();
    db.exec(migration018().sql);
    const fks = (db.pragma("foreign_key_list(turn_usage)") as Array<{
      table: string; from: string; to: string; on_delete: string; on_update: string;
    }>)
      // ⚠️ `foreign_key_list` 的顺序是 SQLite 的实现细节(通常是声明顺序的**倒序**),
      //    所以按 `from` 排序再比 —— 否则「顺序变了」会被误报成「形状变了」。
      .map((fk) => ({ from: fk.from, table: fk.table, to: fk.to, onDelete: fk.on_delete }))
      .sort((a, b) => a.from.localeCompare(b.from));
    expect(fks, "外键的形状变了 —— 删项目/删角色/删工作项时的行为跟着变").toEqual([
      { from: "agent_id", table: "agents", to: "id", onDelete: "NO ACTION" },
      { from: "project_id", table: "projects", to: "id", onDelete: "CASCADE" },
      { from: "work_id", table: "works", to: "id", onDelete: "SET NULL" },
    ]);
    expect(
      fks.some((fk) => fk.from === "session_id"),
      "`session_id` 上不该有外键:接待会话在立项后会被 `adoptIntakeMessages` **真的删掉**," +
        "带 CASCADE 的外键会让那几笔用量静默消失",
    ).toBe(false);
    db.close();
  });

  // ── 5. 索引(项目页「今日 / 最近 7 天」的判据)────────────────
  it("索引 `idx_turn_usage_project_time` 在,且列序与 DESC 都在(丢了就退化成全表扫)", async () => {
    const db = await seeded017();
    db.exec(migration018().sql);
    const idx = (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='turn_usage'`)
      .all() as Array<{ name: string; sql: string | null }>).filter((r) => !r.name.startsWith("sqlite_autoindex"));
    expect(idx.map((r) => r.name), "索引集合变了(多一条/少一条都要在这里说出来)").toEqual([
      "idx_turn_usage_project_time",
    ]);
    expect(idx[0]!.sql ?? "").toMatch(/\(\s*project_id\s*,\s*created_at\s+DESC\s*\)/i);
    // 用 EXPLAIN 证明优化器**真的**会用它(而不是只看它存在)
    const plan = (db.prepare(`EXPLAIN QUERY PLAN
      SELECT SUM(input_tokens), SUM(output_tokens) FROM turn_usage
      WHERE project_id = 'pj_1' AND created_at >= 0`).all() as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" | ");
    expect(plan, "「按项目按时间」的查询没有走这条索引 —— 索引建了但没用上").toMatch(/idx_turn_usage_project_time/);
    db.close();
  });

  it("`foreign_key_check` 与 `integrity_check` 干净(形状合法、无悬空引用)", async () => {
    const db = await seeded017();
    db.exec(migration018().sql);
    db.exec(`INSERT INTO turn_usage (id,project_id,session_id,agent_id,work_id,model,
                                     input_tokens,output_tokens,cache_read,created_at)
             VALUES ('tu_1','pj_1','s_1','wk','w_1','MiniMax-M3',100,20,5,10)`);
    // 接待会话那一行:没有项目、没有会话行,只有角色 —— 必须写得进去
    db.exec(`INSERT INTO turn_usage (id,project_id,session_id,agent_id,work_id,model,
                                     input_tokens,output_tokens,cache_read,created_at)
             VALUES ('tu_intake',NULL,NULL,'bm',NULL,NULL,7,3,0,11)`);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect((db.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check).toBe("ok");
    expect(
      (db.prepare(`SELECT id, project_id, session_id, agent_id, work_id, model, input_tokens, output_tokens, cache_read, created_at
                   FROM turn_usage ORDER BY id`).all()),
    ).toEqual([
      { id: "tu_1", project_id: "pj_1", session_id: "s_1", agent_id: "wk", work_id: "w_1",
        model: "MiniMax-M3", input_tokens: 100, output_tokens: 20, cache_read: 5, created_at: 10 },
      { id: "tu_intake", project_id: null, session_id: null, agent_id: "bm", work_id: null,
        model: null, input_tokens: 7, output_tokens: 3, cache_read: 0, created_at: 11 },
    ]);
    db.close();
  });

  // ── 6. 三条外键的负样本:悬空引用必须**响亮**被拒 ───────────────
  it("**负样本**:`project_id` 悬空 → 被外键拒(而 `NULL` 是合法值 —— 接待会话)", async () => {
    const db = await seeded017();
    db.exec(migration018().sql);
    db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,created_at) VALUES ('tu_ok','pj_1','wk',1)`);
    db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,created_at) VALUES ('tu_null',NULL,'wk',2)`);
    expect(
      () => db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,created_at) VALUES ('tu_bad','pj_不存在','wk',3)`),
      "悬空 project_id 必须被拒 —— 否则「这个项目的用量」会算进一个不存在的项目",
    ).toThrow(/FOREIGN KEY constraint failed/i);
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM turn_usage`).get() as { n: number }).n,
      "被拒的那一行不该留下任何痕迹",
    ).toBe(2);
    db.close();
  });

  it("**负样本**:`agent_id` 悬空 → 被外键拒;而 `NOT NULL` 让「没有角色的用量」写不进来", async () => {
    const db = await seeded017();
    db.exec(migration018().sql);
    db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,created_at) VALUES ('tu_ok','pj_1','wk',1)`);
    expect(
      () => db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,created_at) VALUES ('tu_bad','pj_1','wk_不存在',2)`),
      "悬空 agent_id 必须被拒 —— 角色属性只有一处真相,用量行不许发明一个角色",
    ).toThrow(/FOREIGN KEY constraint failed/i);
    expect(
      () => db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,created_at) VALUES ('tu_norole','pj_1',NULL,3)`),
      "agent_id 必须 NOT NULL —— 「谁花的」不能没有答案",
    ).toThrow(/NOT NULL constraint failed/i);
    db.close();
  });

  it("**负样本**:`work_id` 悬空 → 被拒;NULL 合法(聊天/汇报回合不挂工作项)", async () => {
    const db = await seeded017();
    db.exec(migration018().sql);
    db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,work_id,created_at) VALUES ('tu_ok','pj_1','wk','w_1',1)`);
    db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,work_id,created_at) VALUES ('tu_null','pj_1','wk',NULL,2)`);
    expect(
      () => db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,work_id,created_at) VALUES ('tu_bad','pj_1','wk','w_不存在',3)`),
    ).toThrow(/FOREIGN KEY constraint failed/i);
    db.close();
  });

  // ── 7. 两个删除方向的行为(**动作写错就是静默丢账** )──────────
  it("删工作项 **不删**用量(SET NULL);删项目 **会** 带走它的用量(CASCADE)—— 如实钉住", async () => {
    const db = await seeded017();
    db.exec(migration018().sql);
    db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,work_id,created_at) VALUES ('tu_1','pj_1','wk','w_1',1)`);
    db.exec(`INSERT INTO turn_usage (id,project_id,agent_id,created_at) VALUES ('tu_2','pj_1','wk',2)`);

    // 删工作项:那一行的 work_id 变 NULL,行**还在**(钱已经花掉了,是既成事实)
    db.exec(`DELETE FROM works WHERE id = 'w_1'`);
    expect(
      db.prepare(`SELECT id, work_id FROM turn_usage ORDER BY id`).all(),
      "删工作项把用量行一起删了(或没把所有引用置 NULL)—— 动作该是 SET NULL,不是 CASCADE",
    ).toEqual([
      { id: "tu_1", work_id: null },
      { id: "tu_2", work_id: null },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);

    // 删项目:该项目的用量随项目消失(CASCADE —— 项目没了,「这个项目花了多少」不再有读者)
    db.exec(`DELETE FROM projects WHERE id = 'pj_1'`);
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM turn_usage`).get() as { n: number }).n,
      "project_id 的动作是 CASCADE:项目被删时它的用量行也走 —— 这是刻意的(与 ON DELETE SET NULL 的区别就在这一条)",
    ).toBe(0);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  // ── 8. 全 schema 核对:引用 works 的外键 6 → 7 ────────────────
  it("**全 schema 核对**:引用 `works` 的外键从 6 条变 **7** 条(第 7 条是本表的 work_id)", async () => {
    const db = await seeded017();
    const referrers = (d: Db) => {
      const tables = (d.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      ).all() as Array<{ name: string }>).map((r) => r.name);
      const found: Array<{ table: string; from: string; onDelete: string }> = [];
      const referenced = new Set<string>();
      for (const t of tables) {
        for (const fk of d.pragma(`foreign_key_list(${t})`) as Array<{
          table: string; from: string; on_delete: string;
        }>) {
          referenced.add(fk.table);
          if (fk.table === "works") found.push({ table: t, from: fk.from, onDelete: fk.on_delete });
        }
      }
      // 正样本自检:探测器真的看得见外键
      expect(referenced.has("projects"), "探测器坏了:projects 明明被多张表引用").toBe(true);
      return found.map((f) => `${f.table}.${f.from}`).sort();
    };
    const before = referrers(db);
    expect(before, "017 schema 里引用 works 的外键不是 6 条 —— 基准漂了").toEqual([
      "artifacts.work_id",
      "blocker_blocks.work_id",
      "change_affects.work_id",
      "work_deps.depends_on_work_id",
      "work_deps.work_id",
      "works.parent_work_id",
    ]);
    db.exec(migration018().sql);
    expect(referrers(db), "引用 works 的外键集合变了 —— 将来重建 works 时必须知道这一条边").toEqual([
      "artifacts.work_id",
      "blocker_blocks.work_id",
      "change_affects.work_id",
      "turn_usage.work_id",
      "work_deps.depends_on_work_id",
      "work_deps.work_id",
      "works.parent_work_id",
    ]);
    db.close();
  });

  // ── 9. 文件形态(纯加法 / 无 IF NOT EXISTS / 不登记)──────────
  it("文件形态:一条 CREATE TABLE + 一条 CREATE INDEX,**一行 DROP 都没有**,且**不带 IF NOT EXISTS**", () => {
    const sql = migration018().sql;
    const body = stripSqlComments(sql);
    expect(createdTables(sql), "018 只该建 `turn_usage` 这一张表").toEqual(["turn_usage"]);
    expect(body, "018 里出现了 DROP —— 纯加法不该有它").not.toMatch(/\bDROP\b/i);
    expect(body, "018 里出现了 ALTER —— 它不该碰任何既有表").not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(
      body,
      "`IF NOT EXISTS` 会把「撞名」变成静默无操作 —— 本文件的纪律是响亮报错(与 015/016 同)",
    ).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    const indexes = [...body.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+([a-z_0-9]+)\s+ON\s+([a-z_][a-z0-9_]*)/gi)]
      .map((m) => `${m[2]}.${m[1]}`);
    expect(indexes, "索引清单变了(项目页的查询形态跟着变)").toEqual([
      "turn_usage.idx_turn_usage_project_time",
    ]);
    // 重名面:全仓只有这一个迁移创建 `turn_usage` ⇒ 不需要登记进 INTENTIONAL_REBUILDS
    const owners = FILES.filter((f) => createdTables(f.sql).includes("turn_usage")).map((f) => f.file);
    expect(owners, "`turn_usage` 被多个迁移创建 —— 那才需要登记;现在不该发生").toEqual(["018_turn_usage.sql"]);
  });

  // ── 10. 变异验证:上面的断言真的有牙吗 ────────────────────────
  it("**变异验证**:把三个关键成分分别拿掉,对应的判据必须立刻不成立", async () => {
    // ① `project_id NOT NULL`(主会话最初给的形状)→ 接待会话那一行根本写不进去。
    //    这一条正是「形状改了」的实测依据:不是审美,是那条路径上项目还不存在。
    const strict = await upTo(17);
    strict.exec(`CREATE TABLE turn_usage (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT, agent_id TEXT NOT NULL REFERENCES agents(id),
      work_id TEXT REFERENCES works(id) ON DELETE SET NULL, model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    expect(
      () => strict.exec(`INSERT INTO turn_usage (id,project_id,agent_id,created_at) VALUES ('tu_intake',NULL,'bm',1)`),
      "NOT NULL 版本必须拒绝「还没有项目」的那一行 —— 上面那条「可空」断言不是空话",
    ).toThrow(/NOT NULL constraint failed/i);
    strict.close();

    // ② `session_id` 带 CASCADE 外键 → 立项删掉接待会话时,那几笔用量**静默消失**。
    const withFk = await upTo(17);
    withFk.exec(`INSERT INTO projects (id,name,client,goal,status,created_at)
                 VALUES ('pj_1','p','c','g','active',1)`);
    withFk.exec(`INSERT INTO agents (id,role,specialization,display_name,created_at)
                 VALUES ('bm','business_manager',NULL,'业务经理',1)`);
    withFk.exec(`INSERT INTO project_sessions (id,project_id,created_at) VALUES ('s_1','pj_1',1)`);
    withFk.exec(`CREATE TABLE turn_usage (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES project_sessions(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      work_id TEXT REFERENCES works(id) ON DELETE SET NULL, model TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    withFk.exec(`INSERT INTO turn_usage (id,project_id,session_id,agent_id,created_at) VALUES ('tu_1','pj_1','s_1','bm',1)`);
    withFk.exec(`DELETE FROM project_sessions WHERE id = 's_1'`);
    expect(
      (withFk.prepare(`SELECT COUNT(*) n FROM turn_usage`).get() as { n: number }).n,
      "带 CASCADE 外键时,删会话把用量行一起删了 —— 这就是 018 刻意不建这条外键的理由",
    ).toBe(0);
    expect(withFk.pragma("foreign_key_check"), "而且 `foreign_key_check` 一声不响").toEqual([]);
    withFk.close();

    // ③ 漏建索引 → 索引断言立刻红
    const noIdx = await upTo(17);
    noIdx.exec(stripSqlComments(migration018().sql).replace(/CREATE INDEX[\s\S]*?;/, ""));
    expect(
      (noIdx.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_turn_usage_project_time'`)
        .get() as { n: number }).n,
      "少了这条索引,上面「索引在」的断言不可能成立",
    ).toBe(0);
    noIdx.close();
  });
});
