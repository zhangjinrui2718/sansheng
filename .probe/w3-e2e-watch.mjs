/**
 * W3-③ 端到端 · **第 2 步:等那个真回合结束,并把现场原样打出来**
 *
 * 轮询副本库,直到 `session_messages` 出现基线之外的**新助手消息**(= 真回合落库),
 * 或者超时。判据是「行数变了」而不是「进程还在不在」—— 本项目对「以进程自述为准」
 * 已经付过代价(`[running]` 不代表在干活)。
 *
 * 打印的东西刻意是**原始行**(不是提炼后的结论):`[未播报]` 到底出没出现、那条
 * 消息的 `origin_source` / `trigger_kind` 是什么、平台有没有落下「没留工作记录」的
 * `system` 消息 —— 三者都由读的人自己看。
 *
 * 用法:`node .probe/w3-e2e-watch.mjs <dataDir> <baselineCount> [timeoutMs]`
 */
import Database from "better-sqlite3";
import { join } from "node:path";

const [dataDir, baselineArg, timeoutArg] = process.argv.slice(2);
const baseline = Number(baselineArg ?? "0");
const timeoutMs = Number(timeoutArg ?? "300000");
const started = Date.now();

function snapshot() {
  const db = new Database(join(dataDir, "sansheng.db"), { readonly: false });
  try {
    db.pragma("busy_timeout = 5000");
    const msgs = db
      .prepare(
        `SELECT m.id, s.project_id AS projectId, s.channel, m.agent_id AS agentId,
                m.kind, m.content, m.created_at AS createdAt,
                m.origin_source AS originSource, m.trigger_kind AS triggerKind
           FROM session_messages m JOIN project_sessions s ON s.id = m.session_id
          ORDER BY m.created_at, m.id`,
      )
      .all();
    return { count: msgs.length, msgs };
  } finally {
    db.close();
  }
}

let snap = snapshot();
process.stdout.write(`[watch] baseline=${baseline} now=${snap.count}\n`);
while (snap.count <= baseline && Date.now() - started < timeoutMs) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    snap = snapshot();
  } catch (err) {
    process.stdout.write(`[watch] 读库失败(继续等):${err instanceof Error ? err.message : String(err)}\n`);
  }
}

const waited = Math.round((Date.now() - started) / 1000);
if (snap.count <= baseline) {
  console.log(`[watch] TIMEOUT ${waited}s —— 库里的消息数没有增加(${snap.count}),这个回合没有落库`);
  process.exit(3);
}
console.log(`[watch] 新消息已落库(等了 ${waited}s,共 ${snap.count} 条)`);
for (const m of snap.msgs) {
  const isNew = snap.msgs.indexOf(m) >= baseline;
  if (!isNew) continue;
  const body = String(m.content);
  console.log(
    `\n── 新消息 ${m.id} ──\n` +
      `  kind=${m.kind} agentId=${String(m.agentId)} channel=${m.channel} projectId=${String(m.projectId)}\n` +
      `  origin_source=${String(m.originSource)} trigger_kind=${String(m.triggerKind)}\n` +
      `  行首是 [未播报]? ${/^[ \t]*\[未播报\]/.test(body) ? "✓ 是" : "✗ 否"}\n` +
      `  正文前 20 行:\n${body.split("\n").slice(0, 20).map((l) => "    | " + l).join("\n")}`,
  );
}
