/**
 * 探针 · 026 迁移:**真实文件**在真 schema + 非空子表数据上的行为
 *
 * 纪律:每个诊断先拿一个已知答案的样本自检 —— 一个必须命中的正样本 +
 * 一个必须不命中的负样本。两个都对上,才用它去看别的。
 *
 * 它回答四个问题:
 *   Q0  探测器本身没坏吗?(正/负样本自检)
 *   Q1  `migrations/026_*.sql` 在**每一条子表外键都有非空行**的库上:
 *       报不报错 / 全表行数变不变 / 外键检查干不干净 / 新闭集真的生效了吗?
 *   Q2  朴素重建(`DROP TABLE agents`)会怎样?——负样本:证明 defer 是必要的
 *   Q2b 改名重建法会怎样?——负样本:**为什么不用它**
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../migrations");

const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{3}_.+\.sql$/.test(f))
  .sort()
  .map((f) => ({ file: f, version: parseInt(f.slice(0, 3), 10), sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

const MIG026 = FILES.find((f) => f.version === 26);
if (MIG026 === undefined) throw new Error("migrations/026_*.sql 不存在");

function upTo(db, max) {
  for (const f of FILES) {
    if (f.version > max) break;
    try {
      db.exec(f.sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (f.version === 2 && /vec0|no such module|not loaded/i.test(msg)) continue;
      throw new Error(`${f.file}: ${msg}`);
    }
  }
}

/**
 * 造一份**每一条指向 agents / artifacts 的外键都有非空行**的库。
 *
 * ⚠️ 数据必须非空,否则「不变」是空的 —— 016 探针 B/C 的教训:
 *   artifact_links 1 → 0 而 foreign_key_check 干净,肉眼看不出差别。
 */
function seed(db) {
  db.exec(`
    INSERT INTO projects (id,name,client,goal,status,created_at)
      VALUES ('pj1','项目一','甲方','目标','active',1);
    INSERT INTO agents (id,role,specialization,display_name,created_at) VALUES
      ('bm','business_manager',NULL,'业务经理',1),
      ('pm','project_manager',NULL,'项目经理',1),
      ('wk','worker','engineering','工程师',1),
      ('qa','quality_reviewer',NULL,'质检',1);
    INSERT INTO project_assignments (project_id,agent_id,added_at) VALUES
      ('pj1','bm',1),('pj1','pm',1),('pj1','wk',1),('pj1','qa',1);
    INSERT INTO works (id,project_id,title,goal,status,assignee_agent_id,created_at,updated_at)
      VALUES ('w1','pj1','活儿','做完','open','wk',1,1);
    INSERT INTO works (id,project_id,title,goal,status,assignee_agent_id,created_at,updated_at)
      VALUES ('w2','pj1','活儿2','做完','open','qa',1,1);
    INSERT INTO work_deps (work_id,depends_on_work_id) VALUES ('w2','w1');
    INSERT INTO project_sessions (id,project_id,created_at,channel,kind,title)
      VALUES ('s1','pj1',1,'internal','main','主对话');
    INSERT INTO session_messages (id,session_id,agent_id,kind,content,created_at)
      VALUES ('m1','s1','wk','assistant','产出',1);
    INSERT INTO artifacts (id,project_id,kind,status,author_agent_id,title,body,created_at,updated_at,work_id)
      VALUES ('a1','pj1','evidence','open','wk','证据','正文',1,1,'w1');
    INSERT INTO artifacts (id,project_id,kind,status,author_agent_id,title,body,created_at,updated_at,deliverable_type)
      VALUES ('a2','pj1','deliverable','open','pm','交付','正文',1,1,'html_report');
    INSERT INTO artifact_links (artifact_id,rel,target_artifact_id) VALUES ('a2','depends_on','a1');
    INSERT INTO asks (id,project_id,from_agent_id,to_agent_id,question,hypothesis,status,created_at)
      VALUES ('as1','pj1','wk','pm','问题','假设','open',1);
    UPDATE asks SET resolution_artifact_id='a1' WHERE id='as1';
    INSERT INTO meetings (id,project_id,topic,status,convening_agent_id,created_at)
      VALUES ('mt1','pj1','对焦','in_progress','pm',1);
    INSERT INTO meeting_participants (meeting_id,agent_id,stance,responded_at) VALUES ('mt1','wk','support',1);
    INSERT INTO change_requests (id,project_id,title,rationale,status,created_at,decided_by_agent_id)
      VALUES ('c1','pj1','变更','理由','accepted',1,'pm');
    INSERT INTO change_affects (change_id,work_id) VALUES ('c1','w1');
    INSERT INTO blockers (id,project_id,raised_by_agent_id,title,detail,severity,status,created_at)
      VALUES ('b1','pj1','wk','阻塞','细节','high','open',1);
    INSERT INTO blocker_blocks (blocker_id,work_id) VALUES ('b1','w2');
    UPDATE project_sessions SET deliverable_artifact_id='a2' WHERE id='s1';
    INSERT INTO client_questions (question_artifact_id,project_id,asked_by,asked_at,answer_artifact_id,answered_at,consumed_at,consumed_by)
      VALUES ('a1','pj1','bm',1,'a2',2,3,'pm');
    INSERT INTO dispatch_events (project_id,kind,subject_id,summary,created_at,consumed_by)
      VALUES ('pj1','work_done','w1','干完了',1,'pm');
    INSERT INTO dispatch_attempts (project_id,todo_key,attempts,first_attempt_at,last_attempt_at)
      VALUES ('pj1','k',1,1,1);
    INSERT INTO turn_usage (id,project_id,session_id,agent_id,work_id,created_at)
      VALUES ('tu1','pj1','s1','wk','w1',1);
    INSERT INTO review_verdicts (work_id,project_id,verdict,severity,finding_artifact_id,reviewed_by,created_at)
      VALUES ('w1','pj1','pass','low','a1','qa',1);
  `);
}

/** 逐表行数快照 —— 重建的前后必须逐项相同。 */
const TABLES = [
  "agents", "project_assignments", "works", "work_deps", "project_sessions", "session_messages",
  "artifacts", "artifact_links", "asks", "meetings", "meeting_participants",
  "change_requests", "change_affects", "blockers", "blocker_blocks", "client_questions",
  "dispatch_events", "dispatch_attempts", "turn_usage", "review_verdicts",
];

function counts(db) {
  const out = {};
  for (const t of TABLES) out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return out;
}

/** 某张表上「指向 parent」的外键清单 —— 动态判据,不是 grep 历史文件。 */
function inboundFks(db, parent) {
  const out = [];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of tables) for (const fk of db.pragma(`foreign_key_list(${t})`)) if (fk.table === parent) out.push({ table: t, from: fk.from, onDelete: fk.on_delete });
  return out;
}

function indexesOf(db, table) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name")
    .all(table)
    .map((r) => r.name);
}

function newDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── Q0 自检:探测器没坏 ────────────────────────────────────────────
{
  const db = newDb();
  upTo(db, 25);
  check("Q0a 正样本:真 schema 能建起来(agents 表存在、空库 0 行)",
    db.prepare("SELECT COUNT(*) n FROM agents").get().n === 0);
  check("Q0b 负样本:不存在的表必须报错(不是静默 0)",
    (() => { try { db.prepare("SELECT COUNT(*) n FROM agents_typo").get(); return false; } catch { return true; } })());
  const fkAgents = inboundFks(db, "agents");
  const fkArtifacts = inboundFks(db, "artifacts");
  console.log(`    指向 agents 的外键 ${fkAgents.length} 条:CASCADE 的表 = ${[...new Set(fkAgents.filter((f) => f.onDelete === "CASCADE").map((f) => f.table))].join(",") || "(无)"}`);
  console.log(`    指向 artifacts 的外键 ${fkArtifacts.length} 条:CASCADE 的表 = ${[...new Set(fkArtifacts.filter((f) => f.onDelete === "CASCADE").map((f) => f.table))].join(",") || "(无)"}`);
  check("Q0c 正样本:指向 agents 的 CASCADE 只有 project_assignments",
    JSON.stringify([...new Set(fkAgents.filter((f) => f.onDelete === "CASCADE").map((f) => f.table))]) === JSON.stringify(["project_assignments"]));
  check("Q0d 正样本:指向 artifacts 的 CASCADE 是 artifact_links + client_questions" +
        "(**025 的注释清单漏了后者** —— 本条就是那条更正的判据)",
    JSON.stringify([...new Set(fkArtifacts.filter((f) => f.onDelete === "CASCADE").map((f) => f.table))].sort()) === JSON.stringify(["artifact_links", "client_questions"]));
  check("Q0e 负样本:错误表名的外键数必须是 0", inboundFks(db, "agentz").length === 0);
  db.close();
}

// ── Q1:真实迁移文件 026 的完整行为(正样本)──────────────────────────
{
  const db = newDb();
  upTo(db, 25);
  seed(db);
  const before = counts(db);
  const fkBefore = db.prepare("SELECT sql FROM sqlite_master WHERE name='project_assignments'").get().sql;
  const idxAgentsBefore = indexesOf(db, "agents");
  const idxArtifactsBefore = indexesOf(db, "artifacts");

  let err = null;
  try {
    db.transaction(() => { db.exec(MIG026.sql); })();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  check("Q1 迁移不报错", err === null, err ?? "");

  const after = counts(db);
  const diffs = TABLES.filter((t) => before[t] !== after[t]).map((t) => `${t}: ${before[t]}→${after[t]}`);
  check("Q1 全表行数逐项不变", diffs.length === 0, diffs.join(", "));

  check("Q1 foreign_key_check 干净", JSON.stringify(db.pragma("foreign_key_check")) === "[]",
    JSON.stringify(db.pragma("foreign_key_check")));
  check("Q1 提交后 defer_foreign_keys 自动复位(否则会漏给后续迁移)",
    db.pragma("defer_foreign_keys", { simple: true }) === 0,
    `实测 ${db.pragma("defer_foreign_keys", { simple: true })}`);
  check("Q1 中转表不残留",
    db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE '%_backup'").get().n === 0);
  check("Q1 索引一条不少也不多(agents)",
    JSON.stringify(idxAgentsBefore) === JSON.stringify(indexesOf(db, "agents")),
    `before=${idxAgentsBefore.join(",")} after=${indexesOf(db, "agents").join(",")}`);
  check("Q1 索引一条不少也不多(artifacts,7 条)",
    JSON.stringify(idxArtifactsBefore) === JSON.stringify(indexesOf(db, "artifacts")),
    `before=${idxArtifactsBefore.length} after=${indexesOf(db, "artifacts").length}`);
  check("Q1 project_assignments 的表定义逐字未变",
    fkBefore === db.prepare("SELECT sql FROM sqlite_master WHERE name='project_assignments'").get().sql);

  // 内容(不只是行数)
  check("Q1 worker 这个旧值在库里已不存在",
    db.prepare("SELECT COUNT(*) n FROM agents WHERE role='worker'").get().n === 0);
  check("Q1 wk 已改名为 research_worker 且 specialization 原样保留",
    JSON.stringify(db.prepare("SELECT role,specialization,display_name FROM agents WHERE id='wk'").get())
      === JSON.stringify({ role: "research_worker", specialization: "engineering", display_name: "工程师" }));
  check("Q1 project_assignments 的 agent_id 逐条还在",
    JSON.stringify(db.prepare("SELECT agent_id FROM project_assignments ORDER BY agent_id").all().map((r) => r.agent_id))
      === JSON.stringify(["bm", "pm", "qa", "wk"]));
  check("Q1 client_questions 的内容逐字不变(025 清单漏掉的那张表)",
    JSON.stringify(db.prepare("SELECT * FROM client_questions").get())
      === JSON.stringify({ question_artifact_id: "a1", project_id: "pj1", asked_by: "bm", asked_at: 1, answer_artifact_id: "a2", answered_at: 2, consumed_at: 3, consumed_by: "pm" }));
  check("Q1 asks 的作答边还在",
    db.prepare("SELECT resolution_artifact_id FROM asks WHERE id='as1'").get().resolution_artifact_id === "a1");
  check("Q1 project_sessions 的交付物边还在",
    db.prepare("SELECT deliverable_artifact_id FROM project_sessions WHERE id='s1'").get().deliverable_artifact_id === "a2");
  check("Q1 review_verdicts 的 finding 边还在",
    db.prepare("SELECT finding_artifact_id FROM review_verdicts WHERE work_id='w1'").get().finding_artifact_id === "a1");
  check("Q1 存量 deliverable 的 html_report 类型原样保留",
    db.prepare("SELECT deliverable_type FROM artifacts WHERE id='a2'").get().deliverable_type === "html_report");

  // 新闭集真的生效了吗 —— 四个方向,缺一个都说明检查是装饰
  const rejects = (sql) => { try { db.exec(sql); return false; } catch { return true; } };
  check("Q1 负样本:旧角色值 'worker' 现在必须被拒",
    rejects("INSERT INTO agents VALUES ('x1','worker',NULL,'旧名',1)"));
  check("Q1 正样本:两个新角色值必须可写",
    (() => { try { db.exec("INSERT INTO agents VALUES ('x4','research_worker','algorithm','研究员',1)"); db.exec("INSERT INTO agents VALUES ('x5','coding_worker','engineering','工程师',1)"); return true; } catch (e) { return String(e); } })() === true);
  check("Q1 负样本:业务经理带 specialization 必须被触发器拒",
    rejects("INSERT INTO agents VALUES ('x3','business_manager','data','越权',1)"));
  check("Q1 负样本:artifact 上未定义的类型 'git_repo' 仍被拒",
    rejects("UPDATE artifacts SET deliverable_type='git_repo' WHERE id='a2'"));
  check("Q1 正样本:artifact 上 'code_service' 现在可写",
    (() => { try { db.exec("UPDATE artifacts SET deliverable_type='code_service' WHERE id='a2'"); return true; } catch (e) { return String(e); } })() === true);
  check("Q1 正样本:deliverable_type 仍然可空(存量行合法)",
    (() => { try { db.exec("UPDATE artifacts SET deliverable_type=NULL WHERE id='a2'"); return true; } catch (e) { return String(e); } })() === true);
  db.close();
}

// ── Q2:朴素重建(负样本:证明 defer 不是装饰)──────────────────────
{
  const db = newDb();
  upTo(db, 25);
  seed(db);
  const before = counts(db);
  let err = null;
  try {
    db.transaction(() => { db.exec("DROP TABLE agents;"); })();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  check("Q2 朴素 DROP TABLE agents 响亮失败(不是静默清空)", err !== null, err ?? "(没有报错 —— 那才是危险形态)");
  check("Q2 失败后事务回滚,全表行数不变", JSON.stringify(counts(db)) === JSON.stringify(before));
  db.close();
}

// ── Q2b:改名重建法(负样本:为什么不用它)──────────────────────────
{
  // (a) 最小数据:只有 project_assignments 有行
  const minDb = newDb();
  upTo(minDb, 25);
  minDb.exec(`
    INSERT INTO projects (id,name,client,goal,status,created_at) VALUES ('pj1','p','c','g','active',1);
    INSERT INTO agents (id,role,display_name,created_at) VALUES ('wk','worker','工程师',1),('qa','quality_reviewer','质检',1);
    INSERT INTO project_assignments (project_id,agent_id,added_at) VALUES ('pj1','wk',1),('pj1','qa',1);
  `);
  const minBefore = minDb.prepare("SELECT COUNT(*) n FROM project_assignments").get().n;
  let minErr = null;
  try {
    minDb.transaction(() => {
      minDb.exec(`
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
    })();
  } catch (e) { minErr = e instanceof Error ? e.message : String(e); }
  check("Q2b(a) 最小数据上改名法**不报错**(看起来是安全的)", minErr === null, minErr ?? "");
  const minAfter = minDb.prepare("SELECT COUNT(*) n FROM project_assignments").get().n;
  check("Q2b(a) 但它静默清空了 project_assignments(危险形态)",
    minBefore > 0 && minAfter === 0, `${minBefore} → ${minAfter}`);
  check("Q2b(a) 而 foreign_key_check 依旧干净(所以检查也抓不住)",
    JSON.stringify(minDb.pragma("foreign_key_check")) === "[]");
  minDb.close();

  // (b) 真机形态(子表全非空):同一套 SQL 响亮失败
  const db = newDb();
  upTo(db, 25);
  seed(db);
  let err = null;
  try {
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
    })();
  } catch (e) { err = e instanceof Error ? e.message : String(e); }
  check("Q2b(b) 真机形态上同一套 SQL 响亮失败 —— 「在我机器上它报错了」不可移植",
    err !== null, err ?? "(没报错 —— 那就推翻本条的结论,重新判定)");
  db.close();
}

console.log("");
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} 通过`);
if (bad.length > 0) process.exit(1);
