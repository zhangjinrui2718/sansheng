/**
 * 职责(039,2026-11-27)· 宿主级端到端 —— 真宿主 + 假会话,走完一整轮
 *
 * ── 它证明什么(前两份测试证明不了的)──────────────────────────
 *
 * `duty-rule.test.ts` / `duty-runs.test.ts` 是在内存库上直接调规则与工具。这里多的是
 * **宿主把它们接起来的那一段**:真进程内的排空循环、真 HTTP 建职责(连带建工作区)、
 * 真会话(裹着真适配器)、真落库的对话消息、排空前的熔断扫描、桌面通知。
 *
 * ⚠️ 假会话**不会自己调工具**:模型的动作由测试在假会话收到任务正文时**直接调平台工具**
 * (`dispatch`)来扮演 —— 所以这里证明的是「接线」,不是「模型会不会照做」。
 * 后者只能真模型实测。
 *
 *   ① 一整轮:到点 ⇒ 业务经理列功课、请项目经理拆 ⇒ 项目经理建工作项(已确认)⇒
 *      研究员做完 ⇒ 质检通过 ⇒ 业务经理收工写自省;日报落进这条职责的对话。
 *   ② 没人开工:连续三次 ⇒ 宿主的熔断扫描暂停职责(工作间一起停)、落系统消息、弹桌面通知。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/runtime/agentRuntime/pi/providers.js";
import type { CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";
import { openPlatformDb } from "../../src/platform/storage/index.js";
import { loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import { getDuty, getDutyRun } from "../../src/platform/storage/repo/duties.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import { notifyDesktop } from "../../src/platform/host/notify.js";
import type Database from "better-sqlite3";

// 桌面通知不许真的弹:只看「有没有叫它」。
vi.mock("../../src/platform/host/notify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/host/notify.js")>();
  return { ...actual, notifyDesktop: vi.fn() };
});

let dataDir = "";
let host: PlatformHost | undefined;
let server: Server | undefined;
let db: Database.Database | undefined;
/** 只给「等待超时」的报错用:把被叫醒的回合摆出来,不然超时只能靠猜。 */
let hDebug: { prompts: string[]; db?: Database.Database } = { prompts: [] };

beforeEach(() => {
  vi.mocked(notifyDesktop).mockReset();
  if (!process.env.SS_VERBOSE_HOST_LOGS) vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-duty-host-"));
  const p = listProviders()[0];
  const model = p?.models[0];
  if (p === undefined || model === undefined) throw new Error("内建 provider catalog 是空的");
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [{ id: "prov_test", label: "test", provider: p.id, modelId: model.id, apiKey: "test-key-not-used", thinkingLevel: "off" }],
      activeProviderId: "prov_test", cwd: dataDir, personaName: "测试",
    }),
    { mode: 0o600 },
  );
});

afterEach(async () => {
  db?.close();
  db = undefined;
  host?.close();
  host = undefined;
  await new Promise<void>((r) => (server !== undefined ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 「模型」在收到任务正文时做什么:返回它这一轮说的正文。 */
type Act = (ctx: { readonly role: string; readonly text: string; readonly call: Call }) => string;
type Call = (tool: string, args: Record<string, unknown>, role: string) => ToolResult;

interface Harness {
  readonly db: Database.Database;
  readonly prompts: string[];
  readonly drainNow: () => void;
  readonly baseUrl: string;
}

/**
 * 假会话:收到任务正文 ⇒ 交给 `act`(测试扮演的模型)⇒ 把它返回的话作为正文发给适配器。
 * 事件是 **pi 方言**(宿主建出来的会话外面裹着真的适配器,平台方言会被它丢掉)。
 */
function makeSession(h: { prompts: string[]; call: Call }, act: Act): AgentSession {
  const listeners = new Set<(ev: AgentSessionEvent) => void>();
  const emit = (ev: AgentSessionEvent): void => { for (const l of [...listeners]) l(ev); };
  return {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    async prompt(text: string) {
      h.prompts.push(text);
      const m = /你是:[^\n]*?\(`([a-z_]+)`\)/.exec(text);
      const reply = act({ role: m?.[1] ?? "unknown", text, call: h.call });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } } as AgentSessionEvent);
      emit({ type: "agent_settled" } as AgentSessionEvent);
      return { messages: [] };
    },
    async abort() { emit({ type: "agent_settled" } as AgentSessionEvent); },
    dispose() {},
  } as unknown as AgentSession;
}

async function startHost(act: Act): Promise<Harness> {
  const prompts: string[] = [];
  let seq = 0;
  // ⚠️ 这里先建一个占位的连接变量:假会话在宿主的回合**进行中**调工具,用的必须是
  // 同一个库文件上的另一条连接(WAL 下多连接安全)。
  let dbRef: Database.Database | undefined;
  const call: Call = (tool, args, role) => {
    if (dbRef === undefined) throw new Error("库连接还没建好");
    const projectId = (dbRef.prepare(`SELECT project_id FROM duties LIMIT 1`).get() as { project_id: string } | undefined)?.project_id;
    if (projectId === undefined) throw new Error("库里还没有职责");
    // ⚠️ 任务正文里的是**角色名**(`business_manager`),而工具上下文要的是**成员 id**(`bm`)——
    // 拿角色名当 id 去查会得到 null。(第一版就这么错的:假会话一开工就抛,三生自己落的
    // 那条「⚠️ 组织停止推进 … 没跑起来:Cannot read properties of null」把它当场说了出来。)
    const agent = dbRef.prepare(`SELECT id FROM agents WHERE role = ?`).get(role) as { id: string } | undefined;
    if (agent === undefined) throw new Error(`库里没有角色 ${role}`);
    const ctx: ToolRunContext = {
      db: dbRef, agent: getAgent(dbRef, agent.id)!, project: loadProjectForAuthz(dbRef, projectId)!,
      now: Date.now, newId: (p) => `${p}_t${++seq}`,
      workspace: createGitWorkspace(), workspaceRoot: dataDir,
    };
    const r = dispatch(tool, args, ctx);
    if (r instanceof Promise) throw new Error("这些工具都是同步的");
    return r;
  };
  const createSession: CreateSessionFn = async () => ({ session: makeSession({ prompts, call }, act) });
  host = createPlatformHost({
    dataDir, host: "127.0.0.1", port: 0, version: "test", createSession,
    dispatchIntervalMs: 0, // 定时器关掉:测试手动排空
  });
  const started = serve({ fetch: host.app.fetch, port: 0, hostname: "127.0.0.1" });
  server = started as unknown as Server;
  await new Promise<void>((r) => started.once("listening", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");
  attachHub(server, host.hub);
  db = openPlatformDb(join(dataDir, "sansheng.db"));
  dbRef = db;
  hDebug = { prompts, db };
  return {
    db,
    prompts,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    drainNow: () => {
      void (host as unknown as { dispatchTimer: { runNow: (why: string) => Promise<unknown> } }).dispatchTimer.runNow("test");
    },
  };
}

async function createDueDuty(h: Harness, name = "行业简报"): Promise<{ id: string; projectId: string }> {
  const created = await fetch(`${h.baseUrl}/api/duties`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, goal: "每天一份三行简报", boundaries: "", cadence: { kind: "daily", at: "03:00" }, formal: false }),
  });
  expect(created.status, "建职责").toBe(201);
  const body = (await created.json()) as {
    duty: { id: string; projectId: string }; workspaceBootstrapped: boolean; workspaceProblem?: string;
  };
  expect(body.workspaceBootstrapped, `职责的工作间要真的建出工作区:${body.workspaceProblem ?? ""}`).toBe(true);
  const run = await fetch(`${h.baseUrl}/api/duties/${body.duty.id}/run-now`, { method: "POST" });
  expect(run.status, "现在做一次").toBe(200);
  return { id: body.duty.id, projectId: body.duty.projectId };
}

/** 这条职责最近的一轮(还没有就 `null`)。 */
function runOf(h: Harness, dutyId: string) {
  const row = h.db.prepare(`SELECT id FROM duty_runs WHERE duty_id = ? ORDER BY started_at DESC LIMIT 1`).get(dutyId) as { id: string } | undefined;
  return row === undefined ? null : getDutyRun(h.db, row.id);
}

async function waitFor(label: string, pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `等待超时:${label}\n被叫醒的回合:${hDebug.prompts.map((p) => `\n  · ${p.slice(0, 160).replace(/\n/g, " ⏎ ")}`).join("")}` +
      `\n他们说了:${hDebug.db === undefined ? "(没有库)" : (hDebug.db.prepare(`SELECT kind, content FROM session_messages WHERE kind IN ('assistant','system')`).all() as Array<{ kind: string; content: string }>).map((m) => `\n  · [${m.kind}] ${m.content.slice(0, 200).replace(/\n/g, " ⏎ ")}`).join("")}`,
  );
}

// ── ① 一整轮 ────────────────────────────────────────────────────

describe("职责 · 宿主级:一整轮从到点到日报", () => {
  it("到点 → 列功课 → 请项目经理拆(工作项已确认)→ 研究员做完 → 质检通过 → 收工写自省", async () => {
    let askId = "";
    const h = await startHost(({ role, text, call }) => {
      if (role === "business_manager" && text.includes("到点了 —— 开工")) {
        const opened = call("duty_run_open", {
          steps: [{ title: "读三份来源", criterion: "三句结论,各带链接" }],
        }, role);
        if (!opened.ok) return `开工失败:${opened.message}`;
        const asked = call("ask_role", {
          targetRole: "project_manager",
          question: "这一轮的功课:读三份来源,各一句带链接的结论。请拆成一条平的工作项(不建根容器),产出写成笔记,交给研究员。",
          hypothesis: "一条工作项就够",
        }, role);
        if (!asked.ok) return `派活失败:${asked.message}`;
        askId = /\((ask_\w+)\)/.exec(asked.text)?.[1] ?? "";
        return "今日功课:读三份来源,各一句带链接的结论。";
      }
      if (role === "project_manager" && text.includes("回答提问")) {
        const answered = call("answer", { askId, body: "拆成一条:读三份来源,交给研究员。" }, role);
        const created = call("work_create", {
          title: "读三份来源", goal: "三份来源各一句带链接的结论",
          assigneeRole: "research_worker", acceptanceCriteria: ["三句结论,各带链接"],
        }, role);
        return answered.ok && created.ok ? "已拆成一条工作项。" : `拆解失败:${answered.message} ${created.message}`;
      }
      if (role === "research_worker" && text.includes("# 工作项 ")) {
        const workId = /# 工作项 (wk_\w+)/.exec(text)?.[1] ?? "";
        const done = call("work_update", { workId, status: "done" }, role);
        return done.ok ? "三份来源都读到了。" : `没做成:${done.message}`;
      }
      if (role === "quality_reviewer") {
        const workId = /(wk_\w+)/.exec(text)?.[1] ?? "";
        const verdict = call("review_verdict", { workId, verdict: "pass", severity: "low", note: "三句结论都有链接" }, role);
        return verdict.ok ? "通过。" : `审查调用失败:${verdict.message}`;
      }
      if (role === "business_manager" && text.includes("该收工了")) {
        const closed = call("duty_run_close", {
          done: "三份来源各一句带链接的结论", notDone: "无", nextChange: "提前十分钟缓存来源",
          gaps: "只覆盖了三家公司", learned: "无",
          steps: [{ done: true, note: "都读到了" }],
        }, role);
        return closed.ok ? "日报:做成 1 步,共 1 步。缺口:只覆盖了三家公司。" : `收工失败:${closed.message}`;
      }
      // 其余被平台叫醒的回合(下游汇报之类):留一行工作记录,不播
      return "[未播报] 评估 0 条 —— 无需播报。";
    });
    const duty = await createDueDuty(h);

    h.drainNow();
    await waitFor("这一轮收工", () => runOf(h, duty.id)?.status === "done");

    // 这一轮:自省落库
    const run = runOf(h, duty.id)!;
    expect(run.status).toBe("done");
    expect(run.steps[0]).toMatchObject({ title: "读三份来源", done: true });
    expect(run.gaps).toBe("只覆盖了三家公司");
    expect(run.failures).toEqual([]);
    // 下一次排到了未来(今天 03:00 已过 ⇒ 明天 03:00),不是「现在」
    const after = getDuty(h.db, duty.id)!;
    expect(after.status).toBe("active");
    expect(after.nextDueAt!).toBeGreaterThan(Date.now());
    // 工作间里:一条工作项,做完、审过,而且**建出来就已确认**(没人在界面上点过「确认开工」)
    const work = h.db.prepare(`SELECT status, review_state, confirmed_at, parent_work_id FROM works WHERE project_id = ?`).get(duty.projectId) as {
      status: string; review_state: string; confirmed_at: number | null; parent_work_id: string | null;
    };
    expect(work).toMatchObject({ status: "done", review_state: "done", parent_work_id: null });
    expect(work.confirmed_at).not.toBeNull();
    // 日报进了这条职责的对话:正文来自 `duty_due` 那一轮的助手消息,封套是「平台叫醒的回合」
    const said = h.db.prepare(
      `SELECT m.content, m.agent_id, m.origin_source, m.trigger_kind, m.todo_kind
       FROM session_messages m JOIN project_sessions s ON s.id = m.session_id
       WHERE s.project_id = ? AND m.kind = 'assistant' ORDER BY m.created_at`,
    ).all(duty.projectId) as Array<{ content: string; agent_id: string; origin_source: string | null; trigger_kind: string | null; todo_kind: string | null }>;
    const dutyTurns = said.filter((m) => m.todo_kind === "duty_due");
    expect(dutyTurns.map((m) => m.content)).toEqual(["今日功课:读三份来源,各一句带链接的结论。", "日报:做成 1 步,共 1 步。缺口:只覆盖了三家公司。"]);
    for (const m of dutyTurns) {
      expect(m.agent_id).toBe("bm");
      expect(m.origin_source).toBe("turn");
      expect(m.trigger_kind).toBe("todo");
    }
    // 任务正文里摆好了「先看现状」要看的那些东西
    const openPrompt = h.prompts.find((p) => p.includes("到点了 —— 开工"))!;
    expect(openPrompt).toContain("从没开过工 —— 这是第一轮");
    expect(openPrompt).toContain("例行产出");
    expect(openPrompt).toContain("这个工作间里还没有任何工作项");
    const closePrompt = h.prompts.find((p) => p.includes("该收工了"))!;
    expect(closePrompt).toContain("工作间安静了");
    expect(closePrompt).toContain("1. 读三份来源 —— 三句结论,各带链接");
    // 空的职责工作间没有让项目经理自己起头拆解
    expect(h.prompts.some((p) => p.includes("拆解是你的第一件事"))).toBe(false);
    // 一切顺利 ⇒ 不弹桌面通知
    expect(vi.mocked(notifyDesktop)).not.toHaveBeenCalled();
  }, 20_000);
});

// ── ② 没人开工 ⇒ 熔断 ──────────────────────────────────────────

describe("职责 · 宿主级:连续没能开工 ⇒ 自动暂停并通知", () => {
  it("业务经理连续三次没列功课 ⇒ 职责暂停(工作间一起停)、落系统消息、弹桌面通知", async () => {
    const h = await startHost(({ role }) =>
      role === "business_manager" ? "我先看下现状。" : "[未播报] 无需处理。",
    );
    const duty = await createDueDuty(h);

    h.drainNow();
    await waitFor("职责被自动暂停", () => getDuty(h.db, duty.id)?.status === "paused");

    const after = getDuty(h.db, duty.id)!;
    expect(after.nextDueAt).toBeNull();
    expect((h.db.prepare(`SELECT status FROM projects WHERE id = ?`).get(duty.projectId) as { status: string }).status).toBe("paused");
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM duty_runs`).get()).toEqual({ n: 0 });
    // 项目页「平台记录」里看得到为什么停了
    const notice = h.db.prepare(
      `SELECT m.content FROM session_messages m JOIN project_sessions s ON s.id = m.session_id
       WHERE s.project_id = ? AND m.kind = 'system' AND m.content LIKE '⚠️ 职责:%'`,
    ).all(duty.projectId) as Array<{ content: string }>;
    expect(notice).toHaveLength(1);
    expect(notifyDesktop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyDesktop).mock.calls[0]![1]).toContain("职责已自动暂停");
    expect(vi.mocked(notifyDesktop).mock.calls[0]![2]).toContain("行业简报");
    // 开工那一轮确实被叫了三次(不是一次就放弃)
    expect(h.prompts.filter((p) => p.includes("到点了 —— 开工"))).toHaveLength(3);
    // 暂停之后不再有任何一轮被叫起来
    const seen = h.prompts.length;
    h.drainNow();
    await new Promise((r) => setTimeout(r, 150));
    expect(h.prompts.length).toBe(seen);
  }, 20_000);
});
