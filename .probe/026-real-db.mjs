/**
 * 探针 · 026 在**真机库副本**上的行为(不碰真库:只读副本上跑)
 *
 * 判据(全部是「前后对比」,不是「没报错」):
 *   ① 逐表行数逐项不变(尤其 `client_questions` —— 025 的清单漏了它)
 *   ② `foreign_key_check` 干净
 *   ③ `agents.role` 里不再有 `worker`,且 `wk` 的 specialization 原样保留
 *   ④ `project_assignments` 的成员关系逐条还在
 *   ⑤ 007 那个触发器(AFTER 重建)对新闭集的判定真的生效
 *   ⑥ **组织对齐**:`ensureOrg` + `syncOrgForExistingProjects` 之后,`cw` 进入全部 4 个项目
 *   ⑦ 交付物类型:存量 1 条 html_report 原样保留,新增 code_service 可写、git_repo 仍被拒
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const REAL = join(process.env.HOME ?? "", ".sansheng", "sansheng.db");

const scratch = mkdtempSync(join(tmpdir(), "sansheng-026-real-"));
const copy = join(scratch, "sansheng.db");

// ⚠️ **不许 `copyFileSync`。** 真库跑在 WAL 模式:`-wal` 里可能压着几 MB 还没回写的
// 数据,只拷 `.db` 得到的是**上一次 checkpoint 的快照** —— 本探针第一版就是这样,
// 结果副本里只有 3 个项目而真库有 4 个(the live 库的 `-wal` 有 3.0 MB)。
// 那种残缺**不会报错**:迁移照样成功、行数照样「前后一致」,而它证明的是一个
// 比真机库小的库。⇒ 用 `VACUUM INTO` 要一份**一致快照**(只读连接上也能跑)。
{
  const ro = new Database(REAL, { readonly: true });
  ro.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  ro.close();
}

const FILES = readdirSync(join(ROOT, "migrations"))
  .filter((f) => /^\d{3}_.+\.sql$/.test(f))
  .sort()
  .map((f) => ({ file: f, version: parseInt(f.slice(0, 3), 10), sql: readFileSync(join(ROOT, "migrations", f), "utf8") }));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const db = new Database(copy);
db.pragma("foreign_keys = ON");

const TABLES = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
const counts = () => Object.fromEntries(TABLES().map((t) => [t, db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));

const before = counts();
const agentsBefore = db.prepare("SELECT id,role,specialization,display_name FROM agents ORDER BY id").all();
const membersBefore = db.prepare("SELECT project_id,agent_id,added_at,removed_at FROM project_assignments ORDER BY project_id,agent_id").all();
const cqBefore = db.prepare("SELECT * FROM client_questions ORDER BY question_artifact_id").all();
const delivBefore = db.prepare("SELECT id,deliverable_type FROM artifacts WHERE kind='deliverable' ORDER BY id").all();

check("前置:真机库停在 025(max=25)", db.prepare("SELECT MAX(version) v FROM schema_version").get().v === 25);

// ── 自检:副本必须是**完整快照**(WAL 那个坑的判据)──
{
  const ro = new Database(REAL, { readonly: true });
  const realN = ro.prepare("SELECT COUNT(*) n FROM projects").get().n;
  const realArt = ro.prepare("SELECT COUNT(*) n FROM artifacts").get().n;
  ro.close();
  const copyN = db.prepare("SELECT COUNT(*) n FROM projects").get().n;
  const copyArt = db.prepare("SELECT COUNT(*) n FROM artifacts").get().n;
  check(`副本是完整快照(projects ${copyN}/${realN} · artifacts ${copyArt}/${realArt})`,
    copyN === realN && copyArt === realArt);
}

// ── 跑 026(与迁移器同形:包在事务里)──
const mig = FILES.find((f) => f.version === 26);
let err = null;
try {
  db.transaction(() => { db.exec(mig.sql); })();
} catch (e) { err = e instanceof Error ? e.message : String(e); }
check("026 应用不报错", err === null, err ?? "");

const after = counts();
const diffs = Object.keys(before).filter((t) => before[t] !== after[t]).map((t) => `${t}: ${before[t]}→${after[t]}`);
check("逐表行数逐项不变(全库所有表)", diffs.length === 0, diffs.join(", ") || `${Object.keys(before).length} 张表`);
check("foreign_key_check 干净", JSON.stringify(db.pragma("foreign_key_check")) === "[]");
check("defer_foreign_keys 提交后复位", db.pragma("defer_foreign_keys", { simple: true }) === 0);
check("中转表不残留", db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'm026_%'").get().n === 0);

check("agents 里不再有 worker", db.prepare("SELECT COUNT(*) n FROM agents WHERE role='worker'").get().n === 0);
const wk = db.prepare("SELECT role,specialization,display_name FROM agents WHERE id='wk'").get();
check("wk → research_worker,specialization 原样保留", wk.role === "research_worker" && wk.specialization === "engineering", JSON.stringify(wk));
check("四个 agent 一行不少(名字还没被校准 —— 那是 ensureOrg 的活)",
  db.prepare("SELECT COUNT(*) n FROM agents").get().n === agentsBefore.length);

check("project_assignments 逐条未变(含 removed_at)",
  JSON.stringify(db.prepare("SELECT project_id,agent_id,added_at,removed_at FROM project_assignments ORDER BY project_id,agent_id").all()) === JSON.stringify(membersBefore));
check("client_questions 逐条未变(025 清单漏掉的那张表)",
  JSON.stringify(db.prepare("SELECT * FROM client_questions ORDER BY question_artifact_id").all()) === JSON.stringify(cqBefore));
check("存量交付物类型原样保留(1 条 html_report)",
  JSON.stringify(db.prepare("SELECT id,deliverable_type FROM artifacts WHERE kind='deliverable' ORDER BY id").all()) === JSON.stringify(delivBefore),
  `before=${JSON.stringify(delivBefore)}`);

// ── 触发器与闭集 ──
const rejects = (sql) => { try { db.exec(sql); return false; } catch { return true; } };
check("触发器仍拒非执行角色带 specialization",
  rejects("INSERT INTO agents VALUES ('x1','business_manager','data','越权',1)"));
check("两个新执行角色都能带 specialization",
  (() => { try { db.exec("INSERT INTO agents VALUES ('x2','research_worker','algorithm','研究员',1); INSERT INTO agents VALUES ('x3','coding_worker','engineering','工程师',1)"); return true; } catch { return false; } })());
check("交付物类型:code_service 可写、git_repo 仍被拒",
  (() => {
    const id = db.prepare("SELECT id FROM artifacts WHERE kind='deliverable' LIMIT 1").get()?.id;
    if (!id) return true;
    const okCs = !rejects(`UPDATE artifacts SET deliverable_type='code_service' WHERE id='${id}'`);
    const okNeg = rejects(`UPDATE artifacts SET deliverable_type='git_repo' WHERE id='${id}'`);
    return okCs && okNeg;
  })());

// ── 组织对齐(生产路径的第二步)──
db.exec("DELETE FROM agents WHERE id IN ('x2','x3')"); // 清掉上面探针插的行
const { ensureOrg, syncOrgForExistingProjects, roleDisplayName } = await import(join(ROOT, "dist/src/platform/runtime/org.js"));
const created = ensureOrg(db, Date.now());
check("ensureOrg 建出 coding_worker 并校准 wk 的显示名",
  created.some((c) => c.startsWith("cw(")) && created.some((c) => c.includes("wk(校准为 研究员")),
  created.join(" · "));
const projectIds = db.prepare("SELECT id FROM projects").all().map((r) => r.id);
const syncLines = syncOrgForExistingProjects(db, Date.now());
const cwIn = projectIds.filter((p) => db.prepare("SELECT COUNT(*) n FROM project_assignments WHERE project_id=? AND agent_id='cw'").get(p).n === 1);
check(`cw 进入了全部 ${projectIds.length} 个已存在的项目`, cwIn.length === projectIds.length,
  `对齐 ${syncLines.length} 个项目`);
check("同步幂等(再跑一次是空的)", syncOrgForExistingProjects(db, Date.now()).length === 0);
check("roleDisplayName 与 ORG 一致", roleDisplayName("coding_worker") === "工程师" && roleDisplayName("research_worker") === "研究员");

db.close();
rmSync(scratch, { recursive: true, force: true });

console.log("");
const bad = results.filter((r) => !r.ok);
console.log(`${results.length - bad.length}/${results.length} 通过`);
if (bad.length > 0) process.exit(1);
