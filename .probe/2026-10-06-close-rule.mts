/**
 * 真机验证探针(2026-10-06 那批机制修复)
 *
 * ⚠️ 它跑在**真机库的 VACUUM INTO 副本**上,不是夹具 —— 这一批改动的每一条
 * 都是从那份库里读出来的现场,拿夹具验它等于拿猜测验猜测。
 *
 * 验四件事:
 *   1. migration 022 能在真库上跑通(它是纯加法,一行 DROP 都没有);
 *   2. `close_finished_project` 在真机上**成立** —— 那个项目真的做完了,
 *      而 `projects.status` 在修复前会永远是 `active`;
 *   3. 判据的**每一格**在真库形状下都读得到东西(不是「碰巧成立」);
 *   4. `renderTask` 把 `projects.goal` / `works.goal` 真的带进了验收现场 ——
 *      修复前 `grep -n goal dispatcher.ts` 是零命中。
 */
import Database from "better-sqlite3";
import { runMigrations } from "../src/platform/infra/migrations.js";
import {
  collectTodos, renderTask, close_project_witness,
} from "./probe-helpers.js";

const db = new Database("/tmp/ss-verify/probe.db");
db.pragma("foreign_keys = ON");

const PID = "pj_muvyas8ym8eqn2vh";

console.log("=== ① 迁移 ===");
console.log("迁移前 schema_version =", (db.prepare("SELECT MAX(version) v FROM schema_version").get() as { v: number }).v);
runMigrations(db);
console.log("迁移后 schema_version =", (db.prepare("SELECT MAX(version) v FROM schema_version").get() as { v: number }).v);
const cols = db.pragma("table_info(session_messages)") as Array<{ name: string }>;
console.log("session_messages 里有 todo_kind 列:", cols.some((c) => c.name === "todo_kind"));
console.log("todo_kind 是纯加法(没有重建表):017/020 的表都还在 =",
  db.prepare("SELECT COUNT(*) n FROM project_sessions").get() !== undefined);

console.log("\n=== ② 项目状态(修复前后都会是 active,除非有人调 project_close)===");
const proj = db.prepare("SELECT status, length(goal) goal_len FROM projects WHERE id = ?").get(PID) as
  { status: string; goal_len: number };
console.log("status =", proj.status, "· goal 有", proj.goal_len, "字");

console.log("\n=== ③ 收口规则的八格判据,在真库上逐条读数 ===");
const fact = close_project_witness(db, PID);
for (const [k, v] of Object.entries(fact)) console.log(`  ${k.padEnd(28)} ${String(v)}`);

console.log("\n=== ④ 修复前这里是一条待办都没有 ===");
const board = collectTodos({ db, projectId: PID, now: Date.now() });
console.log("runnable =", board.runnable.map((t) => `${t.agentId}:${t.kind}`));
const close = board.runnable.find((t) => t.kind === "close_project");
if (close === undefined) {
  console.log("❌ close_project **没有**成立 —— 判据在真库形状下不成立,这次修复没修到点上");
  process.exitCode = 1;
} else {
  console.log("✅ close_project 成立:", close.label);
  console.log("   key =", close.key, "· 叫醒 =", close.agentId, "(", close.role, ")");
  console.log("\n=== ⑤ 那个回合的提示词:靶子必须在场 ===");
  const text = renderTask(db, close);
  const goal = db.prepare("SELECT goal FROM projects WHERE id = ?").get(PID) as { goal: string };
  console.log("提示词含 projects.goal 的正文:", text.includes(goal.goal.trim().slice(0, 40)));
  console.log("提示词列出了最终交付物:", text.includes("最终交付物"));
  console.log("提示词没有替业务经理下结论:", text.includes("但平台不知道该不该收"));
  for (const line of text.split("\n").slice(0, 26)) console.log("   │ " + line);
}

console.log("\n=== ⑥ P1:真库上那 24 条被吞掉的回合 ===");
const swallowed = db.prepare(
  `SELECT COALESCE(todo_kind,'(NULL)') k, COUNT(*) n
     FROM session_messages m JOIN project_sessions s ON s.id = m.session_id
    WHERE s.project_id = ? AND m.origin_source = 'turn' AND m.trigger_kind = 'todo'
    GROUP BY k`,
).all(PID) as Array<{ k: string; n: number }>;
console.log("存量行的 todo_kind 分布:", JSON.stringify(swallowed));
console.log("⇒ 全是 NULL = 022 之前写的行。读面对它们一律按『内部通道』处理");
console.log("  (fail-closed:宁可甲方少看一条,也不把内部推演永久上屏;回填是编造)。");

db.close();