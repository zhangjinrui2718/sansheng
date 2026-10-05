import Database from "better-sqlite3";
import { collectTodos } from "/Users/fuyao/projects/sansheng/dist/src/platform/runtime/dispatcher.js";

const db = new Database("/tmp/bugb.db");
const pid = "pj_muujuaia2cx8bpvp";
const works = db.prepare("SELECT id,parent_work_id p,status,review_state rs,assignee_agent_id a FROM works ORDER BY created_at").all();
const show = (tag) => {
  const b = collectTodos({ db, projectId: pid, now: Date.now() });
  console.log(`\n=== ${tag} ===`);
  console.log("runnable:");
  for (const t of b.runnable) console.log(`   ${t.kind.padEnd(20)} ${t.key}`);
  if (!b.runnable.length) console.log("   (空)");
  console.log("exhausted(预算用尽,不再叫醒):", b.exhausted.map(t=>t.key).join(" | ") || "(none)");
};
console.log("works:", works.map(w=>`${w.id}${w.p===null?"(root)":"(child)"}[${w.status}/${w.rs}]`).join(" "));
console.log("attempts:", db.prepare("SELECT todo_key,attempts FROM dispatch_attempts").all().map(a=>`${a.todo_key}:${a.attempts}`).join(" | ") || "(none)");
show("运行 1:真机库原样");
// 把那条 blocked 的子项与两条 open 的子项一起改成 cancelled(= 子树全终态),
// 而**根自己仍然是 blocked** —— 用来判定「根 blocked 会不会卡住 integrate」
const upd = db.prepare("UPDATE works SET status='cancelled' WHERE parent_work_id = ? AND status IN ('blocked','open')").run("wk_muujz3qc05kz9cew");
console.log(`\n[改动] 子项 blocked/open → cancelled:${upd.changes} 行`);
console.log("works now:", db.prepare("SELECT id,parent_work_id p,status,review_state rs FROM works").all().map(w=>`${w.id}${w.p===null?"(root)":"(child)"}[${w.status}/${w.rs}]`).join(" "));
show("运行 2:子树全终态 + 根自己仍 blocked");
