/**
 * T1 探针:usage 到底挂在哪个 `AgentSessionEvent` 上?
 *
 * ── 它要回答的三个问题 ──────────────────────────────────────────
 *
 *   ① 真回合里,**哪个事件**带 usage?它的**实际字段值**是什么?
 *   ② **负样本**:别的事件上确实没有 usage 吗?(否则「没读到」与「读错了事件」
 *      分不清 —— 这正是平台现状:`turn.ts` 只读 `assistantMessageEvent` 的
 *      text/thinking delta,而 grep usage 是空的。)
 *   ③ 一个回合可能多次工具调用 ⇒ usage 是**每次 LLM 调用一条**,还是**回合结束
 *      一条总量**?多轮工具调用时怎么加才能不重复计数?
 *
 * ── ⚠️ v2:第一版探针的仪器本身是坏的(必须记下来)────────────────
 *
 * v1 把 `hits` 存成 `{path, value}`,其中 `value` 是**对象引用**。打印时(回合
 * 早已结束)读出来的当然是**终值** —— 于是 v1 的序列里 `message_start` 与第 1 条
 * `message_update` 都显示 `output=61`(和 `message_end` 一样),看起来「usage 从
 * 第一个事件起就是完整的」。
 *
 * 那是假的。同一个记录里 `stopReason` 是**原始值**(`pending`),它如实停在
 * `pending`;而 usage 是**对象**。**原始值没变、对象变了** ⇒ 那个对象被**就地
 * 改写**。v2 因此:
 *   · 每个 usage 在**事件发生那一刻**做快照(`snapUsage`),不再持引用;
 *   · 同时用 `idOf()` 记录**对象身份** —— 「同一条 usage 对象被多少个事件共享、
 *     它的值是否随流变化」是这一步的关键判据,不能只看值。
 *
 * 教训(与 AGENTS.md「三类静默失败」第 3 条同源):**坏掉的仪器会给出看起来
 * 完全正常的错答案** —— v1 的 `message_start` 那一行就是。
 *
 * ── 仪器的自检 ──────────────────────────────────────────────────
 *
 * `findUsagePaths()` 先跑 5 个**已知答案**的样本(3 正 + 2 负),全对才拿它去
 * 看真事件。它不做「猜哪个字段」的假设:枚举事件对象里**每一个**名为 `usage`
 * 的路径(深度 ≤ 4),所以它能发现平台没想到的位置。
 *
 * ── 环境纪律 ────────────────────────────────────────────────────
 *
 * `~/.sansheng/` **只读**(settings.json + .keyring 用来拿真 provider 配置);
 * 平台库建在临时目录、agentDir / cwd 也在临时目录,跑完即删。探针自己核对
 * 「~/.sansheng 里我读过的那两个文件的摘要逐字不变」。
 *
 * 跑法:`npx tsx .probe/t1-usage-source.mjs`
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

const DATA_DIR = join(process.env.HOME ?? "", ".sansheng");

const failures = [];
const notes = [];
function check(ok, label, detail = "") {
  console.log(`${ok ? "  ✓" : "  ✖"} ${label}${detail === "" ? "" : ` —— ${detail}`}`);
  if (!ok) failures.push(label);
}
const out = (s = "") => console.log(s);
const rule = (t) => out(`\n${"═".repeat(78)}\n${t}\n${"═".repeat(78)}`);

// ════════════════════════════════════════════════════════════════
// 仪器
// ════════════════════════════════════════════════════════════════

/** 枚举 obj 里每一条 `usage` 路径。不做角色/类型判断 —— 那是**结论**,不是仪器。 */
function findUsagePaths(obj, maxDepth = 4) {
  const found = [];
  const seen = new WeakSet();
  const walk = (v, path, depth) => {
    if (v === null || typeof v !== "object" || depth > maxDepth || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const [k, val] of Object.entries(v)) {
      if (k === "usage") found.push({ path: path === "" ? k : `${path}.${k}`, value: val });
      else walk(val, path === "" ? k : `${path}.${k}`, depth + 1);
    }
  };
  walk(obj, "", 0);
  return found;
}

/** **事件发生那一刻**的 usage 快照(浅拷贝 + cost 也拷一层)。绝不能存引用。 */
function snapUsage(u) {
  if (u === null || typeof u !== "object") return u;
  const cost = u.cost !== null && typeof u.cost === "object" ? { ...u.cost } : u.cost;
  return { ...u, cost };
}

/** 对象身份:同一对象共享同一个 id ⇒ 证明「被就地改写」而不是「各自独立的快照」。 */
const objIds = new Map();
let nextObjId = 1;
function idOf(v) {
  if (v === null || typeof v !== "object") return "prim";
  if (!objIds.has(v)) objIds.set(v, `#${nextObjId++}`);
  return objIds.get(v);
}

function isZeroUsage(u) {
  if (u === null || typeof u !== "object") return true;
  return ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
    (k) => (typeof u[k] === "number" ? u[k] : 0) === 0,
  );
}

function fmtUsage(u) {
  if (u === null || typeof u !== "object") return String(u);
  const cost = u.cost !== null && typeof u.cost === "object" ? u.cost.total : undefined;
  return (
    `input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite}` +
    ` totalTokens=${u.totalTokens} reasoning=${u.reasoning ?? "-"} cost.total=${cost}`
  );
}

// ── 仪器自检:已知答案样本 ──────────────────────────────────────
function instrumentSelfTest() {
  rule("[0] 仪器自检 —— 已知答案样本(不先自检,结论一概不算数)");
  const cases = [
    {
      name: "正样本:assistant message_end 上的 message.usage",
      ev: { type: "message_end", message: { role: "assistant", usage: { input: 11, output: 22, cacheRead: 0, cacheWrite: 0, totalTokens: 33, cost: { total: 0.5 } } } },
      wantPath: "message.usage",
      wantNonZero: true,
    },
    {
      name: "负样本:tool_execution_end(result.content 里没有任何 usage)",
      ev: { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "hi" }] }, isError: false },
      wantPath: null,
      wantNonZero: false,
    },
    {
      name: "负样本:user 的 message_end(即使 role 过滤写错也读不到 usage)",
      ev: { type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } },
      wantPath: null,
      wantNonZero: false,
    },
    {
      name: "嵌套样本:agent_end.messages[1].usage(证明扫描器不只看第一层)",
      ev: { type: "agent_end", messages: [{ role: "user" }, { role: "assistant", usage: { input: 1, output: 2, totalTokens: 3 } }] },
      wantPath: "messages[1].usage",
      wantNonZero: true,
    },
    {
      name: "深层样本:message_update 的 assistantMessageEvent.partial.usage(第 3 层)",
      ev: { type: "message_update", message: { role: "assistant", usage: { input: 0, output: 0, totalTokens: 0 } }, assistantMessageEvent: { type: "text_delta", delta: "x", partial: { role: "assistant", usage: { input: 5, output: 6, totalTokens: 11 } } } },
      wantPath: "assistantMessageEvent.partial.usage",
      wantNonZero: true,
    },
  ];
  let allOk = true;
  for (const c of cases) {
    const hits = findUsagePaths(c.ev);
    const paths = hits.map((h) => h.path);
    const pathOk = c.wantPath === null ? paths.length === 0 : paths.includes(c.wantPath);
    const nzOk = hits.some((h) => !isZeroUsage(h.value)) === c.wantNonZero;
    const ok = pathOk && nzOk;
    allOk = allOk && ok;
    console.log(`  ${ok ? "✓" : "✖"} ${c.name}`);
    console.log(`      命中路径:${paths.length === 0 ? "(无)" : paths.join(", ")} | 非零:${hits.some((h) => !isZeroUsage(h.value))}`);
  }
  // **快照自检**:拿一个会被改写的对象,验证 `snapUsage` 真的在那一刻截断
  const live = { input: 1, output: 2, totalTokens: 3, cost: { total: 9 } };
  const snap = snapUsage(live);
  live.output = 999;
  live.cost.total = 999;
  const snapOk = snap.output === 2 && snap.cost.total === 9;
  allOk = allOk && snapOk;
  console.log(`  ${snapOk ? "✓" : "✖"} 快照自检:改写原对象之后,快照仍是旧值(${JSON.stringify(snap)})`);
  check(allOk, "仪器自检:6/6 都对上(正样本必须命中、负样本必须 0 命中、快照必须与引用脱钩)");
  return allOk;
}

// ════════════════════════════════════════════════════════════════
// 事件记录
// ════════════════════════════════════════════════════════════════

function record(ev, callIndex) {
  const m = ev.message;
  const isObj = m !== null && typeof m === "object";
  const role = isObj && typeof m.role === "string" ? m.role : null;
  const assistantMsg = role === "assistant" ? m : null;
  const amu = ev.assistantMessageEvent;
  const amuObj = amu !== null && typeof amu === "object" ? amu : null;
  return {
    type: ev.type,
    role,
    callIndex,
    sub: amuObj !== null && typeof amuObj.type === "string" ? amuObj.type : null,
    evKeys: Object.keys(ev),
    msgKeys: isObj ? Object.keys(m) : null,
    msgObjId: isObj ? idOf(m) : null,
    amuKeys: amuObj !== null ? Object.keys(amuObj) : null,
    // ⚠️ 值一律**快照**,身份单独记 —— 见文件头的 v1 仪器事故
    hits: findUsagePaths(ev).map((h) => ({
      path: h.path,
      value: snapUsage(h.value),
      objId: idOf(h.value),
    })),
    stopReason: assistantMsg !== null ? assistantMsg.stopReason : null,
    isError: typeof ev.isError === "boolean" ? ev.isError : null,
    toolName: typeof ev.toolName === "string" ? ev.toolName : null,
  };
}

const carriesRealUsage = (r) => r.hits.some((h) => !isZeroUsage(h.value));
const carriesUsageKey = (r) => r.hits.length > 0;

function printSequence(label, recs) {
  out(`\n── ${label}:全部事件 type 序列(共 ${recs.length} 条;usage 值为**事件时刻快照**)──`);
  let i = 0;
  while (i < recs.length) {
    const r = recs[i];
    let j = i + 1;
    while (
      j < recs.length &&
      recs[j].type === r.type && recs[j].role === r.role && recs[j].sub === r.sub &&
      JSON.stringify(recs[j].hits) === JSON.stringify(r.hits)
    ) j++;
    const n = j - i;
    const tags = [];
    if (r.role !== null) tags.push(`role=${r.role}`);
    if (r.sub !== null) tags.push(`delta=${r.sub}`);
    const real = r.hits.find((h) => !isZeroUsage(h.value));
    if (real !== undefined) tags.push(`★${real.path}@${real.objId} ${fmtUsage(real.value)}`);
    else if (carriesUsageKey(r)) tags.push(`usage 键在但全零 @${r.hits.map((h) => `${h.path}@${h.objId}`).join(",")}`);
    else tags.push("无 usage 键");
    if (r.toolName !== null) tags.push(`tool=${r.toolName}`);
    out(`  ${String(i + 1).padStart(3, " ")}. ${r.type}${n > 1 ? ` ×${n}` : ""}   ${tags.join(" | ")}`);
    i = j;
  }
}

function printTally(label, recs) {
  out(`\n── ${label}:按事件类型汇总(负样本的自检表)──`);
  out("   类型                        出现  带 usage 键  带非零 usage  子类型");
  const byType = new Map();
  for (const r of recs) {
    const agg = byType.get(r.type) ?? { n: 0, key: 0, real: 0, subs: new Set() };
    agg.n += 1;
    if (carriesUsageKey(r)) agg.key += 1;
    if (carriesRealUsage(r)) agg.real += 1;
    if (r.sub !== null) agg.subs.add(r.sub);
    byType.set(r.type, agg);
  }
  for (const [t, a] of [...byType.entries()].sort((x, y) => y[1].n - x[1].n)) {
    out(`   ${t.padEnd(26)} ${String(a.n).padStart(4)}  ${String(a.key).padStart(8)}  ${String(a.real).padStart(11)}   ${[...a.subs].join(",") || "-"}`);
  }
  return byType;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
function sumUsages(pairs) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, calls: 0 };
  for (const [, u] of pairs) {
    t.input += num(u.input); t.output += num(u.output);
    t.cacheRead += num(u.cacheRead); t.cacheWrite += num(u.cacheWrite);
    t.totalTokens += num(u.totalTokens); t.calls += 1;
  }
  return t;
}
const fmtTotal = (t) =>
  `calls=${t.calls} input=${t.input} output=${t.output} cacheRead=${t.cacheRead} cacheWrite=${t.cacheWrite} totalTokens=${t.totalTokens}`;

function pairsFrom(recs, predicate, pathSuffix) {
  const pairs = [];
  for (const r of recs) {
    if (!predicate(r)) continue;
    for (const h of r.hits) {
      if (isZeroUsage(h.value)) continue;
      if (pathSuffix !== undefined && !h.path.endsWith(pathSuffix)) continue;
      pairs.push([r, h.value]);
    }
  }
  return pairs;
}

// ════════════════════════════════════════════════════════════════
// 主流程
// ════════════════════════════════════════════════════════════════

const instrumentOk = instrumentSelfTest();

rule("[1] 环境");
const temp = mkdtempSync(join(tmpdir(), "sansheng-t1-probe-"));
const tempDb = join(temp, "platform.db");
const tempAgentDir = join(temp, "agent");
const tempCwd = join(temp, "cwd");

function digest(p) {
  try {
    return { sha: createHash("sha256").update(readFileSync(p)).digest("hex"), size: statSync(p).size };
  } catch {
    return null;
  }
}
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
  out(`  真数据目录(只读):${DATA_DIR}`);
  out(`  平台库(临时):    ${booted.dbPath}`);
  out(`  agentDir(临时):   ${tempAgentDir}`);
  out(`  cwd(临时):        ${tempCwd}`);
  out(`  provider:         ${booted.provider === null ? "(无)" : `${booted.provider.provider} / ${booted.provider.modelId}`}`);
  check(booted.provider !== null && booted.model !== null, "真 provider 已解析(否则后面全是空跑)");
  if (booted.model === null) return;

  const at = Date.now();
  insertAgent(booted.deps.db, { id: "probe-wk", role: "worker", specialization: "algorithm", displayName: "probe-wk", createdAt: at });
  insertProject(booted.deps.db, { id: "probe-project", name: "探针项目", client: "探针甲方", goal: "量出 usage 挂在哪个事件上", status: "active", createdAt: at });
  addMember(booted.deps.db, "probe-project", "probe-wk", at);

  rule("[2] 建真会话(走生产装配)");
  const created = await createPlatformSession(booted.deps, "probe-wk", "probe-project", {
    cwd: tempCwd, agentDir: tempAgentDir, model: booted.model, dataDir: DATA_DIR,
  });
  if (!created.ok) {
    check(false, "createPlatformSession", `${created.reason}: ${created.detail}`);
    return;
  }
  holder.session = created.session;
  out(`  ✓ 会话已建立 · 工具面 ${created.plan.tools.length} 个 · customTools ${created.wiring.customToolNames.length} 个`);

  // ════════════════════════════════════════════════════════════
  rule("[3] 回合 A —— 纯 SDK 事件面(只 subscribe,平台代码不参与)");
  const PROMPT_A =
    "这是一次接口自检,请**严格分两步**做,不要合并成一条命令:\n" +
    "第一步:调用 bash 工具执行 `echo PROBE_STEP_1`\n" +
    "第二步:再**单独**调用一次 bash 工具执行 `echo PROBE_STEP_2`\n" +
    "两步都执行完之后,只回复一行:PROBE_DONE\n" +
    "不要读取任何文件,不要做别的事。";
  out(`  prompt:\n${PROMPT_A.split("\n").map((l) => `    ${l}`).join("\n")}`);

  const statsBefore = safeStats(created.session);
  const turnA = await rawTurn(created.session, PROMPT_A);
  const statsAfter = safeStats(created.session);

  out(`\n  回合 A 事件数:${turnA.recs.length} · 耗时 ${turnA.elapsedMs}ms`);
  printSequence("回合 A", turnA.recs);
  const tallyA = printTally("回合 A", turnA.recs);

  // ── 每个 LLM 调用一条 usage:对象身份 + 值随流变化 ──
  rule("[4] usage 的**对象身份**与**值随流变化**(v1 仪器坏在这里)");
  out("  每个 LLM 调用一组。`@#n` 是 usage **对象身份**:同一个 #n = 同一个对象");
  out("  ⇒ 早读到的是「那一刻的值」,而后它还会被改写。");
  const calls = groupByCall(turnA.recs);
  for (const [idx, group] of calls) {
    out(`\n  ── LLM 调用 #${idx} ──`);
    for (const r of group) {
      const tag = `${r.type}${r.sub === null ? "" : `(${r.sub})`}`;
      if (r.hits.length === 0) {
        out(`     ${tag.padEnd(34)} 无 usage 键`);
        continue;
      }
      for (const h of r.hits) {
        out(`     ${tag.padEnd(34)} ${h.path}@${h.objId}  ${isZeroUsage(h.value) ? "**全零**" : fmtUsage(h.value)}`);
      }
    }
  }
  const usageObjIds = new Set();
  for (const r of turnA.recs) for (const h of r.hits) usageObjIds.add(h.objId);
  out(`\n  本回合出现过的 usage 对象身份:${[...usageObjIds].join(", ")}(共 ${usageObjIds.size} 个)`);

  // ── 每个调用的 usage 时间线(首/末 + 是否随流变化)──
  out(`\n── 每个 LLM 调用的 usage 时间线(值都是事件时刻快照)──`);
  for (const [idx, group] of calls) {
    const start = group.find((r) => r.type === "message_start");
    const updates = group.filter((r) => r.type === "message_update");
    const end = group.find((r) => r.type === "message_end");
    const first = updates[0];
    const last = updates[updates.length - 1];
    const pick = (r) => {
      if (r === undefined || r.hits.length === 0) return "(无 usage 键)";
      const h = r.hits[0];
      return `output=${num(h.value.output)} obj=${h.objId}${isZeroUsage(h.value) ? "(全零)" : ""}`;
    };
    const outputs = updates.map((r) => num(r.hits[0]?.value.output));
    const grew = new Set(outputs).size > 1;
    out(`   调用 #${idx}:message_start ${pick(start)} → 首条 update ${pick(first)} → 末条 update ${pick(last)}(${updates.length} 条 update) → message_end ${pick(end)}`);
    out(`              update 期间的 output 取值集合:${[...new Set(outputs)].slice(0, 12).join(",")}${new Set(outputs).size > 12 ? "…" : ""} —— ${grew ? "**随流变化**(早读 = 错值)" : "全程不变"}`);
  }

  // ── 带非零 usage 的事件:只打「最终值」那一档 ──
  out(`\n── 回合 A:**终值**在哪里读到(message_end / turn_end / agent_end)──`);
  for (const r of turnA.recs) {
    if (r.type !== "message_end" && r.type !== "turn_end" && r.type !== "agent_end") continue;
    if (!carriesRealUsage(r)) continue;
    for (const h of r.hits.filter((x) => !isZeroUsage(x.value))) {
      out(`  [${r.type}${r.role === null ? "" : ` role=${r.role}`}${r.stopReason == null ? "" : ` stopReason=${r.stopReason}`}] ${h.path}@${h.objId}`);
      out(`      ${fmtUsage(h.value)}`);
    }
  }

  // ── 负样本 ──
  out(`\n── 回合 A:**负样本** —— 别的事件上确实没有 usage(分三类,别混)──`);
  for (const t of ["tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_start", "turn_start", "agent_settled", "queue_update", "entry_appended"]) {
    const agg = tallyA.get(t);
    if (agg === undefined) out(`  · ${t.padEnd(24)} 本回合没出现(不算负样本)`);
    else if (agg.key === 0) out(`  · ${t.padEnd(24)} 出现 ${agg.n} 次,**连 usage 这个键都没有**(深度≤4 扫描 0 命中)`);
    else out(`  · ${t.padEnd(24)} 出现 ${agg.n} 次,带 usage 键 ${agg.key} 次,其中非零 ${agg.real} 次`);
  }
  const toolResultMsgs = turnA.recs.filter((r) => r.role === "toolResult" && carriesUsageKey(r));
  out(`  · toolResult 消息(migration 005 之外的那类)出现 ${toolResultMsgs.length} 条,**usage 键在但全零** ${toolResultMsgs.filter((r) => !carriesRealUsage(r)).length} 条 ⇒ providers 不填它`);
  const deltaRecs = turnA.recs.filter((r) => r.type === "message_update" && r.sub !== null);
  const deltaWithPartialUsage = deltaRecs.filter((r) => r.hits.some((h) => h.path.startsWith("assistantMessageEvent")));
  out(`  · message_update 的 assistantMessageEvent **自身确实带着 usage 键**:${deltaWithPartialUsage.length}/${deltaRecs.length} 条`);
  out(`      路径是 \`assistantMessageEvent.partial.usage\` —— 不是 delta 自己的字段,而是它携带的**整个 partial 消息**;`);
  out(`      而它那份值随流被**就地改写**(见 [4] 的对象身份),所以要等流结束才等于终值。`);

  out(`\n── 回合 A:各事件类型的 Object.keys(原文,证明「没这个键」)──`);
  const keysByType = new Map();
  for (const r of turnA.recs) if (!keysByType.has(r.type)) keysByType.set(r.type, r.evKeys);
  for (const [t, k] of keysByType) out(`   ${t.padEnd(24)} {${k.join(", ")}}`);
  out(`\n   message 对象的键(按 事件/角色):`);
  const msgKeys = new Map();
  for (const r of turnA.recs) if (r.msgKeys !== null && r.role !== null) msgKeys.set(`${r.type}/${r.role}`, r.msgKeys);
  for (const [k, v] of msgKeys) out(`   ${k.padEnd(32)} {${v.join(", ")}}`);
  out(`\n   message_update 的 assistantMessageEvent 形状:`);
  const amuKeys = new Map();
  for (const r of turnA.recs) if (r.amuKeys !== null && r.sub !== null) amuKeys.set(r.sub, r.amuKeys);
  for (const [k, v] of amuKeys) out(`   ${k.padEnd(32)} {${v.join(", ")}}`);

  // ── 断言:负样本 + 正样本 ──
  rule("[5] 断言 —— 正样本必须命中、负样本必须 0 命中");
  const assistantEndA = pairsFrom(turnA.recs, (r) => r.type === "message_end" && r.role === "assistant", "message.usage");
  check(assistantEndA.length >= 1, "正样本:assistant `message_end` 上有 usage", `${assistantEndA.length} 条`);
  check(assistantEndA.some(([, u]) => num(u.output) > 0), "正样本:它的 output 是真值(>0)");
  for (const t of ["tool_execution_start", "tool_execution_update", "tool_execution_end", "agent_start", "turn_start", "agent_settled"]) {
    const agg = tallyA.get(t);
    if (agg !== undefined) check(agg.key === 0, `负样本:${t} 上连 usage 键都没有`, `出现 ${agg.n} 次,usage 键 ${agg.key} 次`);
  }
  check(pairsFrom(turnA.recs, (r) => r.role === "toolResult", "message.usage").length === 0, "负样本:toolResult 上的 usage 拿不到非零值(providers 不填)");
  const startVsEndEqual = calls.every(([, g]) => {
    const s = g.find((r) => r.type === "message_start" && carriesUsageKey(r));
    const e = g.find((r) => r.type === "message_end" && carriesUsageKey(r));
    if (s === undefined || e === undefined) return true;
    const sv = s.hits.find((h) => h.path === "message.usage")?.value;
    const ev = e.hits.find((h) => h.path === "message.usage")?.value;
    return JSON.stringify(sv) === JSON.stringify(ev);
  });
  check(!startVsEndEqual, "**负样本**:`message_start` 上那一份 usage 的**快照**与 `message_end` 的终值**不相等** ⇒ 早读 = 错值(它只是同一个对象被改写的中间态)");

  // ════════════════════════════════════════════════════════════
  rule("[6] 回合级累计:五种口径的实测对照(多轮工具调用怎么加)");
  const turnEndA = pairsFrom(turnA.recs, (r) => r.type === "turn_end", "message.usage");
  const agentEndA = pairsFrom(turnA.recs, (r) => r.type === "agent_end", "usage");
  const A = sumUsages(assistantEndA);
  const B = sumUsages(turnEndA);
  const C = sumUsages(agentEndA);
  out(`  LLM 调用次数(assistant message_end 条数):${A.calls} · turn_end 条数:${B.calls} · 本回合发生工具调用:${turnA.toolStarts} 次`);
  out(`  A) Σ message_end(role=assistant).message.usage  ${fmtTotal(A)}`);
  out(`  B) Σ turn_end.message.usage                      ${fmtTotal(B)}`);
  out(`  C) Σ agent_end.messages[*].usage (role=assistant) ${fmtTotal(C)}`);
  const statDelta = statsAfter !== null && statsBefore !== null
    ? {
        input: statsAfter.tokens.input - statsBefore.tokens.input,
        output: statsAfter.tokens.output - statsBefore.tokens.output,
        cacheRead: statsAfter.tokens.cacheRead - statsBefore.tokens.cacheRead,
        cacheWrite: statsAfter.tokens.cacheWrite - statsBefore.tokens.cacheWrite,
        total: statsAfter.tokens.total - statsBefore.tokens.total,
        cost: statsAfter.cost - statsBefore.cost,
      } : null;
  out(`  D) session.getSessionStats() 前后差分             ${statDelta === null ? "(不可用)" : `input=${statDelta.input} output=${statDelta.output} cacheRead=${statDelta.cacheRead} cacheWrite=${statDelta.cacheWrite} total=${statDelta.total} cost=${statDelta.cost}`}`);
  const eq = (x, y) => x.input === y.input && x.output === y.output && x.cacheRead === y.cacheRead && x.cacheWrite === y.cacheWrite && x.totalTokens === y.totalTokens;
  check(A.calls >= 2, "≥2 次工具调用 ⇒ ≥2 次 LLM 调用 ⇒ ≥2 条 usage(**每次 LLM 调用一条**)");
  check(A.calls === B.calls && eq(A, B), "A 与 B 逐项相等:同一条助手消息在 `message_end` 与 `turn_end` 各投递一次 ⇒ 两条路相加 = 重复计数");
  check(eq(A, C), "A 与 C(agent_end.messages)逐项相等:同一条消息被**第三次**投递 ⇒ 三条路只能选一条");
  check(
    statDelta === null || (statDelta.input === A.input && statDelta.output === A.output && statDelta.cacheRead === A.cacheRead && statDelta.total === A.totalTokens),
    "D 与 A 逐项相等:`session.getSessionStats()` 的前后差分 = 各次调用之和(会话级累计,回合级必须自己差分)",
    statDelta === null ? "" : `D.total=${statDelta.total} A.totalTokens=${A.totalTokens}`,
  );

  // ════════════════════════════════════════════════════════════
  rule("[7] 回合 B —— 生产路径 runTurn() 的 TurnResult 里有没有 usage");
  const captured = [];
  let callB = 0;
  const result = await runTurn({
    session: created.session,
    db: booted.deps.db,
    agentId: "probe-wk",
    projectId: "probe-project",
    message: "只回复一行:PROBE_OK。不要调用任何工具,不要读取任何文件。",
    onEvent: (ev) => {
      if (ev.type === "message_start" && ev.message?.role === "assistant") callB += 1;
      captured.push(record(ev, callB));
    },
  });
  out(`  runTurn 返回的键:{${Object.keys(result).join(", ")}}`);
  out(`  text=${JSON.stringify(result.text.slice(0, 80))} settled=${result.settled} timedOut=${result.timedOut} toolCalls=${result.toolCalls.length}`);
  const capturedAssistantEnd = captured.filter((r) => r.type === "message_end" && r.role === "assistant" && carriesRealUsage(r));
  out(`  runTurn 自己的订阅(onEvent)在同一个回合里看到:事件 ${captured.length} 条,assistant message_end(带真 usage)${capturedAssistantEnd.length} 条`);
  for (const r of capturedAssistantEnd) {
    for (const h of r.hits.filter((x) => !isZeroUsage(x.value))) out(`      [${r.type}] ${h.path}@${h.objId} ${fmtUsage(h.value)}`);
  }
  check(capturedAssistantEnd.length > 0, "回合 B 的事件流里确实有非零 usage(否则这条对照是空跑)");
  check(!Object.prototype.hasOwnProperty.call(result, "usage"), "`TurnResult` 没有 usage 字段 —— 数据在手边,却没被读出来(平台现状)");
  check(
    Object.values(result).every((v) => v === null || typeof v !== "object" || findUsagePaths(v).length === 0),
    "TurnResult 的任何字段里都没有 usage(深度扫描,不是只看顶层)",
  );
  const bSum = sumUsages(pairsFrom(captured, (r) => r.type === "message_end" && r.role === "assistant", "message.usage"));
  out(`  回合 B 的 A 口径合计:${fmtTotal(bSum)}(单次调用)`);
}

/** 按 LLM 调用分组:每次 assistant `message_start` 开启一组。 */
function groupByCall(recs) {
  const groups = new Map();
  for (const r of recs) {
    if (r.callIndex === 0) continue;
    if (r.type === "agent_end") continue;
    const g = groups.get(r.callIndex) ?? [];
    g.push(r);
    groups.set(r.callIndex, g);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

async function rawTurn(session, prompt) {
  const recs = [];
  let settled = false;
  let toolStarts = 0;
  let call = 0;
  const unsub = session.subscribe((ev) => {
    if (ev.type === "tool_execution_start") toolStarts += 1;
    if (ev.type === "message_start" && ev.message?.role === "assistant") call += 1;
    recs.push(record(ev, call));
    if (ev.type === "agent_settled" || ev.type === "agent_end") settled = true;
  });
  const startedAt = Date.now();
  const timer = setTimeout(() => { settled = true; }, 180_000);
  try {
    await session.prompt(prompt);
    const deadline = Date.now() + 10_000;
    while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  } finally {
    clearTimeout(timer);
    unsub();
  }
  return { recs, elapsedMs: Date.now() - startedAt, toolStarts };
}

function safeStats(session) {
  try {
    const s = session.getSessionStats();
    return { tokens: s.tokens, cost: s.cost };
  } catch {
    return null;
  }
}

try {
  if (!instrumentOk) check(false, "仪器自检没过 —— 后面的观测一律不采用");
  else await main();
} catch (err) {
  rule("异常");
  out(`  ✖ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  failures.push(`异常:${err instanceof Error ? err.message : String(err)}`);
} finally {
  DISPOSE();
  rule("[8] 环境纪律与清理");
  const afterSettings = digest(join(DATA_DIR, "settings.json"));
  const afterKeyring = digest(join(DATA_DIR, ".keyring"));
  check(JSON.stringify(beforeDigests.settings) === JSON.stringify(afterSettings), "~/.sansheng/settings.json 摘要逐字不变(只读)", `${beforeDigests.settings?.sha?.slice(0, 12)} → ${afterSettings?.sha?.slice(0, 12)}`);
  check(JSON.stringify(beforeDigests.keyring) === JSON.stringify(afterKeyring), "~/.sansheng/.keyring 摘要逐字不变(只读)", `${beforeDigests.keyring?.sha?.slice(0, 12)} → ${afterKeyring?.sha?.slice(0, 12)}`);
  rmSync(temp, { recursive: true, force: true });
  out(`  临时目录已删:${temp}`);
  out(`\n${"═".repeat(78)}`);
  if (failures.length === 0) out("T1 探针 v2:全部断言通过");
  else {
    out(`T1 探针 v2:${failures.length} 条断言未通过`);
    for (const f of failures) out(`  ✖ ${f}`);
  }
  for (const n of notes) out(`  ⚠️ ${n}`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}
