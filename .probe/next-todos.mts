/**
 * 只读照一次 `collectTodos`:平台**现在**认为下一步该谁跑。
 * 用法:`npx tsx .probe/next-todos.mts [dataDir] [projectId]`
 * 判据与排空器**同一个函数**,不是我自己重写一遍。
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectTodos } from "../src/platform/runtime/dispatcher.js";

const dataDir = process.argv[2] ?? join(homedir(), ".sansheng");
const db = new Database(join(dataDir, "sansheng.db"), { readonly: true });
db.pragma("busy_timeout = 8000");
const pid = process.argv[3] ?? (db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string } | undefined)?.id;
if (pid === undefined) { console.log("没有项目"); process.exit(0); }

const board = collectTodos({ db, projectId: pid, now: Date.now() });
console.log(`project = ${pid}`);
console.log(`可执行 ${board.runnable.length} 条 · 预算用尽 ${board.exhausted.length} 条`);
for (const t of board.runnable) console.log(`  ▶ [优先级 ${t.kind}] ${t.role} · attempts=${t.attempts} · ${t.label}`);
for (const t of board.exhausted) console.log(`  ✗(用尽) [${t.kind}] ${t.role} · attempts=${t.attempts} · ${t.label}`);
db.close();
