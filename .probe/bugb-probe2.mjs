import Database from "better-sqlite3";
import { collectTodos } from "/Users/fuyao/projects/sansheng/dist/src/platform/runtime/dispatcher.js";
const db = new Database("/tmp/bugb.db");
const pid = "pj_muujuaia2cx8bpvp";
const ROOT = "wk_muujz3qc05kz9cew";
const BLOCKED_CHILD = "wk_muujzk1kwbzj3r6d";
const shapes = () => db.prepare("SELECT id,parent_work_id p,status,review_state rs FROM works").all()
  .map(w=>`${w.id}${w.p===null?"(root)":"(child)"}[${w.status}/${w.rs}]`).join(" ");
const kinds = () => collectTodos({ db, projectId: pid, now: Date.now() }).runnable.map(t=>`${t.kind}(${t.key})`);
const show = (tag) => console.log(`\n=== ${tag} ===\n  works: ${shapes()}\n  待办: ${kinds().join(" | ") || "(空 —— 没人会被叫醒)"}`);
console.log("work_deps:", db.prepare("SELECT work_id,depends_on_work_id FROM work_deps").all().map(d=>`${d.work_id}←${d.depends_on_work_id}`).join(" | ") || "(none)");
show("① 真机库原样");
db.prepare("UPDATE works SET status='done', review_state='done' WHERE parent_work_id=? AND id<>?").run(ROOT, BLOCKED_CHILD);
show("② 子项全 done,只留那一条 blocked 的子项(根仍 blocked)");
db.prepare("UPDATE works SET status='done', review_state='done' WHERE id=?").run(BLOCKED_CHILD);
show("③ 那条子项也 done(根仍 blocked)—— 对照组");
