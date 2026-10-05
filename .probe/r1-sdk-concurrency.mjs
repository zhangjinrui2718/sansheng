#!/usr/bin/env node
/**
 * R1 探针 · 同一 Node 进程内 N 路 `AgentSession` 并发 —— 事件流会不会串?
 * ─────────────────────────────────────────────────────────────────────
 *
 * 回答一个问题:**同一个进程里同时跑 N=3 个 AgentSession,事件流互不污染吗?**
 * 这决定了 `host/serve.ts` 的 `drainAll()` 能不能从「顺序 await」改成
 * 「Promise.all」—— 如果 SDK 内有全局状态(provider client 单例、限流器、
 * 共享 HTTP agent、全局事件总线),并行化会得到一个**静默串扰**。
 *
 * 本文件是**探针**,不是实现:
 *   - 不 import `src/**`(除只读地借用 settings/keyring 的**格式**,不 import 代码)
 *   - 不连任何数据库(用 `SessionManager.inMemory()`)
 *   - 不写任何磁盘位置,除了一个临时 cwd/agentDir,跑完 rm -rf
 *   - `~/.sansheng/` 只读(settings.json + .keyring)
 *
 * ── 三类静默失败的对策(AGENTS.md)─────────────────────────────────
 *
 * 「一个坏掉的检查会返回一个看起来正常的答案」。所以本探针自带**两个方向**:
 *
 *   正样本 `--mode serial`        串行跑 3 个会话 → 断言必须**全绿**
 *   负样本 `--mode neg-live`      真跑,但故意让 prompt 输出别人的标记 → 必须**红**
 *   负样本 `--mode neg-crosswire` 把事件回调接到**错误的会话**上 → 必须**红**
 *
 * 三个都对上,才用同一套断言去看 `--mode stagger` / `--mode simultaneous`。
 *
 * 用法:
 *   node .probe/r1-sdk-concurrency.mjs --mode serial
 *   node .probe/r1-sdk-concurrency.mjs --mode simul           (3 个同时 prompt)
 *   node .probe/r1-sdk-concurrency.mjs --mode stagger         (错开 1.5s)
 *   node .probe/r1-sdk-concurrency.mjs --mode neg-live        (负样本 1)
 *   node .probe/r1-sdk-concurrency.mjs --mode neg-crosswire   (负样本 2,零额外 API 调用)
 *
 * 环境变量:
 *   SANSHENG_DATA           默认 ~/.sansheng(只读)
 *   PROBE_THINKING          默认 "off"(探针求快;生产是 "medium")
 *   PROBE_TURN_TIMEOUT_MS   默认 240000(单个回合墙钟上界,到点 abort)
 *   PROBE_N                 默认 3
 */
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createDecipheriv } from "node:crypto";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

/* ══════════════════════════════════════════════════════════════════
 * 0. 配置(只读 ~/.sansheng)
 * ══════════════════════════════════════════════════════════════════ */

const DATA_DIR = process.env.SANSHENG_DATA ?? join(homedir(), ".sansheng");
const N = Number(process.env.PROBE_N ?? "3");
const THINKING = process.env.PROBE_THINKING ?? "off";
const TURN_TIMEOUT_MS = Number(process.env.PROBE_TURN_TIMEOUT_MS ?? "240000");

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const MARKERS = ALPHA.slice(0, N).map((l) => `MARKER-${l}`);
const TOKENS = ALPHA.slice(0, N).map((l) => `TOOL-${l}`);

/**
 * 从数据目录读 provider 配置(settings.json + .keyring)。
 *
 * **只读**。解密逻辑照抄 `src/platform/infra/keyring.ts` 的格式
 * (aes-256-gcm,`iv:tag:cipher` 全 base64)—— 这里刻意**不 import** 那个模块,
 * 因为探针要能在「src 被改坏」的情况下仍然如实报出 SDK 的行为。
 */
function loadProvider() {
  const sp = join(DATA_DIR, "settings.json");
  const kp = join(DATA_DIR, ".keyring");
  if (!existsSync(sp)) throw new Error(`settings.json 不存在: ${sp}`);
  const settings = JSON.parse(readFileSync(sp, "utf-8"));
  const p =
    settings.providers.find((x) => x.id === settings.activeProviderId) ?? settings.providers[0];
  if (!p) throw new Error("settings.json 里没有任何 provider");

  let apiKey = p.apiKey ?? "";
  const parts = apiKey.split(":");
  if (parts.length === 3 && existsSync(kp)) {
    const kr = JSON.parse(readFileSync(kp, "utf-8"));
    const master = Buffer.from(kr.masterKey, "base64");
    const d = createDecipheriv("aes-256-gcm", master, Buffer.from(parts[0], "base64"));
    d.setAuthTag(Buffer.from(parts[1], "base64"));
    apiKey = Buffer.concat([d.update(Buffer.from(parts[2], "base64")), d.final()]).toString("utf-8");
  }
  return {
    provider: p.provider,
    modelId: p.modelId,
    apiKey,
    thinkingLevel: p.thinkingLevel,
    baseUrl: p.baseUrl,
    cwd: settings.cwd,
  };
}

/** provider id → 它从 process.env 读哪个变量(与 providers.ts 的映射同构)。 */
function envKeyFor(provider) {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/* ══════════════════════════════════════════════════════════════════
 * 1. 骨架:录制器 / 断言 / 时间线
 * ══════════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const rel = (t) => (t === null || t === undefined ? "  --  " : String(t - t0).padStart(6));
const trunc = (s, n = 90) => {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
};

function newRec(index) {
  return {
    index,
    events: [],
    text: "",
    thinking: "",
    toolStarts: [],
    toolEnds: [],
    usageHits: [],
    usageAbsentTypes: new Set(),
    /** message_end 逐实例:role + 有没有 usage —— 「同类型有的有有的没有」的现场 */
    messageEndDetail: [],
    eventTypeCounts: new Map(),
    /** 整段原始事件流的 JSON —— 最强的一条串扰扫描面 */
    rawJson: "",
    promptSentAt: null,
    promptResolvedAt: null,
    settledAt: null,
    agentStartedAt: null,
    timedOut: false,
    promptError: null,
    finalMessagesText: "",
    sessionId: null,
  };
}

/** 从 tool 结果里抠文本(形状不认识就退化成 JSON,不抛)。 */
function resultText(result) {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const content = result.content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c) => c && typeof c === "object" && typeof c.text === "string")
      .map((c) => c.text);
    if (parts.length > 0) return parts.join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "(unserializable)";
  }
}

/**
 * 事件上所有可能挂 usage 的位置 —— **枚举**比猜一个位置更能分辨「读错了事件」。
 *
 * ⚠️ **必须快照**。`ev.message.usage` 是一个**活引用**:SDK 在同一条消息上
 * 原地累加(流式 delta 期间),所以直接留着引用的话,事后打印出来的是
 * **最后**的值 —— 每个事件的 usage 看起来都一样,而这是假的。
 * (这条正是本探针自己踩过的坑:第一版把 `message_start` 的 usage 也报成了
 * 最终值。)
 */
function usageSnapshot(u) {
  try {
    return JSON.parse(JSON.stringify(u));
  } catch {
    return null;
  }
}
function usageCandidates(ev) {
  const out = [];
  const push = (where, u) => {
    const snap = usageSnapshot(u);
    if (snap) out.push([where, snap]);
  };
  if (ev && typeof ev === "object") {
    if (ev.usage) push("ev.usage", ev.usage);
    if (ev.message?.usage) push("ev.message.usage", ev.message.usage);
    if (ev.partial?.usage) push("ev.partial.usage", ev.partial.usage);
    const ame = ev.assistantMessageEvent;
    if (ame?.partial?.usage) push("ev.assistantMessageEvent.partial.usage", ame.partial.usage);
    if (ame?.usage) push("ev.assistantMessageEvent.usage", ame.usage);
    if (Array.isArray(ev.toolResults)) {
      ev.toolResults.forEach((tr, i) => {
        if (tr?.usage) push(`ev.toolResults[${i}].usage`, tr.usage);
      });
    }
  }
  return out;
}

/** 给带 usage 的事件配一句「这是谁的消息」——usage 只在 assistant 消息上,得能看见。 */
function describeMessage(ev) {
  const m = ev.message ?? ev.partial;
  if (!m || typeof m !== "object") return ev.type;
  const role = m.role ?? "?";
  if (role === "assistant") {
    const c = Array.isArray(m.content) ? m.content.map((x) => x?.type).join("+") : "";
    return `assistant content=[${c}] stop=${m.stopReason ?? "?"} model=${m.model ?? ""}`;
  }
  if (role === "toolResult") return `toolResult ${m.toolName ?? ""} isError=${m.isError}`;
  return String(role);
}

/**
 * 把录制器挂到一个会话上。
 * `writeIndex !== sourceIndex` 就是**负样本**:事件回调接到了错误的会话上。
 */
function attach(session, sourceIndex, writeIndex, recs) {
  const rec = recs[writeIndex];
  const unsub = session.subscribe((ev) => {
    const t = Date.now();
    rec.events.push({ t, type: ev.type, src: sourceIndex });
    rec.eventTypeCounts.set(ev.type, (rec.eventTypeCounts.get(ev.type) ?? 0) + 1);

    if (ev.type === "agent_start") rec.agentStartedAt = t;
    if (ev.type === "agent_settled") rec.settledAt = t;

    if (ev.type === "message_update") {
      const u = ev.assistantMessageEvent;
      if (u?.type === "text_delta") rec.text += u.delta ?? "";
      else if (u?.type === "thinking_delta") rec.thinking += u.delta ?? "";
    }
    if (ev.type === "tool_execution_start") {
      rec.toolStarts.push({ t, toolCallId: ev.toolCallId, toolName: ev.toolName, args: ev.args });
    }
    if (ev.type === "tool_execution_end") {
      rec.toolEnds.push({
        t,
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        isError: ev.isError,
        resultText: resultText(ev.result),
      });
    }
    const hits = usageCandidates(ev);
    if (hits.length === 0) rec.usageAbsentTypes.add(ev.type);
    else {
      const role = describeMessage(ev);
      for (const [where, value] of hits) rec.usageHits.push({ t, type: ev.type, where, value, role });
    }
    if (ev.type === "message_end") {
      rec.messageEndDetail.push({
        t,
        role: describeMessage(ev),
        hasUsage: Boolean(ev.message?.usage),
      });
    }

    // 整段原始事件流留一份 JSON —— 串扰扫描的判据面。
    // 形状不稳定时如实退化成 "[unserializable]",不静默丢事件。
    try {
      rec.rawJson += `${JSON.stringify(ev)}\n`;
    } catch {
      rec.rawJson += "[unserializable]\n";
    }
  });
  return unsub;
}

/**
 * 判定分成两组,**只有第一组决定「能不能并发」**:
 *
 *   gate       「**别人的**东西有没有出现在我这里」= 串扰。这组红 = 不能并发。
 *   compliance 「**我自己的**东西有没有出现」= 模型听不听话。模型不照做
 *              (把 token 当正文吐出来、不调工具)不是串扰;把它混进 gate
 *              会把「模型 flake」误报成「SDK 有全局状态」。
 */
function checkIsolation(recs, label, expectMarkers = MARKERS, expectTokens = TOKENS) {
  const gates = [];
  const compliance = [];
  const warns = [];
  const add = (arr, name, ok, detail) => arr.push({ name, ok: Boolean(ok), detail: detail ?? "" });

  const seenToolCallIds = new Map();
  const allIds = recs.map((r) => r.sessionId).filter((x) => typeof x === "string" && x !== "");

  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const own = expectMarkers[i];
    const ownTok = expectTokens[i];
    const foreign = expectMarkers.filter((_, j) => j !== i);
    const foreignTok = expectTokens.filter((_, j) => j !== i);
    const foreignIds = allIds.filter((id) => id !== r.sessionId);

    /* ───── gate:别人的东西不许出现在我这里 ───── */
    // 最强的一条:整段**原始事件流**的 JSON 里扫别人的标记 / token / sessionId。
    // 如果 SDK 有全局事件总线,一个外来事件会整份出现在这里的 JSON 里。
    const raw = r.rawJson ?? "";
    const leakedRawMarkers = foreign.filter((m) => raw.includes(m));
    add(gates, `[${label}] G S${i} 原始事件流(整段 JSON ${raw.length} 字节)不含别人的标记`,
      leakedRawMarkers.length === 0, leakedRawMarkers.join(", ") || "干净");
    const leakedRawTokens = foreignTok.filter((t) => raw.includes(t));
    add(gates, `[${label}] G S${i} 原始事件流不含别人的 token`,
      leakedRawTokens.length === 0, leakedRawTokens.join(", ") || "干净");
    const leakedIds = foreignIds.filter((id) => raw.includes(id));
    add(gates, `[${label}] G S${i} 原始事件流不含别人的 sessionId`,
      leakedIds.length === 0, leakedIds.length ? `串入 ${leakedIds.join(", ")}` : "干净");

    const leakedText = foreign.filter((m) => r.text.includes(m));
    add(gates, `[${label}] G S${i} 正文不含别人的标记`,
      leakedText.length === 0, leakedText.length ? `串入 ${leakedText.join(", ")}` : "干净");

    const leakedArgs = r.toolStarts.filter((s) => foreignTok.some((tk) => String(s.args?.command ?? "").includes(tk)));
    add(gates, `[${label}] G S${i} 工具参数不含别人的 token`,
      leakedArgs.length === 0, leakedArgs.map((s) => trunc(s.args?.command, 60)).join(" | ") || "干净");

    const leakedEnds = r.toolEnds.filter((e) => foreignTok.some((tk) => e.resultText.includes(tk)));
    add(gates, `[${label}] G S${i} 工具结果不含别人的 token`,
      leakedEnds.length === 0, leakedEnds.map((e) => trunc(e.resultText, 60)).join(" | ") || "干净");

    const ownMsgs = r.finalMessagesText;
    const leakedMsgs = foreign.filter((m) => ownMsgs.includes(m));
    add(gates, `[${label}] G S${i} 自己的 transcript 不含别人的标记`,
      leakedMsgs.length === 0, leakedMsgs.length ? `串入 ${leakedMsgs.join(", ")}` : "干净");

    add(gates, `[${label}] G S${i} 收到过事件(非空)`, r.events.length > 0, `${r.events.length} 个`);

    /* ───── compliance:自己的东西出现了吗(模型听不听话)───── */
    add(compliance, `[${label}] C S${i} 正文出现自己的标记 ${own}`, r.text.includes(own), trunc(r.text));
    add(compliance, `[${label}] C S${i} 真的调了工具(${r.toolStarts.length} 次)`, r.toolStarts.length > 0,
      r.toolStarts.map((s) => `${s.toolName}(${trunc(s.args?.command, 40)})`).join(" ") || "(零次)");
    add(compliance, `[${label}] C S${i} 工具参数指向自己 ${ownTok}`,
      r.toolStarts.length > 0 && r.toolStarts.every((s) => String(s.args?.command ?? "").includes(ownTok)),
      r.toolStarts.map((s) => trunc(s.args?.command, 60)).join(" | ") || "(零次)");
    add(compliance, `[${label}] C S${i} 工具结果回到自己 ${ownTok}`,
      r.toolEnds.length > 0 && r.toolEnds.every((e) => e.resultText.includes(ownTok)),
      r.toolEnds.map((e) => trunc(e.resultText, 60)).join(" | ") || "(零次)");
    add(compliance, `[${label}] C S${i} 自己的 transcript 含自己的标记`,
      ownMsgs.includes(own), `${ownMsgs.length} 字节`);
    add(compliance, `[${label}] C S${i} 回合有终点`, r.settledAt !== null || r.promptResolvedAt !== null,
      `settled=${rel(r.settledAt)} promptResolved=${rel(r.promptResolvedAt)}`);

    for (const s of r.toolStarts) {
      if (!seenToolCallIds.has(s.toolCallId)) seenToolCallIds.set(s.toolCallId, []);
      seenToolCallIds.get(s.toolCallId).push(`S${i}`);
    }
    add(warns, `[${label}] W S${i} 推理流不含别人的标记`,
      foreign.every((m) => !r.thinking.includes(m)),
      foreign.filter((m) => r.thinking.includes(m)).join(", ") || "干净");
  }

  /* ───── gate:toolCallId 跨会话不重复 ───── */
  const collided = [...seenToolCallIds.entries()].filter(([, owners]) => new Set(owners).size > 1);
  add(gates, `[${label}] G toolCallId 跨会话不重复`, collided.length === 0,
    collided.map(([id, o]) => `${id}→${o.join("+")}`).join(" | ") || `${seenToolCallIds.size} 个 id 互不相同`);

  return { gates, compliance, warns };
}

function renderChecks(checks) {
  const out = [];
  for (const c of checks) out.push(`   ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `\n        ${c.detail}` : ""}`);
  return out;
}

/** 时间线交错度:全局事件按时间排序,统计「活跃会话切换」次数与逐桶并发度。 */
function interleaving(recs, bucketMs = 200) {
  const all = [];
  for (let i = 0; i < recs.length; i++) for (const e of recs[i].events) all.push({ ...e, slot: i });
  all.sort((a, b) => a.t - b.t);
  let switches = 0;
  for (let i = 1; i < all.length; i++) if (all[i].slot !== all[i - 1].slot) switches++;

  const buckets = new Map();
  for (const e of all) {
    const k = Math.floor((e.t - t0) / bucketMs);
    if (!buckets.has(k)) buckets.set(k, new Set());
    buckets.get(k).add(e.slot);
  }
  let allThree = 0;
  let maxConcurrent = 0;
  for (const s of buckets.values()) {
    if (s.size >= N) allThree++;
    maxConcurrent = Math.max(maxConcurrent, s.size);
  }
  const spans = recs.map((r) => ({
    start: r.promptSentAt ?? r.agentStartedAt,
    end: r.promptResolvedAt ?? r.settledAt,
  }));
  const overlapFrom = Math.max(...spans.map((s) => s.start ?? Infinity));
  const overlapTo = Math.min(...spans.map((s) => s.end ?? -Infinity));
  return {
    totalEvents: all.length,
    switches,
    buckets: buckets.size,
    bucketsWithAllThree: allThree,
    maxConcurrent,
    spans,
    overlapMs: Number.isFinite(overlapFrom) && Number.isFinite(overlapTo) ? overlapTo - overlapFrom : null,
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 2. 跑一批(建 N 个真会话 → 真 prompt → 收事件)
 * ══════════════════════════════════════════════════════════════════ */

function buildPrompt(i, marker, token) {
  return [
    "You must do exactly two things, nothing more:",
    `1. Call the bash tool exactly once, with exactly this command: echo ${token}`,
    `2. After the tool returns, output exactly this token and nothing else: ${marker}`,
    "Do not run any other tool. Do not explain. Do not add punctuation.",
  ].join("\n");
}

async function runBatch({ label, concurrency, staggerMs, sinkMap, promptMarkers, model, provider, cwd, agentDir }) {
  const recs = Array.from({ length: N }, (_, i) => newRec(i));
  const sessions = [];
  const unsubs = [];

  const fire = async (i) => {
    recs[i].promptSentAt = Date.now();
    const t = setTimeout(() => {
      recs[i].timedOut = true;
      void sessions[i].abort().catch(() => {});
    }, TURN_TIMEOUT_MS);
    try {
      await sessions[i].prompt(buildPrompt(i, promptMarkers[i], TOKENS[i]));
    } catch (err) {
      recs[i].promptError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(t);
      recs[i].promptResolvedAt = Date.now();
    }
  };

  try {
    for (let i = 0; i < N; i++) {
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        model,
        thinkingLevel: THINKING,
        tools: ["bash"],
        sessionManager: SessionManager.inMemory(),
      });
      sessions.push(session);
      unsubs.push(attach(session, i, sinkMap[i], recs));
    }

    const wall0 = Date.now();
    if (concurrency === "serial") {
      // 正样本:一个跑完再跑下一个
      for (let i = 0; i < N; i++) await fire(i);
    } else {
      const launches = [];
      for (let i = 0; i < N; i++) {
        // 同步启动到第一个 await 为止:staggerMs=0 时三个 prompt() 在**同一 tick** 发出
        launches.push(
          (async () => {
            if (staggerMs > 0) await sleep(i * staggerMs);
            await fire(i);
          })(),
        );
      }
      await Promise.all(launches);
    }
    const wallMs = Date.now() - wall0;

    // 给 agent_settled 一点时间(它是 prompt() resolve 之后单独到的)
    const settleDeadline = Date.now() + 8000;
    while (Date.now() < settleDeadline && recs.some((r) => r.settledAt === null)) await sleep(50);

    // 会话自己的 transcript —— 与事件流**不同的一条通道**
    for (let i = 0; i < N; i++) {
      try {
        recs[i].sessionId = sessions[i].sessionId;
        recs[i].finalMessagesText = (sessions[i].messages ?? [])
          .map((m) => (typeof m.content === "string" ? m.content : resultText(m.content)))
          .join("\n");
      } catch {
        recs[i].finalMessagesText = "";
      }
    }
    return { recs, wallMs, sessions };
  } finally {
    for (const u of unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    for (const s of sessions) {
      try {
        s.dispose();
      } catch {
        /* ignore */
      }
    }
    // 调用方可能还要读 sessions;这里只清理临时目录之外的东西 —— 由调用方删 tempRoot
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 3. 输出
 * ══════════════════════════════════════════════════════════════════ */

const out = (s = "") => process.stdout.write(`${s}\n`);
const outs = (lines) => process.stdout.write(`${lines.join("\n")}\n`);
const rule = (t) => out(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);

function printTimeline(recs, wallMs) {
  out(`  总墙钟: ${wallMs}ms (${(wallMs / 1000).toFixed(1)}s)`);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const span =
      r.promptSentAt !== null && r.promptResolvedAt !== null
        ? r.promptResolvedAt - r.promptSentAt
        : null;
    out(
      `  S${i}  prompt发出 ${rel(r.promptSentAt)}  agent_start ${rel(r.agentStartedAt)}  ` +
        `prompt返回 ${rel(r.promptResolvedAt)}  settled ${rel(r.settledAt)}  ` +
        `本回合耗时 ${span === null ? "--" : span + "ms"}` +
        (r.timedOut ? "  ⚠️ 墙钟超时被打断" : "") +
        (r.promptError ? `  ⚠️ prompt 报错: ${trunc(r.promptError, 120)}` : ""),
    );
    out(`       事件数 ${r.events.length}  事件类型 ${[...r.eventTypeCounts.entries()].map(([k, v]) => `${k}×${v}`).join(" ")}`);
    // 里程碑:只看有信息量的那几个事件
    const marks = r.events.filter((e) =>
      ["agent_start", "message_start", "tool_execution_start", "tool_execution_end", "agent_end", "agent_settled"].includes(e.type),
    );
    out(`       里程碑: ${marks.map((e) => `${e.type}@${rel(e.t)}`).join("  ")}`);
    out(`       正文: ${JSON.stringify(trunc(r.text, 160))}`);
    out(`       推理: ${r.thinking.length} 字符`);
    for (const s of r.toolStarts) out(`       ▶ start ${s.toolName} id=${s.toolCallId} args=${trunc(s.args?.command, 60)}`);
    for (const e of r.toolEnds) out(`       ◀ end   ${e.toolName} id=${e.toolCallId} isError=${e.isError} out=${JSON.stringify(trunc(e.resultText, 60))}`);
  }
}

function printUsage(recs) {
  out("\n  ── 每个事件类型上「有没有 usage」 ──");
  const byType = new Map();
  const typeHitCount = new Map();
  const allTypes = new Set();
  for (const r of recs) {
    for (const t of r.eventTypeCounts.keys()) allTypes.add(t);
    for (const h of r.usageHits) {
      const k = `${h.type} :: ${h.where}`;
      if (!byType.has(k)) byType.set(k, { n: 0, sample: h.value });
      const e = byType.get(k);
      e.n++;
      e.sample = h.value;
      typeHitCount.set(h.type, (typeHitCount.get(h.type) ?? 0) + 1);
    }
  }
  for (const [k, v] of byType) {
    const u = v.sample;
    out(
      `   有 usage  ${k}  ×${v.n}  ` +
        `input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} ` +
        `reasoning=${u.reasoning} totalTokens=${u.totalTokens} cost.total=${u.cost?.total}`,
    );
  }
  const never = [...allTypes].filter((t) => !typeHitCount.has(t));
  const mixed = [...allTypes].filter((t) => typeHitCount.has(t) && recs.some((r) => r.usageAbsentTypes.has(t)));
  out(`   负样本 · **完全**没有 usage 的事件类型: ${never.join(", ")}`);
  out(`   混合 · 同一个类型上有的实例有、有的没有: ${mixed.join(", ") || "(无)"}`);
  out(`   ⇒ 「usage 挂在哪个事件上」必须答成 (事件类型, where) 二元组 —— 只看类型会读错。`);

  out("\n  ── 负样本 · 同一个 `message_end` 类型上,哪些实例**没有** usage ──");
  {
    const seen = new Map();
    for (const r of recs) {
      for (const d of r.messageEndDetail) {
        const key = `${d.role} | usage=${d.hasUsage}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    for (const [k, n] of seen) out(`   ${k}  ×${n}`);
  }

  out("\n  ── 逐 message_end 的实测值(快照,不是活引用)──");
  for (const r of recs) {
    const ends = r.usageHits.filter((h) => h.type === "message_end" && h.where === "ev.message.usage");
    const roles = r.rawEventRoles ?? [];
    out(`   S${r.index}: ${ends.length} 条 message_end 带 usage`);
    for (const h of ends) {
      const u = h.value;
      out(
        `      ${trunc(h.role ?? "?", 60).padEnd(62)} input=${u.input} output=${u.output} ` +
          `cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} reasoning=${u.reasoning} ` +
          `totalTokens=${u.totalTokens} cost.total=${u.cost?.total}`,
      );
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
 * 4. main
 * ══════════════════════════════════════════════════════════════════ */

function parseMode() {
  const i = process.argv.indexOf("--mode");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "serial";
}
function parseRounds() {
  const i = process.argv.indexOf("--rounds");
  return i >= 0 && process.argv[i + 1] ? Math.max(1, Number(process.argv[i + 1])) : 1;
}

const MODE_SPEC = {
  serial: { concurrency: "serial", staggerMs: 0, negPrompt: false, isPositive: true },
  simul: { concurrency: "simul", staggerMs: 0, negPrompt: false, isPositive: true },
  stagger: { concurrency: "simul", staggerMs: 1500, negPrompt: false, isPositive: true },
  "neg-live": { concurrency: "serial", staggerMs: 0, negPrompt: true, isPositive: false },
};

async function main() {
  const mode = parseMode();
  rule(`R1 探针 · mode=${mode} · N=${N} · thinking=${THINKING}`);

  const p = loadProvider();
  out(`  数据目录(只读): ${DATA_DIR}`);
  out(`  provider:        ${p.provider} / ${p.modelId}`);
  out(`  明文 key:        ${p.apiKey ? `${p.apiKey.slice(0, 4)}…${p.apiKey.slice(-4)} (len=${p.apiKey.length})` : "(空!)"}`);

  const envKey = envKeyFor(p.provider);
  process.env[envKey] = p.apiKey; // 与 syncActiveProviderApiKeyEnv 同一条通道
  out(`  已注入 env:      ${envKey}`);

  const model = getBuiltinModel(p.provider, p.modelId);
  if (!model) throw new Error(`catalog 里没有 ${p.provider}/${p.modelId}`);
  out(`  model.api:       ${model.api}   baseUrl=${model.baseUrl}  reasoning=${model.reasoning}`);

  const tempRoot = mkdtempSync(join(tmpdir(), "r1-probe-root-"));
  const cwd = join(tempRoot, "cwd");
  const agentDir = join(tempRoot, "agent");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  out(`  临时 cwd:        ${cwd}`);
  out(`  临时 agentDir:   ${agentDir}   (真实 ~/.sansheng 全程只读)`);

  let exitCode = 0;
  try {
    if (MODE_SPEC[mode]) {
      const spec = MODE_SPEC[mode];
      const rounds = parseRounds();
      // neg-live:真跑,但**故意**让每个会话输出别人的标记(期望值不变)→ 断言必须红
      const promptMarkers = spec.negPrompt ? MARKERS.map((_, i) => MARKERS[(i + 1) % N]) : MARKERS;
      const sinkMap = Array.from({ length: N }, (_, i) => i);

      const roundVerdicts = [];
      for (let round = 0; round < rounds; round++) {
        rule(
          `第 ${round + 1}/${rounds} 轮 · mode=${mode} · ${spec.concurrency === "serial" ? "严格串行(一个跑完再跑下一个)" : spec.staggerMs ? `同 tick 起跑但错开 ${spec.staggerMs}ms` : "三个 prompt() 在同一 tick 同时发出"}` +
            (spec.negPrompt ? " · prompt 标记故意对调" : ""),
        );
        const { recs, wallMs } = await runBatch({
          label: mode,
          concurrency: spec.concurrency,
          staggerMs: spec.staggerMs,
          sinkMap,
          promptMarkers,
          model,
          provider: p.provider,
          cwd,
          agentDir,
        });

        rule("时间线 / 事件归属 / 工具结果");
        printTimeline(recs, wallMs);
        const il = interleaving(recs);
        out(
          `\n  交错度: 全局事件 ${il.totalEvents} 个 · 活跃会话切换 ${il.switches} 次 · ` +
            `${il.buckets} 个 200ms 桶(其中 ${il.bucketsWithAllThree} 个桶里 ${N} 个会话同时在动,峰值并发 ${il.maxConcurrent}) · ` +
            `三段时间重叠 ${il.overlapMs === null ? "无" : il.overlapMs + "ms"}`,
        );
        printUsage(recs);

        const { gates, compliance, warns } = checkIsolation(recs, `${mode} r${round + 1}`);
        rule(`【判定组】门禁断言(串扰)—— mode=${mode} 第 ${round + 1} 轮`);
        outs(renderChecks(gates));
        const gateFailed = gates.filter((c) => !c.ok);
        out(
          gateFailed.length === 0
            ? `\n  → 门禁 ${gates.length} 条**全绿**:没有任何一个会话的通道里出现过别人的东西`
            : `\n  → 门禁 ${gateFailed.length}/${gates.length} 条**红**: ${gateFailed.map((f) => f.name).join(" ; ")}`,
        );
        rule(`【观测组】模型遵从性(不参与判定)—— mode=${mode} 第 ${round + 1} 轮`);
        outs(renderChecks(compliance));
        const compFailed = compliance.filter((c) => !c.ok);
        out(
          compFailed.length === 0
            ? `\n  → 遵从性 ${compliance.length} 条全绿`
            : `\n  → 遵从性 ${compFailed.length}/${compliance.length} 条红(模型没照做 —— **不是串扰**)`,
        );
        out("\n  软检查:");
        outs(renderChecks(warns));
        roundVerdicts.push({ round, gates, gateFailed, compliance, compFailed, il });
        if (spec.isPositive && gateFailed.length > 0) {
          out("  ⚠️ 正样本的**门禁**红了 → 这个探针本身坏了,后面所有结论作废。");
          exitCode = 1;
        }
        if (!spec.isPositive && gateFailed.length === 0 && compFailed.length === 0) {
          out("  ⚠️ 负样本全绿 → 断言恒真,探针没有分辨力。");
          exitCode = 1;
        }
      }

      if (rounds > 1) {
        rule(`mode=${mode} · ${rounds} 轮汇总`);
        for (const v of roundVerdicts) {
          out(
            `  第 ${v.round + 1} 轮: 门禁 ${v.gateFailed.length === 0 ? "全绿" : `${v.gateFailed.length} 红`}` +
              ` · 遵从性 ${v.compFailed.length === 0 ? "全绿" : `${v.compFailed.length} 红`}` +
              ` · 活跃会话切换 ${v.il.switches} 次 · 峰值并发 ${v.il.maxConcurrent}` +
              ` · 桶内 ${N} 路并发 ${v.il.bucketsWithAllThree}/${v.il.buckets}`,
          );
        }
      }
    } else if (mode === "neg-crosswire") {
      rule("先跑一次干净的串行,再**事后**把事件回调接到错误的会话上(零额外 API 调用)");
      const { recs, wallMs } = await runBatch({
        label: "crosswire-base",
        concurrency: "serial",
        staggerMs: 0,
        sinkMap: Array.from({ length: N }, (_, i) => i),
        promptMarkers: MARKERS,
        model,
        provider: p.provider,
        cwd,
        agentDir,
      });
      out(`  基线(正确接线)总墙钟 ${wallMs}ms`);
      const base = checkIsolation(recs, "基线(正确接线)");
      outs(renderChecks(base.gates));
      out(`\n  → 基线门禁 ${base.gates.filter((c) => !c.ok).length} 红 / ${base.gates.length} 条`);

      // 事后重放:把 S(i) 的录制内容整体搬到 S(i+1) 的槽位
      const rotated = [recs[1], recs[2], recs[0]];
      const neg = checkIsolation(rotated, "负样本(回调接错会话)");
      rule("负样本【门禁】断言输出(必须红)");
      outs(renderChecks(neg.gates));
      const negFailed = neg.gates.filter((c) => !c.ok);
      out(
        negFailed.length > 0
          ? `\n  → 负样本门禁 ${negFailed.length}/${neg.gates.length} 条红 ✓ 门禁有分辨力`
          : `\n  → 负样本门禁全绿 ✗✗ 门禁恒真,不可用!`,
      );
      exitCode = negFailed.length > 0 ? 0 : 1;
    } else {
      out(`\n✖ 未知 mode: ${mode}`);
      exitCode = 1;
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
    out(`\n  (临时目录已清理: ${tempRoot})`);
  }
  return exitCode;
}

main()
  .then((code) => {
    // SDK 可能留着 cache-warmer / 子进程句柄 —— 探针不许留下进程
    process.exit(code);
  })
  .catch((err) => {
    out(`\n✖ 探针崩了: ${err?.stack ?? err}`);
    process.exit(2);
  });
