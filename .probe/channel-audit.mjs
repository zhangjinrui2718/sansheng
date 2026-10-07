/**
 * 通道分离取证探针(纯只读 · 不改任何生产文件)
 *
 * ── 它回答什么 ──────────────────────────────────────────────────
 *
 * 用户报告:「这些对话过程不需要展示在和我对话的框里面」。他贴出的工具序列是
 *   meeting_read → meeting_respond → ask_client → blocker_read ×2
 *   → project_read → tell_client → board_write
 *
 * 本探针**不猜**,它把真机数据喂进真路径:
 *
 *   ① 历史面:真 REST 载荷(`GET /api/projects/:id/messages`,直接从运行中的
 *      2718 抓的 JSON)→ 真 `useChatStore.selectProject`(内部走真 `messageToTurn`)
 *      → 真 `channelContextOf` / `channelOf` / `partitionTurns`。
 *   ② 流式面:真 SDK 会话转录(`~/.sansheng/agent/sessions/` 下的 jsonl,里面是
 *      四个角色**真实调用过**的工具名与顺序)→ 按 `host/serve.ts` 的 `bridge()`
 *      逐字重建 WS 信封 → 真 `applyEvent` → 真 `inFlightTurns` → 真 `partitionTurns`。
 *
 * ⚠️ 流式面是**重建**,不是录播:工具名与顺序来自真实转录,信封按服务端发射代码
 *    逐字构造。历史面是**逐字真实**的 HTTP 响应。
 *
 * 跑法:`npx tsx .probe/channel-audit.mjs`
 */
import { readFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = "/Users/fuyao/projects/sansheng";
const LIVE = "/Users/fuyao/.sansheng";
const SDK = join(LIVE, "agent/sessions/--Users-fuyao-sansheng-workspace--");
const BASE = "http://127.0.0.1:2718";
const PROJECT_ID = "pj_muujuaia2cx8bpvp";

// ── 临时工作区:真库**只读副本**(db + wal + shm 一起拿,否则读到的是旧页)─────
// 原库一个字节都不动;跑完在 finally 里整棵删掉。
const TMP = mkdtempSync(join(tmpdir(), "ss-channel-audit-"));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
for (const ext of ["", "-wal", "-shm"]) {
  copyFileSync(join(LIVE, `sansheng.db${ext}`), join(TMP, `live.db${ext}`));
}

// ── 真模块(经 tsx 解析 tsconfig paths:`@/*` → web/src,`@shared/*` → shared)──
const dataMod = await import(join(ROOT, "web/src/lib/data.ts"));
const chatMod = await import(join(ROOT, "web/src/stores/chat.ts"));
const { channelContextOf, channelOf, partitionTurns } = dataMod;
const { useChatStore, inFlightTurns } = chatMod;

// ── 真载荷:优先从**正在跑的宿主**抓(浏览器拿到的那一份);抓不到就回落到
//    同一批**服务端读函数**(路由调的就是它们)在本副本上现算。
async function capture(path, serverSide) {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { body: await res.json(), src: `HTTP ${path}` };
  } catch {
    /* 宿主没起 —— 走回落 */
  }
  return { body: await serverSide(), src: `服务端读函数(${path})` };
}

let dbCopy = null;
async function serverSideDb() {
  if (dbCopy === null) {
    const Database = (await import("better-sqlite3")).default;
    dbCopy = new Database(join(TMP, "live.db"), { readonly: true, fileMustExist: true });
  }
  return dbCopy;
}
const views = await import(join(ROOT, "src/platform/transport/views.ts"));
const httpMod = await import(join(ROOT, "src/platform/transport/http.ts"));

const messagesCap = await capture(
  `/api/projects/${PROJECT_ID}/messages`,
  async () => ({ projectId: PROJECT_ID, messages: views.listProjectMessages(await serverSideDb(), PROJECT_ID) }),
);
const membersCap = await capture(
  `/api/projects/${PROJECT_ID}/members`,
  async () => ({ members: views.listProjectMembers(await serverSideDb(), PROJECT_ID) }),
);
const harnessCap = await capture("/api/harness", async () =>
  httpMod.buildHarnessView(await serverSideDb(), LIVE),
);

const messagesFixture = messagesCap.body;
const membersFixture = membersCap.body;
const harnessFixture = harnessCap.body;
const DB = await serverSideDb();

// ── 把真 REST 载荷喂给真前端:`fetch` 的唯一出口是 `api.ts` 的 request() ────────
const ROUTES = new Map([
  [`/api/projects/${PROJECT_ID}/messages`, messagesFixture],
  [`/api/projects/${PROJECT_ID}/members`, membersFixture],
  [`/api/harness`, harnessFixture],
]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const path = typeof url === "string" ? url : String(url);
  if (ROUTES.has(path)) {
    return new Response(JSON.stringify(ROUTES.get(path)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({ code: "not_found", message: `probe 没录这条路径:${path}` }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
};

// ── 真路径 ①:历史(turns 列表)──────────────────────────────────────────
await useChatStore.getState().selectProject(PROJECT_ID);
const turns = useChatStore.getState().turns;

// 判据上下文与 MessageList.tsx:189-204 逐字同款
const ctx = channelContextOf({
  members: membersFixture.members,
  roles: harnessFixture.roles,
  ready: true,
  intake: false,
});
const history = partitionTurns(turns, ctx);

const HEAD = (s) => (s.length <= 40 ? s : s.slice(0, 40) + "…");
function firstText(turn) {
  for (const b of turn.blocks) {
    if (b.kind === "text") return b.text.replace(/\s+/g, " ").trim();
    if (b.kind === "thinking") return `[thinking] ${b.text.replace(/\s+/g, " ").trim()}`;
    if (b.kind === "tool") return `[tool] ${b.tool.name}`;
  }
  return "(空)";
}

function bar(title) {
  console.log("\n" + "═".repeat(118));
  console.log(title);
  console.log("═".repeat(118));
}

// ── ⓪ 那 8 个工具到底归谁(用真的 `factoryToolset`,不是抄文档)─────────────
const roleMod = await import(join(ROOT, "src/platform/identity/role.ts"));
const QUOTED = [
  "meeting_read",
  "meeting_respond",
  "ask_client",
  "blocker_read",
  "project_read",
  "tell_client",
  "board_write",
];
bar("⓪ 用户贴的那串 ⚙ 工具,谁的工具面里有?(真 `factoryToolset`,由 ceiling 推导)");
console.log(["工具".padEnd(18), ...roleMod.PROJECT_ROLES.map((r) => r.padEnd(18))].join(" | "));
console.log("-".repeat(118));
const toolOwner = new Map();
for (const name of QUOTED) {
  const owners = roleMod.PROJECT_ROLES.filter((r) => roleMod.factoryToolset(r).includes(name));
  toolOwner.set(name, owners);
  console.log(
    [name.padEnd(18), ...roleMod.PROJECT_ROLES.map((r) => (owners.includes(r) ? "✔" : "—").padEnd(18))].join(" | "),
  );
}
console.log("-".repeat(118));
const onlyBm = QUOTED.filter((n) => {
  const o = toolOwner.get(n);
  return o.length === 1 && o[0] === "business_manager";
});
const notWk = QUOTED.filter((n) => !toolOwner.get(n).includes("worker"));
console.log(`只有业务经理拿得到的:${onlyBm.join(", ") || "(无)"}`);
console.log(`worker **拿不到**的:${notWk.join(", ")}`);
console.log(
  `⇒ 用户贴出的序列里有 ${onlyBm.length} 个工具是**业务经理独有**的(含 ask_client / tell_client)` +
    ` ⇒ 那串 ⚙ 不可能是 worker 的过程。`,
);

bar("坐标");
console.log(`HEAD 工作区 = ${ROOT}`);
console.log(`projectId = ${PROJECT_ID}`);
console.log(`真库副本 = ${TMP}/live.db(原库 ~/.sansheng/sansheng.db 只读,跑完删除)`);
console.log(`载荷来源: messages=${messagesCap.src}`);
console.log(`          members =${membersCap.src}`);
console.log(`          harness =${harnessCap.src}`);
console.log(`harness 角色面(clientFacing 的来源):`);
for (const r of harnessFixture.roles) console.log(`   ${r.role.padEnd(18)} clientFacing=${r.clientFacing}`);
console.log(`成员表(agentId → role 的来源,逐条抄自真响应):`);
for (const m of membersFixture.members) console.log(`   ${m.id.padEnd(4)} ${m.role}`);
console.log(`channelContextOf → rolesByAgentId=${JSON.stringify([...ctx.rolesByAgentId])}`);
console.log(`channelContextOf → clientFacingRoles=${JSON.stringify([...ctx.clientFacingRoles])}`);

// ── ① 逐轮归属表(历史面)─────────────────────────────────────────────
bar("① 逐轮归属表 —— 历史面(真 REST → 真 messageToTurn → 真 channelOf/partitionTurns)");
console.log(
  [
    "messageId".padEnd(20),
    "agentId".padEnd(8),
    "role".padEnd(10),
    "channelOf".padEnd(10),
    "落点".padEnd(9),
    "内容前 40 字",
  ].join(" | "),
);
console.log("-".repeat(118));
const hiddenIds = new Set();
for (const t of turns) {
  const ch = channelOf(t, ctx);
  const where = ch === "internal" ? "hidden" : "timeline";
  if (ch === "internal") hiddenIds.add(t.id);
  console.log(
    [
      t.id.padEnd(20),
      String(t.agentId ?? "null").padEnd(8),
      t.role.padEnd(10),
      ch.padEnd(10),
      where.padEnd(9),
      HEAD(firstText(t)),
    ].join(" | "),
  );
}
console.log("-".repeat(118));
console.log(
  `timeline=${history.timeline.length}  hidden=${history.hidden}  turns=${turns.length}`,
);
console.log(`被滤掉的 id:${[...hiddenIds].join(", ") || "(无)"}`);

// ── ② 流式面:从真 SDK 转录重建 WS 信封,再走真 applyEvent ────────────────
/**
 * 真转录 → 平台事件。
 *
 * 与 `src/platform/host/serve.ts` 的 `bridge()` 逐条对齐:
 *   assistant part `thinking`  → `thinking_delta`
 *   assistant part `text`      → `delta`
 *   assistant part `toolCall`  → `tool_start`(+ 其后的 toolResult → `tool_end`)
 *   一个 platform 回合 = 一个 `messageId`,由 user 消息切段。
 */
function loadTurns(fileName) {
  const lines = readFileSync(join(SDK, fileName), "utf8").trim().split("\n");
  const out = [];
  let cur = null;
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "message") continue;
    const m = o.message;
    if (m.role === "system") continue;
    if (m.role === "user") {
      const txt = Array.isArray(m.content)
        ? m.content.map((c) => c.text ?? "").join("")
        : String(m.content ?? "");
      const role = (txt.match(/你是:([^\n(（]+)/) ?? [, "?"])[1].trim();
      cur = { role, startedAt: o.timestamp, parts: [] };
      out.push(cur);
      continue;
    }
    if (cur === null) continue;
    if (m.role === "assistant") {
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p.type === "thinking") cur.parts.push({ kind: "thinking", text: p.thinking });
        else if (p.type === "text") cur.parts.push({ kind: "text", text: p.text });
        else if (p.type === "toolCall")
          cur.parts.push({ kind: "tool", id: p.id, name: p.name, args: p.arguments });
      }
      continue;
    }
    if (m.role === "toolResult") {
      cur.parts.push({ kind: "toolResult", id: m.toolCallId, name: m.toolName });
      continue;
    }
  }
  return out.filter((t) => t.parts.length > 0);
}

const AGENT_ID = { 业务经理: "bm", 项目经理: "pm", Worker: "wk", 质检审查员: "qa" };

/**
 * 一个真转录回合 → 真 `applyEvent` 序列。
 *
 * `end === false` 刻意**不发 `agent_end`** —— 那正是「流式进行中」那一刻,也就是
 * 用户盯着屏幕、看到一串 ⚙ 卡正在往上长的时刻(`inFlight` 里的轮)。
 * `end === true` 时补发 `agent_end`,轮被 flush 进 `turns` —— 复现「回合结束后、
 * 刷新之前,那些卡仍然在甲方时间线上」。
 */
function replay(turn, messageId, projectId, end = false) {
  const agentId = AGENT_ID[turn.role];
  if (agentId === undefined) throw new Error(`未知角色 ${turn.role}`);
  const store = useChatStore.getState();
  store.applyEvent({
    type: "message_start",
    projectId,
    messageId,
    role: "assistant",
    agentId,
  });
  for (const p of turn.parts) {
    const s = useChatStore.getState();
    if (p.kind === "thinking") {
      s.applyEvent({ type: "thinking_delta", projectId, messageId, text: p.text });
    } else if (p.kind === "text") {
      s.applyEvent({ type: "delta", projectId, messageId, text: p.text });
    } else if (p.kind === "tool") {
      s.applyEvent({
        type: "tool_start",
        projectId,
        messageId,
        agentId,
        tool: { id: p.id, name: p.name, args: p.args },
      });
    } else if (p.kind === "toolResult") {
      s.applyEvent({
        type: "tool_end",
        projectId,
        messageId,
        tool: { id: p.id, name: p.name, result: "ok" },
      });
    }
  }
  useChatStore.getState().applyEvent({ type: "message_end", projectId, messageId });
  if (end) useChatStore.getState().applyEvent({ type: "agent_end", projectId });
}

// 真转录文件(以 SDK 会话文件名里的起始时刻为坐标)
const BM_FILE = "2026-10-05T01-11-08-352Z_01a1099d-5540-7666-8dfd-770d15133df2.jsonl";
const WK_FILE = "2026-10-05T01-14-23-653Z_01a1099a-5020-7666-8dfd-770f80ef1f67.jsonl";
const QA_FILE = "2026-10-05T01-27-20-337Z_01a109ac-2a11-7666-8dfd-771046c5c1d3.jsonl";

const bmTurns = loadTurns(BM_FILE);
const qaTurns = loadTurns(QA_FILE);

bar("② 真 SDK 转录里的工具调用顺序(这是「用户看到的那串 ⚙」的真身)");
for (const [label, file, list] of [
  ["业务经理(bm)", BM_FILE, bmTurns],
  ["质检(qa)", QA_FILE, qaTurns],
]) {
  console.log(`\n${label} · ${file}`);
  for (const t of list) {
    console.log(`   角色=${t.role}  起于 ${t.startedAt}`);
    console.log(
      "     工具序列: " +
        (t.parts.filter((p) => p.kind === "tool").map((p) => p.name).join(" → ") || "(无工具)"),
    );
  }
}

// 清空 → 只放流式轮,看它们在通道里的落点
useChatStore.getState().reset();
useChatStore.setState({ projectId: PROJECT_ID, intakeActive: false });

/** 打印一张「轮 → 通道」表(与 MessageList.tsx:203-204 的两条路逐条对应)。 */
function table(title, list) {
  const part = partitionTurns(list, ctx);
  bar(title);
  console.log(
    ["messageId".padEnd(18), "agentId".padEnd(8), "channelOf".padEnd(10), "落点".padEnd(9), "块构成", "工具卡"].join(
      " | ",
    ),
  );
  console.log("-".repeat(118));
  for (const t of list) {
    const ch = channelOf(t, ctx);
    const where = ch === "internal" ? "hidden" : "timeline";
    const inv = {
      thinking: t.blocks.filter((b) => b.kind === "thinking").length,
      text: t.blocks.filter((b) => b.kind === "text").length,
      tool: t.blocks.filter((b) => b.kind === "tool").length,
    };
    console.log(
      [
        t.id.padEnd(18),
        String(t.agentId ?? "null").padEnd(8),
        ch.padEnd(10),
        where.padEnd(9),
        `think=${inv.thinking} text=${inv.text} tool=${inv.tool}`.padEnd(28),
        t.blocks
          .filter((b) => b.kind === "tool")
          .map((b) => b.tool.name)
          .join(",") || "-",
      ].join(" | "),
    );
  }
  console.log("-".repeat(118));
  console.log(
    `timeline=${part.timeline.length}  hidden=${part.hidden}  turns=${list.length}`,
  );
  return part;
}

// 甲:业务经理的第一个真回合,正流到一半(没有 agent_end)
replay(bmTurns[0], "msg_probe_bm_1", PROJECT_ID, false);
table(
  "②-a 流式面(进行中):业务经理回合 1 —— meeting_read → meeting_respond → ask_client",
  inFlightTurns(useChatStore.getState()),
);

// 乙:该回合收口(agent_end)→ 它被 flush 进 `turns`;再让第二个真回合与质检回合在飞
useChatStore.getState().applyEvent({ type: "agent_end", projectId: PROJECT_ID });
replay(bmTurns[1], "msg_probe_bm_2", PROJECT_ID, false);
if (qaTurns[0]) replay(qaTurns[0], "msg_probe_qa_1", PROJECT_ID, false);

table(
  "②-b 流式面(进行中):业务经理回合 2 + 质检回合",
  inFlightTurns(useChatStore.getState()),
);
table(
  "②-c 历史面(`turns`):业务经理回合 1 已收口 —— 工具卡仍然在甲方时间线上(刷新前)",
  useChatStore.getState().turns,
);

bar("③ 「业务经理做的一切都进甲方通道」的结构证明");
const bmTurn = useChatStore
  .getState()
  .turns.find((t) => t.agentId === "bm");
console.log(`业务经理那一轮 channelOf = ${channelOf(bmTurn, ctx)}`);
console.log(`它的 blocks 里有 ${bmTurn.blocks.filter((b) => b.kind === "tool").length} 张工具卡:`);
for (const b of bmTurn.blocks) {
  if (b.kind === "tool") console.log(`   ⚙ ${b.tool.name}`);
  if (b.kind === "thinking") console.log(`   [思考块 ${b.text.length} 字,默认折叠但同一轮]`);
}
console.log(
  "\n⇒ 这些 ⚙ 卡与思考块是**同一个 Turn(= 同一条 messageId)** 的 blocks," +
    "\n  而 channelOf 只看 Turn.agentId ⇒ 整轮(含工具卡与思考)一起进甲方时间线。",
);

bar("⑤ 业务经理的**正文**里有没有把过程写进去(真库逐字)");
const { splitWorkLog } = await import(join(ROOT, "web/src/components/chat/MessageList.tsx"));
const db = DB;
const bmRows = db
  .prepare(
    "SELECT id, content, created_at FROM session_messages WHERE agent_id='bm' ORDER BY created_at",
  )
  .all();
const TOOL_NAMES = [
  "meeting_read",
  "meeting_respond",
  "meeting_conclude",
  "convene",
  "ask_client",
  "blocker_read",
  "project_read",
  "tell_client",
  "board_write",
  "board_read",
  "work_read",
];
console.log(`真库里 bm 的 assistant 消息 ${bmRows.length} 条\n`);
for (const r of bmRows) {
  const hit = TOOL_NAMES.filter((n) => r.content.includes(n));
  const segs = splitWorkLog(r.content).map((s) => `${s.kind}(${s.text.length}字)`);
  console.log(`── ${r.id}  ${r.content.length} 字`);
  console.log(`   正文里出现的工具名: ${hit.length > 0 ? hit.join(", ") : "(无)"}`);
  console.log(`   splitWorkLog 切出的段: ${segs.join(" + ")}`);
  if (hit.length > 0) {
    for (const line of r.content.split("\n")) {
      if (TOOL_NAMES.some((n) => line.includes(n))) console.log(`      > ${line.trim()}`);
    }
  }
}
const wl = db
  .prepare("SELECT COUNT(*) c FROM session_messages WHERE content LIKE '%未播报%'")
  .get();
console.log(
  `\n含「未播报」四个字的消息总数(全库)= ${wl.c}  —— A4 的行首分流器在真数据上**一次都不会触发**`,
);

bar("④ 负样本自检 —— 这个检查本身可信吗");
const fakeWorker = {
  id: "msg_probe_negative",
  projectId: PROJECT_ID,
  role: "assistant",
  agentId: "wk",
  blocks: [{ kind: "tool", tool: { id: "t1", name: "board_write", args: {} } }],
  startedAt: 0,
  isStreaming: false,
};
const fakeUnknown = {
  id: "msg_probe_unknown_agent",
  projectId: PROJECT_ID,
  role: "assistant",
  agentId: "no_such_agent",
  blocks: [{ kind: "text", text: "x" }],
  startedAt: 0,
  isStreaming: false,
};
const neg = partitionTurns(
  [fakeWorker, fakeUnknown, ...inFlightTurns(useChatStore.getState())],
  ctx,
);
console.log(`必须 hidden 的正样本 wk 轮        → ${channelOf(fakeWorker, ctx)}`);
console.log(`必须 hidden 的正样本 未知 agent 轮 → ${channelOf(fakeUnknown, ctx)}`);
console.log(`必须 client 的正样本 bm 轮        → ${channelOf(bmTurn, ctx)}`);
console.log(`必须 system 的正样本 system 轮    → ${channelOf(
  turns.find((t) => t.role === "system"),
  ctx,
)}`);
console.log(`partitionTurns 汇总:hidden=${neg.hidden}(含 2 条人造负样本)`);

globalThis.fetch = realFetch;
