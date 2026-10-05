/**
 * 运行现场速查:**只读**打印一个数据目录的运行态(项目 / 工作项树 / 工件 / outbox /
 * 预算账本 / 会话 / 回合用量 / 最近消息)。
 *
 * 用法:`node .probe/run-state.mjs [dataDir]`(缺省 `~/.sansheng`)
 *
 * 判据都是 SQL,**不读进程内存** —— 与平台自己的口径一致:宿主持有的状态一律不算数
 * (「判定与状态全在库里」),所以这里看到的就是排空器看到的东西。
 * `readonly: true` ⇒ 不会改你一个字节。
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.argv[2] ?? join(homedir(), ".sansheng");
const db = new Database(join(dataDir, "sansheng.db"), { readonly: true });
db.pragma("busy_timeout = 8000");

const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const ts = (n) => (n == null ? "—" : new Date(n).toLocaleTimeString("zh-CN", { hour12: false }));
const ago = (n) => (n == null ? "—" : `${Math.round((Date.now() - n) / 1000)}s 前`);

console.log(`数据目录:${dataDir}`);
console.log(`schema  = ${one("SELECT MAX(version) AS v FROM schema_version").v}`);
const proc = one("SELECT COUNT(*) AS n FROM agents").n;
console.log(`agents  = ${proc}${proc === 0 ? "  ← 组织未播种(工具面会「求解不了」)" : ""}`);

// ── 项目 ────────────────────────────────────────────────────────
console.log("\n══ 项目 ══");
const projects = all("SELECT id, name, status, created_at FROM projects ORDER BY created_at");
if (projects.length === 0) console.log("  (没有项目 —— 还在接待阶段)");
for (const p of projects) {
  console.log(`  ${p.name}  [${p.status}]  建于 ${ts(p.created_at)}  ${p.id}`);
}

// ── 工作项(树形) ───────────────────────────────────────────────
console.log("\n══ 工作项(缩进 = 树深)══");
const works = all(
  `SELECT id, project_id AS pid, parent_work_id AS par, title, status, review_state AS rev,
          assignee_agent_id AS who, created_at, updated_at
     FROM works ORDER BY created_at`,
);
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const byParent = new Map();
for (const w of works) {
  const k = w.par ?? null;
  byParent.set(k, [...(byParent.get(k) ?? []), w]);
}
let flat = 0;
const walk = (parent, depth) => {
  for (const w of byParent.get(parent) ?? []) {
    const deps = all("SELECT depends_on_work_id AS d FROM work_deps WHERE work_id = ?", w.id)
      .map((r) => r.d.slice(0, 12)).join(",");
    const mark = TERMINAL.has(w.status) ? " " : "▶";
    console.log(
      `  ${"  ".repeat(depth)}${mark} [${w.status}${w.rev !== "none" ? `/${w.rev}` : ""}] ` +
        `${w.who} | ${w.title.slice(0, 44)}${deps ? `  (等 ${deps})` : ""}  ${ago(w.updated_at)}`,
    );
    if (depth === 0) flat += 1;
    walk(w.id, depth + 1);
  }
};
walk(null, 0);
const roots = works.filter((w) => w.par === null).length;
const children = works.length - roots;
console.log(`  共 ${works.length} 条 = ${roots} 根 + ${children} 中间(${flat} 个顶层)`);
const open = works.filter((w) => !TERMINAL.has(w.status));
console.log(`  未终态:${open.length} 条${open.length ? " → " + open.map((w) => `${w.status}:${w.title.slice(0, 20)}`).join(" | ") : ""}`);
const pendingReview = all("SELECT id, title FROM works WHERE status='done' AND review_state='pending'");
console.log(`  做完没审(done + review_state=pending):${pendingReview.length} 条`);

// ── 工件 ────────────────────────────────────────────────────────
console.log("\n══ 工件 ══");
const arts = all(
  `SELECT a.id, a.kind, a.status, a.title, a.author_agent_id AS who, a.work_id AS wid, a.created_at
     FROM artifacts a ORDER BY a.created_at`,
);
console.log(`  共 ${arts.length} 件`);
for (const a of arts.slice(-14)) {
  console.log(`  [${a.kind}/${a.status}] ${String(a.who).padEnd(3)} → ${a.wid ? a.wid.slice(0, 12) : "(不挂工作项)"} | ${a.title.slice(0, 40)}  ${ago(a.created_at)}`);
}
if (arts.length > 14) console.log(`  …(前 ${arts.length - 14} 件略)`);

// ── outbox 与预算 ───────────────────────────────────────────────
console.log("\n══ 下游事件(outbox)══");
const evs = all("SELECT seq, project_id AS pid, kind, subject_id AS sub, summary, created_at, consumed_at FROM dispatch_events ORDER BY seq");
const pending = evs.filter((e) => e.consumed_at == null);
console.log(`  共 ${evs.length} 条 · 未消费 ${pending.length} 条(合并窗口:攒够 3 条 或 最老等 5 分钟;work_failed / high|critical 立刻叫醒)`);
for (const e of evs.slice(-8)) {
  console.log(`  ${e.consumed_at == null ? "○ 未消费" : "● 已交代"} ${e.kind.padEnd(14)} ${ago(e.created_at)} | ${e.summary.slice(0, 46)}`);
}
console.log("\n══ 尝试预算(还要不要再叫醒)══");
const att = all("SELECT * FROM dispatch_attempts ORDER BY last_attempt_at");
if (att.length === 0) console.log("  (空 —— 没有待办被反复叫醒)");
for (const a of att) {
  console.log(`  ${a.todo_key}  attempts=${a.attempts}/3  last=${ago(a.last_attempt_at)}${a.notified_at ? "  已播报用尽" : ""}`);
}

// ── 会话与消息 ──────────────────────────────────────────────────
console.log("\n══ 会话 ══");
for (const s of all("SELECT id, project_id AS pid, channel, deliverable_artifact_id AS d FROM project_sessions")) {
  console.log(`  ${s.pid ?? "(接待会话)".padEnd(14)} channel=${s.channel} deliverable=${s.d ?? "—"}`);
}
console.log("\n══ 最近消息(带封套)══");
const msgs = all(
  `SELECT m.created_at, m.kind, m.agent_id AS ag, m.origin_source AS os, m.trigger_kind AS tk,
          substr(replace(m.content, char(10), ' '), 1, 58) AS head
     FROM session_messages m ORDER BY m.created_at DESC, m.id DESC LIMIT 12`,
);
for (const m of msgs.reverse()) {
  console.log(`  ${ts(m.created_at)} ${m.kind.padEnd(9)} ${String(m.ag).padEnd(5)} ${String(m.os)}/${String(m.tk)} | ${m.head}`);
}
console.log(`  会话消息共 ${one("SELECT COUNT(*) AS n FROM session_messages").n} 条`);

// ── 用量 ────────────────────────────────────────────────────────
console.log("\n══ 回合用量(turn_usage)══");
const sum = one("SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM turn_usage");
console.log(`  ${sum.n} 次调用 · input ${sum.i} · output ${sum.o} tokens`);
for (const u of all("SELECT agent_id AS ag, COUNT(*) AS n, SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM turn_usage GROUP BY agent_id")) {
  console.log(`  ${String(u.ag).padEnd(5)} ${u.n} 次 · in ${u.i} / out ${u.o}`);
}

// ── 其它协作面 ──────────────────────────────────────────────────
const askOpen = one("SELECT COUNT(*) AS n FROM asks WHERE status = 'open'").n;
const blockers = all("SELECT title, severity, status FROM blockers WHERE status NOT IN ('resolved','rejected')");
const changes = all("SELECT title, status FROM change_requests WHERE status NOT IN ('implemented','rejected')");
console.log("\n══ 协作面 ══");
console.log(`  未答提问 ${askOpen} 条 · 未解决阻塞 ${blockers.length}${blockers.length ? " → " + blockers.map((b) => `${b.severity}:${b.title.slice(0, 20)}`).join(" | ") : ""} · 未决变更 ${changes.length}`);
const meetings = all("SELECT topic, status FROM meetings");
if (meetings.length > 0) console.log(`  会议 ${meetings.length} 场 → ${meetings.map((m) => `${m.status}:${m.topic.slice(0, 18)}`).join(" | ")}`);

db.close();
