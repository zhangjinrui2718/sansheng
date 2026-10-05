/**
 * 丙批判据 S1–S6 · 在**真机库的副本**上实测(不是内存库)
 *
 * 每次判据前从 `~/.sansheng/sansheng.db` 重新 `VACUUM INTO` 一份副本,
 * 互不污染。跑法:
 *
 *   npx tsx .probe/bugb-probe3-blocked-container.mts
 *
 * ⚠️ 这是**只读 + /tmp** 的探针:真机库始终以 readonly 打开,副本落在 /tmp,
 * 一个字节都不写回真机库。
 */
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTodos, drainProject } from "../src/platform/runtime/dispatcher.js";
import { collectPendingWork } from "../src/platform/runtime/pendingWork.js";

const REAL = `${process.env.HOME}/.sansheng/sansheng.db`;
const PID = "pj_muujuaia2cx8bpvp";
const ROOT = "wk_muujz3qc05kz9cew";
const BLOCKED_CHILD = "wk_muujzk1kwbzj3r6d";
const T = 1_790_000_000_000;

const dir = mkdtempSync(join(tmpdir(), "sansheng-probe3-"));
let n = 0;

/** 真机库的一份**全新副本**(每次调用一份,判据之间不串味)。 */
function copy(): Database.Database {
  const src = new Database(REAL, { readonly: true });
  const path = join(dir, `copy${++n}.db`);
  src.exec(`VACUUM INTO '${path}'`);
  src.close();
  return new Database(path);
}

const board = (db: Database.Database) =>
  collectTodos({ db, projectId: PID, now: T });
const kinds = (db: Database.Database) => board(db).runnable.map((t) => `${t.kind}(${t.key})`);
const shapes = (db: Database.Database) =>
  (db.prepare(`SELECT id,parent_work_id p,status,review_state rs FROM works ORDER BY created_at`)
    .all() as Array<{ id: string; p: string | null; status: string; rs: string }>)
    .map((w) => `${w.id}${w.p === null ? "(root)" : "(child)"}[${w.status}/${w.rs}]`)
    .join(" ");

function head(tag: string, db: Database.Database): void {
  console.log(`\n${"═".repeat(78)}\n${tag}\n${"─".repeat(78)}`);
  console.log(`  works: ${shapes(db)}`);
  console.log(`  待办 : ${kinds(db).join(" | ") || "(空 —— 没有任何人会被叫醒)"}`);
}

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failed++;
  console.log(`  ${ok ? "✅" : "❌"} ${name} —— ${detail}`);
}

console.log(`真机库: ${REAL}\n副本目录: ${dir}\n项目: ${PID}`);

// ── S1:有子项的根(任意状态)不产出 execute_work ──────────────────────
{
  const db = copy();
  head("S1 · 真机库原样:容器根(blocked,4 个子项)不产出 execute_work", db);
  const targets = board(db).runnable.filter((t) => t.kind === "execute_work").map((t) => t.target);
  check("S1", !targets.includes(ROOT), `execute_work 的 target = [${targets.join(", ")}],不含容器根 ${ROOT}`);
  // 把根改成 open / in_progress 也不能让它变成可执行项(判据是「有子项」,与状态无关)
  for (const st of ["open", "in_progress"]) {
    db.prepare(`UPDATE works SET status = ? WHERE id = ?`).run(st, ROOT);
    const tg = board(db).runnable.filter((t) => t.kind === "execute_work").map((t) => t.target);
    check(`S1(${st})`, !tg.includes(ROOT), `根置 ${st} 后 execute_work = [${tg.join(", ")}]`);
  }
  // 注入面:模型也看不到它
  const pw = collectPendingWork(db, "wk", PID, T);
  check(
    "S1(注入面)",
    !pw.myOpenWorks.map((w) => w.id).includes(ROOT) && !pw.myWaitingWorks.map((w) => w.id).includes(ROOT),
    `myOpenWorks=[${pw.myOpenWorks.map((w) => w.id).join(",")}] myWaitingWorks=[${pw.myWaitingWorks.map((w) => w.id).join(",")}]`,
  );
  db.close();
}

// ── S2:叶子(真活)必须产出 execute_work ← 反向判据 ───────────────────
{
  const db = copy();
  // 真机库是**扁平**的吗?先看形状,再放一条**没有子项的根**(真活)
  const roots = db.prepare(`SELECT COUNT(*) n FROM works WHERE parent_work_id IS NULL`).get() as { n: number };
  const kids = db.prepare(`SELECT COUNT(*) n FROM works WHERE parent_work_id IS NOT NULL`).get() as { n: number };
  db.prepare(
    `INSERT INTO works (id, project_id, parent_work_id, title, goal, status, review_state,
                        assignee_agent_id, created_at, updated_at)
     VALUES ('wk_probe_leaf', ?, NULL, '真活:接口边界确认', '写出结论', 'open', 'none', 'wk', ?, ?)`,
  ).run(PID, T, T);
  head("S2 · 副本 + 一条**没有子项的根**(真活)", db);
  const targets = board(db).runnable.filter((t) => t.kind === "execute_work").map((t) => t.target);
  check("S2", targets.includes("wk_probe_leaf"), `execute_work 的 target = [${targets.join(", ")}](含新叶子)`);
  check(
    "S2(反向)",
    !targets.includes(ROOT),
    `同一次输出里容器根仍不在(所以上面那条不是「看板把什么都列出来了」);` +
      `库形状:root=${roots.n} child=${kids.n}`,
  );
  db.close();
}

// ── S3:子树全终态 + 根 open/blocked ⇒ integrate ─────────────────────
{
  const db = copy();
  db.prepare(
    `UPDATE works SET status = 'done', review_state = 'done' WHERE parent_work_id = ?`,
  ).run(ROOT);
  head("S3 · 子项全 done+审过、**根仍 blocked**", db);
  const integ = board(db).runnable.filter((t) => t.kind === "integrate");
  check("S3", integ.length === 1 && integ[0]!.refs.includes(ROOT), `integrate refs = [${integ.map((t) => t.refs.join("+")).join(" | ")}]`);
  db.close();
}

// ── S4:一条 blocked 的子项 ⇒ 必须有人被叫醒(主判据)────────────────
{
  const db = copy();
  head("S4 · 真机库原样(1 根 blocked + 子项 done/done/blocked/open/open)", db);
  const todos = board(db).runnable;
  check("S4", todos.length > 0, `待办条数 = ${todos.length}(旧判定在这个形状上是 **0**)`);
  const r = todos.filter((t) => t.kind === "resolve_blocked_work");
  check(
    "S4(谁被叫醒)",
    r.length === 1 && r[0]!.agentId === "pm" && r[0]!.refs.includes(BLOCKED_CHILD),
    r.length === 0
      ? "没有 resolve_blocked_work"
      : `${r[0]!.agentId} ← ${r[0]!.label};refs = [${r[0]!.refs.join(", ")}]`,
  );
  // 旧判定的等价输出:这个形状上唯一会变的就是这条新规则(丙① 只影响
  // open|in_progress 的**可执行**项,而这里两条 open 的前置都没满足)
  const withoutNew = todos.filter((t) => t.kind !== "resolve_blocked_work");
  check(
    "S4(对照)",
    withoutNew.length === 0,
    `把新规则那一行减掉 = [${withoutNew.map((t) => t.kind).join(", ")}] ⇒ **旧判定在这个形状上确实是零待办**`,
  );
  db.close();
}

// ── S5:因 ask_client 而 blocked 的工作项 ⇒ 不该叫醒 PM ───────────────
{
  const db = copy();
  // 真机当时那条未答复的甲方提问(q_muuk2r80g8wis85u 已被答复,把它还原成 open)
  db.prepare(`UPDATE artifacts SET status = 'open' WHERE id = 'q_muuk2r80g8wis85u'`).run();
  head("S5 · 真机库副本 + 一条**未答复的 client_question**(球在甲方那边)", db);
  const q = db.prepare(`SELECT COUNT(*) n FROM artifacts WHERE kind='client_question' AND status='open'`).get() as { n: number };
  const r = board(db).runnable.filter((t) => t.kind === "resolve_blocked_work");
  check(
    "S5",
    r.length === 0,
    `未答复的 client_question = ${q.n} ⇒ resolve_blocked_work **不出现**(不让 PM 空转一轮)`,
  );
  // 正样本:甲方答复之后(question → accepted)同一批工作项立刻回到 PM 的待办
  db.prepare(`UPDATE artifacts SET status = 'accepted' WHERE id = 'q_muuk2r80g8wis85u'`).run();
  const after = board(db).runnable.filter((t) => t.kind === "resolve_blocked_work");
  check(
    "S5(答复后自愈)",
    after.length === 1,
    after.length === 0 ? "答复之后仍然不叫 —— 那就成了静默停摆" : `${after[0]!.label};refs=[${after[0]!.refs.join(", ")}]`,
  );
  db.close();
}

// ── S6:整合成功(根上落了 deliverable)⇒ 根被置 done ──────────────────
{
  const db = copy();
  db.prepare(`UPDATE works SET status = 'done', review_state = 'done' WHERE parent_work_id = ?`).run(ROOT);
  db.prepare(
    `INSERT INTO artifacts (id, project_id, conversation_id, kind, status, author_agent_id,
                            title, body, metadata_json, created_at, updated_at, work_id)
     VALUES ('art_probe_deliv', ?, NULL, 'deliverable', 'accepted', 'pm',
             '催收语音机器人升级 · 交付整合', '整合产物', NULL, ?, ?, ?)`,
  ).run(PID, T, T, ROOT);
  head("S6 · 子树收口 + 根上落了 deliverable(根仍 blocked)", db);
  const before = db.prepare(`SELECT status FROM works WHERE id = ?`).get(ROOT) as { status: string };
  const result = await drainProject({
    db, projectId: PID, now: () => T, log: (l) => console.log(`    [drain] ${l}`),
    runAgentTurn: async () => ({ aborted: false, timedOut: false, text: "", toolCalls: [] }),
    runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
  });
  const after = db.prepare(`SELECT status, review_state FROM works WHERE id = ?`).get(ROOT) as
    { status: string; review_state: string };
  check("S6", before.status === "blocked" && after.status === "done", `${before.status} → ${after.status}/${after.review_state}`);
  check(
    "S6(经唯一写口)",
    after.review_state === "pending" || after.review_state === "done",
    `review_state = ${after.review_state}(写口维护它;绕过 §2.7 直接 UPDATE 的话它不会动)`,
  );
  check("S6(排空结果)", result.rounds >= 0, `rounds=${result.rounds} stop=${result.stopReason} visited=[${result.visited.map((v) => v.kind).join(",")}]`);
  db.close();
}

console.log(`\n${"═".repeat(78)}`);
console.log(failed === 0 ? "全部判据通过 ✅" : `有 ${failed} 条判据失败 ❌`);
rmSync(dir, { recursive: true, force: true });
