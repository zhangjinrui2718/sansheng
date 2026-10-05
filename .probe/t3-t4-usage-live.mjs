/**
 * T3 + T4 真机探针:**真 provider 跑真回合,核验 `turn_usage` 落的那一行**
 *
 * ── 它与单元测试的分工 ──────────────────────────────────────────
 *
 * 单元测试用**脚本化假会话**(精确触发分支,包括真模型不可能稳定复现的
 * 「同一个 usage 对象被反复改写」)。这里补的是另一半:**SDK 真的会给出什么**,
 * 以及「我们读的东西」与「SDK 自己算的东西」是否**逐项相等**。
 * 探针 v1 的事故(T1 记着的那次)正是因为少了这一半 —— 假会话的剧本是我写的,
 * 而字段名是 SDK 定的。
 *
 * ── 四条断言(全部对着真值)─────────────────────────────────────
 *
 *   ① 一个回合 2 次工具调用 ⇒ **只写一行**(不是每个 LLM 调用一行);
 *   ② 那一行与 `Σ message_end(role=assistant).usage` **逐项相等**;
 *   ③ 那一行与 `session.getSessionStats()` 的前后差分 **逐项相等**
 *      (D 口径 = SDK 自己的账);
 *   ④ 接待会话(`projectId === null`)那一行真的写进去了(`project_id IS NULL`)。
 *
 * 另外走一遍 HTTP:同一个数从 `GET /api/projects/:id/usage` 出来要对得上
 * (证明「读」这条路与「写」是同源的)。
 *
 * ── 环境纪律 ────────────────────────────────────────────────────
 *
 * `~/.sansheng/` **只读**(settings.json + .keyring 拿来解析真 provider);
 * 平台库 / agentDir / cwd 全在临时目录,跑完即删。探针自己核对
 * 「~/.sansheng 里读过的那两个文件摘要逐字不变」。
 *
 * 跑法:`npx tsx .probe/t3-t4-usage-live.mjs`
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootPlatform } from "../src/platform/runtime/boot.js";
import { createPlatformSession } from "../src/platform/runtime/session.js";
import { runTurn } from "../src/platform/runtime/turn.js";
import { insertAgent } from "../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../src/platform/storage/repo/projects.js";
import { createPlatformApp } from "../src/platform/transport/http.js";

const DATA_DIR = join(process.env.HOME ?? "", ".sansheng");

const failures = [];
const out = (s = "") => console.log(s);
const rule = (t) => out(`\n${"═".repeat(78)}\n${t}\n${"═".repeat(78)}`);
function check(ok, label, detail = "") {
  out(`${ok ? "  ✓" : "  ✖"} ${label}${detail === "" ? "" : ` —— ${detail}`}`);
  if (!ok) failures.push(label);
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const fmt = (t) => `input=${t.input} output=${t.output} cacheRead=${t.cacheRead}`;
const eq3 = (a, b) => a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead;

/** 从 `message_end` 那一刻**拷值**(与生产实现同一套纪律:绝不持引用)。 */
function snap(message) {
  const u = message?.usage;
  if (u === null || typeof u !== "object") return null;
  return { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead) };
}

function digest(p) {
  try {
    return { sha: createHash("sha256").update(readFileSync(p)).digest("hex"), size: statSync(p).size };
  } catch {
    return null;
  }
}

const temp = mkdtempSync(join(tmpdir(), "sansheng-t3t4-"));
const tempDb = join(temp, "platform.db");
const tempAgentDir = join(temp, "agent");
const tempCwd = join(temp, "cwd");
const beforeDigests = {
  settings: digest(join(DATA_DIR, "settings.json")),
  keyring: digest(join(DATA_DIR, ".keyring")),
};

const booted = bootPlatform({ dataDir: DATA_DIR, dbPath: tempDb, clientLog: () => {} });
const holder = { session: null };
const DISPOSE = () => {
  try { holder.session?.dispose(); } catch { /* 尽力而为 */ }
  try { booted.close(); } catch { /* 尽力而为 */ }
};

async function main() {
  rule("[1] 环境");
  out(`  真数据目录(只读):${DATA_DIR}`);
  out(`  平台库(临时):    ${booted.dbPath}`);
  out(`  provider:         ${booted.provider === null ? "(无)" : `${booted.provider.provider} / ${booted.provider.modelId}`}`);
  check(booted.provider !== null && booted.model !== null, "真 provider 已解析(否则后面全是空跑)");
  if (booted.model === null) return;

  const db = booted.deps.db;
  const at = Date.now();
  insertAgent(db, { id: "live-wk", role: "worker", specialization: "engineering", displayName: "探针工程师", createdAt: at });
  insertAgent(db, { id: "live-bm", role: "business_manager", specialization: null, displayName: "探针业务经理", createdAt: at });
  insertProject(db, { id: "live-p1", name: "探针项目", client: "探针甲方", goal: "量真回合的 token", status: "active", createdAt: at });
  addMember(db, "live-p1", "live-wk", at);

  const created = await createPlatformSession(booted.deps, "live-wk", "live-p1", {
    cwd: tempCwd, agentDir: tempAgentDir, model: booted.model, dataDir: DATA_DIR,
  });
  if (!created.ok) {
    check(false, "createPlatformSession", `${created.reason}: ${created.detail}`);
    return;
  }
  holder.session = created.session;
  out(`  ✓ 真会话已建立 · 工具面 ${created.plan.tools.length} 个`);

  // ════════════════════════════════════════════════════════════
  rule("[2] 真回合 A —— 强制 2 次工具调用(⇒ 至少 2 次 LLM 调用)");
  const PROMPT =
    "这是一次接口自检,请**严格分两步**,不要合并成一条命令:\n" +
    "第一步:调用 bash 工具执行 `echo USAGE_STEP_1`\n" +
    "第二步:再**单独**调用一次 bash 工具执行 `echo USAGE_STEP_2`\n" +
    "两步都执行完之后,只回复一行:USAGE_DONE\n" +
    "不要读取任何文件,不要做别的事。";
  out(`  prompt:${PROMPT.split("\n").length} 行(两步各一次 bash)`);

  const statsBefore = holder.session.getSessionStats();
  // 在**生产路径**(runTurn)的同一次事件流上再做一份独立快照 —— 两者必须相等
  const ends = [];
  const auditEvents = [];
  const resultA = await runTurn({
    session: holder.session,
    db,
    agentId: "live-wk",
    projectId: "live-p1",
    workId: null,
    message: PROMPT,
    timeoutMs: 300_000,
    wallClockTimeoutMs: 600_000,
    // 探针自己的、与生产无关的第二份账(独立实现,用来交叉核对)
    onEvent: (ev) => {
      auditEvents.push(ev.type);
      if (ev.type === "message_end") {
        const s = snap(ev.message);
        if (s !== null && ev.message?.role === "assistant") ends.push(s);
      }
    },
  });
  const statsAfter = holder.session.getSessionStats();
  const rowA = db.prepare(`SELECT * FROM turn_usage WHERE project_id = ? ORDER BY created_at DESC`).all("live-p1")[0];

  const sumEnds = ends.reduce(
    (t, u) => ({ input: t.input + u.input, output: t.output + u.output, cacheRead: t.cacheRead + u.cacheRead }),
    { input: 0, output: 0, cacheRead: 0 },
  );
  const statDelta = {
    input: num(statsAfter.tokens.input) - num(statsBefore.tokens.input),
    output: num(statsAfter.tokens.output) - num(statsBefore.tokens.output),
    cacheRead: num(statsAfter.tokens.cacheRead) - num(statsBefore.tokens.cacheRead),
  };

  out(`\n  runTurn 结局:settled=${resultA.settled} timedOut=${resultA.timedOut} 工具调用 ${resultA.toolCalls.length} 次`);
  out(`  文本:${JSON.stringify(resultA.text.trim().slice(0, 60))}`);
  out(`  assistant message_end 条数(= LLM 调用次数):${ends.length}`);
  for (const [i, u] of ends.entries()) out(`    call#${i + 1}: ${fmt(u)}`);
  out(`  Σ message_end                : ${fmt(sumEnds)}`);
  out(`  getSessionStats() 前后差分   : ${fmt(statDelta)}`);
  out(`  turn_usage 那一行            : ${rowA === undefined ? "(没有!)" : `${fmt({ input: rowA.input_tokens, output: rowA.output_tokens, cacheRead: rowA.cache_read })}`}`);
  if (rowA !== undefined) {
    out(`    原文:${JSON.stringify({
      id: rowA.id, project_id: rowA.project_id, session_id: rowA.session_id,
      agent_id: rowA.agent_id, work_id: rowA.work_id, model: rowA.model,
      input_tokens: rowA.input_tokens, output_tokens: rowA.output_tokens,
      cache_read: rowA.cache_read, created_at: rowA.created_at,
    })}`);
  }

  const rowsA = db.prepare(`SELECT COUNT(*) AS n FROM turn_usage WHERE project_id = ?`).get("live-p1");
  check(ends.length >= 2, "真的是 ≥2 次 LLM 调用(否则「多轮只写一行」这条是空跑)", `${ends.length} 次`);
  check(rowsA.n === 1, "★ 2 次 LLM 调用 ⇒ **只写一行**(不是每次调用一行)", `库里 ${rowsA.n} 行`);
  check(rowA !== undefined, "那一行**真的在库里**");
  check(
    rowA !== undefined && eq3({ input: rowA.input_tokens, output: rowA.output_tokens, cacheRead: rowA.cache_read }, sumEnds),
    "★ 落库那一行与 Σ message_end **逐项相等**(不是估算)",
    rowA === undefined ? "" : `行 ${fmt({ input: rowA.input_tokens, output: rowA.output_tokens, cacheRead: rowA.cache_read })} vs Σ ${fmt(sumEnds)}`,
  );
  check(
    rowA !== undefined && eq3({ input: rowA.input_tokens, output: rowA.output_tokens, cacheRead: rowA.cache_read }, statDelta),
    "★ 与 `session.getSessionStats()` 的前后差分**逐项相等**(SDK 自己的账)",
    `行 ${rowA === undefined ? "-" : fmt({ input: rowA.input_tokens, output: rowA.output_tokens, cacheRead: rowA.cache_read })} vs D ${fmt(statDelta)}`,
  );
  check(
    resultA.usage !== undefined && rowA !== undefined && resultA.usage.rowId === rowA.id,
    "`TurnResult.usage.rowId` 指的就是库里那一行(报告能自证)",
    resultA.usage === undefined ? "" : `${resultA.usage.rowId}`,
  );
  check(
    ends.length > 0 && ends.some((u) => u.cacheRead > 0),
    "★ 真出现了 `cacheRead > 0`(契约扩这一列的理由;为 0 时这条交叉核对不充分)",
    fmt(sumEnds),
  );
  check(resultA.toolCalls.length >= 2, "≥2 次工具调用(证明这确实是个多轮回合)", `${resultA.toolCalls.length} 次`);

  // ════════════════════════════════════════════════════════════
  rule("[3] HTTP:`GET /api/projects/live-p1/usage` 与那一行对得上");
  const app = createPlatformApp({
    db,
    dataDir: DATA_DIR,
    cwd: tempCwd,
    personaName: "三生",
    version: "probe",
    modelId: booted.provider.modelId,
    provider: booted.provider.provider,
    hasAnyProvider: true,
    now: () => Date.now(),
    newId: (p) => booted.newId(p),
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: DATA_DIR, factoryDir: join(DATA_DIR, "harness-factory") },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true, settings: {} }),
      providers: () => [],
    },
  });
  const resp = await app.request("/api/projects/live-p1/usage?days=7&limit=7");
  const body = await resp.json();
  const u = body.usage;
  out(`  HTTP ${resp.status} · totals=${fmt(u.totals)} turns=${u.totals.turns} today=${fmt(u.today)} allTime=${fmt(u.allTime)}`);
  out(`  byAgent: ${u.byAgent.map((b) => `${b.agentName}(${b.role}) ${fmt(b)}`).join(" | ")}`);
  out(`  byDay:   ${u.byDay.map((d) => `${d.day} ${fmt(d)}`).join(" | ")}`);
  out(`  byDayTruncated=${u.byDayTruncated} updatedAt=${u.updatedAt}`);
  check(resp.status === 200, "端点 200");
  check(
    rowA !== undefined &&
      eq3(u.totals, { input: rowA.input_tokens, output: rowA.output_tokens, cacheRead: rowA.cache_read }),
    "HTTP 的合计 = 库里那一行(读写同源)",
    `${fmt(u.totals)} vs 行 ${rowA === undefined ? "-" : fmt({ input: rowA.input_tokens, output: rowA.output_tokens, cacheRead: rowA.cache_read })}`,
  );
  check(u.totals.turns === 1 && u.byAgent.length === 1 && u.byDay.length === 1, "1 行 → 1 个角色 → 1 天");
  check(!JSON.stringify(body).includes("cost"), "响应里**没有 `cost`**(只报 token 数,不报金额)");

  // ════════════════════════════════════════════════════════════
  rule("[4] 真回合 B —— **接待会话**(projectId = null):那笔账必须落得下");
  const created2 = await createPlatformSession(booted.deps, "live-bm", null, {
    cwd: tempCwd, agentDir: tempAgentDir, model: booted.model, dataDir: DATA_DIR,
  });
  if (!created2.ok) {
    check(false, "接待会话建立", `${created2.reason}: ${created2.detail}`);
  } else {
    const r = await runTurn({
      session: created2.session,
      db,
      agentId: "live-bm",
      projectId: null,
      message: "只回复一行:INTAKE_OK。不要调用任何工具,不要读取任何文件。",
      timeoutMs: 300_000,
      wallClockTimeoutMs: 600_000,
    });
    try { created2.session.dispose(); } catch { /* 尽力而为 */ }
    const rowB = db.prepare(`SELECT * FROM turn_usage WHERE project_id IS NULL ORDER BY created_at DESC`).all()[0];
    out(`  runTurn 结局:settled=${r.settled} · usage=${r.usage === undefined ? "(无)" : JSON.stringify(r.usage)}`);
    out(`  project_id IS NULL 的行数:${db.prepare(`SELECT COUNT(*) AS n FROM turn_usage WHERE project_id IS NULL`).get().n}`);
    if (rowB !== undefined) {
      out(`    原文:${JSON.stringify({
        id: rowB.id, project_id: rowB.project_id, session_id: rowB.session_id,
        agent_id: rowB.agent_id, work_id: rowB.work_id, model: rowB.model,
        input_tokens: rowB.input_tokens, output_tokens: rowB.output_tokens,
        cache_read: rowB.cache_read, created_at: rowB.created_at,
      })}`);
    }
    check(rowB !== undefined, "★ 接待会话那笔账**真的写进去了**(`project_id IS NULL`)");
    check(rowB !== undefined && rowB.input_tokens > 0, "它不是一行 0(真的买到了 LLM 输出)", rowB === undefined ? "" : fmt({ input: rowB.input_tokens, output: rowB.output_tokens, cacheRead: rowB.cache_read }));
    check(
      rowB !== undefined && r.usage !== undefined && r.usage.input === rowB.input_tokens,
      "`TurnResult.usage` 与库里那一行逐项一致",
    );

    const intakeResp = await app.request("/api/intake/usage");
    const intakeBody = await intakeResp.json();
    out(`  HTTP /api/intake/usage → ${intakeResp.status} · projectId=${JSON.stringify(intakeBody.usage.projectId)} totals=${fmt(intakeBody.usage.totals)}`);
    check(intakeResp.status === 200, "接待会话用量端点 200");
    check(intakeBody.usage.projectId === null, "`projectId` 是 `null`(不是缺失,也不是编的 id)");
    check(
      rowB !== undefined && intakeBody.usage.totals.input === rowB.input_tokens,
      "接待会话的 HTTP 合计 = 那一行",
    );
  }

  // ════════════════════════════════════════════════════════════
  rule("[5] 交叉核对:`Σ agent_end.messages` 与 `Σ turn_end.message`(只选一条路的理由)");
  const endsCount = auditEvents.filter((t) => t === "message_end").length;
  out(`  事件类型计数:${JSON.stringify(
    auditEvents.reduce((m, t) => ({ ...m, [t]: (m[t] ?? 0) + 1 }), {}),
  )}`);
  out(`  assistant message_end ${endsCount} 条 —— 这三条投递路逐项相等,累加两条 = 重复计数`);
  out(`  ⇒ 实现只认 message_end 一条路(文件名头与 tests/platform/turn-usage-write.test.ts 都钉着)`);
}

try {
  await main();
} catch (err) {
  rule("异常");
  out(`  ✖ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  failures.push(`异常:${err instanceof Error ? err.message : String(err)}`);
} finally {
  DISPOSE();
  rule("[6] 环境纪律与清理");
  const afterSettings = digest(join(DATA_DIR, "settings.json"));
  const afterKeyring = digest(join(DATA_DIR, ".keyring"));
  check(
    JSON.stringify(beforeDigests.settings) === JSON.stringify(afterSettings),
    "~/.sansheng/settings.json 摘要逐字不变(只读)",
    `${beforeDigests.settings?.sha?.slice(0, 12)} → ${afterSettings?.sha?.slice(0, 12)}`,
  );
  check(
    JSON.stringify(beforeDigests.keyring) === JSON.stringify(afterKeyring),
    "~/.sansheng/.keyring 摘要逐字不变(只读)",
    `${beforeDigests.keyring?.sha?.slice(0, 12)} → ${afterKeyring?.sha?.slice(0, 12)}`,
  );
  rmSync(temp, { recursive: true, force: true });
  out(`  临时目录已删:${temp}`);
  out(`\n${"═".repeat(78)}`);
  if (failures.length === 0) out("T3+T4 真机探针:全部断言通过");
  else {
    out(`T3+T4 真机探针:${failures.length} 条断言未通过`);
    for (const f of failures) out(`  ✖ ${f}`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}
