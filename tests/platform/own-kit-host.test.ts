/**
 * 自己的仓库与经验库(040)· 宿主级端到端 —— 真宿主 + 假会话,真 HTTP
 *
 * ── 它证明什么(前几份测试证明不了的)──────────────────────────
 *
 * `own-repo` / `own-mcp` / `agent-notes` 是在内存库上直接调工具与求解函数。这里多的是
 * **宿主把它们接起来的那一段**:启动时建仓、每轮把仓库路径与相关经验拼进任务、
 * 回合收尾提交自己的仓库、里面有 MCP 服务且刚有新提交就换会话、停用端点换会话、
 * 他在跑的那一轮不打断。
 *
 * ⚠️ 假会话**不会自己调工具**:模型的动作由测试在假会话收到任务正文时直接调平台工具
 * 来扮演 —— 这里证明的是「接线」,不是「模型会不会照做」。
 *
 *   ① 启动即建仓;工程师一轮:任务里有仓库路径 → own_write 的文件进了他自己的仓库
 *      (提交作者是工程师);说明类工具不换会话。
 *   ② 写了 MCP 服务 ⇒ 收尾换会话 ⇒ 下一条会话的工具面里有 `mcp__own_…__*`。
 *   ③ 停用端点:换会话、下一轮工具面里没有它、任务里写着「甲方停用了」;
 *      他正在跑时停用 ⇒ 这一轮不打断,收尾后才换。
 *   ④ 经验库的读面与删除;`GET /api/harness` 里三个执行角色有 `own`、业务经理没有。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/runtime/agentRuntime/pi/providers.js";
import type { CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";
import { openPlatformDb } from "../../src/platform/storage/index.js";
import { loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import { notifyDesktop } from "../../src/platform/host/notify.js";
import type Database from "better-sqlite3";

vi.mock("../../src/platform/host/notify.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/host/notify.js")>();
  return { ...actual, notifyDesktop: vi.fn() };
});

// 真宿主 + 真 HTTP + 真 git:每条要跑好几轮排空,默认的 5 秒不够。
vi.setConfig({ testTimeout: 30_000 });

let dataDir = "";
let workRoot = "";
let host: PlatformHost | undefined;
let server: Server | undefined;
let db: Database.Database | undefined;

beforeEach(() => {
  vi.mocked(notifyDesktop).mockReset();
  if (!process.env.SS_VERBOSE_HOST_LOGS) vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-own-kit-host-data-"));
  workRoot = mkdtempSync(join(tmpdir(), "ss-own-kit-host-work-"));
  const p = listProviders()[0];
  const model = p?.models[0];
  if (p === undefined || model === undefined) throw new Error("内建 provider catalog 是空的");
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [{ id: "prov_test", label: "test", provider: p.id, modelId: model.id, apiKey: "test-key-not-used", thinkingLevel: "off" }],
      activeProviderId: "prov_test", cwd: workRoot, personaName: "测试",
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
  rmSync(workRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type Call = (tool: string, args: Record<string, unknown>, role: string) => ToolResult;
/** 「模型」在收到任务正文时做什么(可以异步:要在回合进行中打 HTTP)。 */
type Act = (ctx: { readonly role: string; readonly text: string; readonly call: Call }) => string | Promise<string>;

interface FakeSession {
  readonly session: AgentSession;
  /** 第一次收到任务时记下它是谁的会话(角色名)。 */
  role: string | null;
  disposed: boolean;
}

interface Harness {
  readonly db: Database.Database;
  readonly prompts: Array<{ role: string | null; text: string }>;
  readonly sessions: FakeSession[];
  /** 每次 `createSession` 收到的工具 allowlist(断言 `mcp__` 模式在不在);与 `sessions` 同序同长。 */
  readonly allowlists: string[][];
  readonly drainNow: () => void;
  readonly baseUrl: string;
  readonly projectId: string;
}

const SKILL = "---\ndescription: 检索我自己的调研笔记\n---\n正文";
const RAG_JSON = JSON.stringify({ command: "python", args: ["server.py"] });
let seq = 0;

async function startHost(act: Act): Promise<Harness> {
  const prompts: Harness["prompts"] = [];
  const sessions: FakeSession[] = [];
  const allowlists: string[][] = [];
  seq = 0;
  let dbRef: Database.Database | undefined;
  let projectId = "";
  const call: Call = (tool, args, role) => {
    if (dbRef === undefined) throw new Error("库连接还没建好");
    // ⚠️ 任务正文里的是**角色名**,而工具上下文要的是**成员 id**(`cw`)。
    const agent = dbRef.prepare(`SELECT id FROM agents WHERE role = ?`).get(role) as { id: string } | undefined;
    if (agent === undefined) throw new Error(`库里没有角色 ${role}`);
    const ctx: ToolRunContext = {
      db: dbRef, agent: getAgent(dbRef, agent.id)!, project: loadProjectForAuthz(dbRef, projectId)!,
      now: Date.now, newId: (p) => `${p}_t${++seq}`,
      workspace: createGitWorkspace(), workspaceRoot: workRoot,
    };
    const r = dispatch(tool, args, ctx);
    if (r instanceof Promise) throw new Error("这些工具都是同步的");
    return r;
  };
  const makeSession = (): FakeSession => {
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    const emit = (ev: AgentSessionEvent): void => { for (const l of [...listeners]) l(ev); };
    const record: FakeSession = { session: undefined as unknown as AgentSession, role: null, disposed: false };
    record.session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      },
      async prompt(text: string) {
        const m = /你是:[^\n]*?\(`([a-z_]+)`\)/.exec(text);
        record.role = m?.[1] ?? "unknown";
        prompts.push({ role: record.role, text });
        const reply = await act({ role: record.role, text, call });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: reply } } as AgentSessionEvent);
        emit({ type: "agent_settled" } as AgentSessionEvent);
        return { messages: [] };
      },
      async abort() { emit({ type: "agent_settled" } as AgentSessionEvent); },
      dispose() { record.disposed = true; },
    } as unknown as AgentSession;
    sessions.push(record);
    return record;
  };
  const createSession: CreateSessionFn = async (opts) => {
    allowlists.push([...(opts.tools ?? [])]);
    return { session: makeSession().session };
  };
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
  const created = await fetch(`http://127.0.0.1:${addr.port}/api/projects`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "做工具的项目", client: "甲", goal: "把工具做出来" }),
  });
  expect(created.status, "建项目").toBe(201);
  projectId = ((await created.json()) as { project: { id: string } }).project.id;
  return {
    db, prompts, sessions, allowlists, projectId,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    drainNow: () => {
      void (host as unknown as { dispatchTimer: { runNow: (why: string) => Promise<unknown> } }).dispatchTimer.runNow("test");
    },
  };
}

let workSeq = 0;
/** 给工程师派一条活(已确认 —— 不走「计划确认」那道门)。 */
function assignWork(h: Harness, title = "做一个检索工具"): string {
  const id = `w_${++workSeq}`;
  insertWork(h.db, {
    id, projectId: h.projectId, parentWorkId: null, title, goal: "做出来", status: "open",
    confirmedAt: 1, assigneeAgentId: "cw", createdAt: Date.now(), updatedAt: Date.now(),
  });
  return id;
}

async function waitFor(h: Harness, label: string, pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待超时:${label}\n被叫醒的回合:${h.prompts.map((p) => `\n  · [${p.role}] ${p.text.slice(0, 120).replace(/\n/g, " ⏎ ")}`).join("")}`);
}

const workStatus = (h: Harness, id: string): string =>
  (h.db.prepare(`SELECT status FROM works WHERE id = ?`).get(id) as { status: string }).status;
const cwOwn = (h: Harness): string => join(workRoot, "roles", "coding_worker");
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const cwSessions = (h: Harness): FakeSession[] => h.sessions.filter((s) => s.role === "coding_worker");
const cwPrompts = (h: Harness): string[] => h.prompts.filter((p) => p.role === "coding_worker").map((p) => p.text);
/** 一条会话建出来时拿到的工具 allowlist(会话与 allowlist 同序)。 */
const allowlistOf = (h: Harness, s: FakeSession): string[] => h.allowlists[h.sessions.indexOf(s)] ?? [];
async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
const toggle = (h: Harness, role: string, name: string, body: unknown): Promise<Response> =>
  fetch(`${h.baseUrl}/api/harness/own/${role}/tools/${name}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

// ── ① 启动即建仓 + 一轮 ────────────────────────────────────────

describe("自己的仓库 · 宿主级:启动建仓、每轮注入、收尾提交", () => {
  it("三个执行角色的仓库启动即建出来(带 README);业务经理与项目经理没有", async () => {
    const h = await startHost(() => "好的");
    for (const role of ["research_worker", "coding_worker", "quality_reviewer"]) {
      const root = join(workRoot, "roles", role);
      expect(existsSync(join(root, ".git")), `${role} 的仓库`).toBe(true);
      expect(readFileSync(join(root, "README.md"), "utf8")).toContain("一个工具一个目录");
    }
    expect(existsSync(join(workRoot, "roles", "business_manager"))).toBe(false);
    expect(existsSync(join(workRoot, "roles", "project_manager"))).toBe(false);
  });

  it("① 工程师一轮:任务里有仓库的绝对路径;own_write 的文件进了他自己的仓库,提交作者是工程师;说明类工具不换会话", async () => {
    const workIds: string[] = [];
    let h: Harness | null = null;
    h = await startHost(({ role, text, call }) => {
      if (role === "coding_worker" && text.includes("# 工作项")) {
        call("own_write", { path: "tools/extract/SKILL.md", content: SKILL }, role);
        call("work_update", { workId: workIds[0], status: "done" }, role);
        return "做完了";
      }
      return "好的";
    });
    workIds.push(assignWork(h));
    h.drainNow();
    await waitFor(h, "工作项做完", () => workStatus(h, workIds[0] ?? "") === "done");

    const cwPrompt = cwPrompts(h)[0] ?? "";
    expect(cwPrompt).toContain("## 你自己的东西");
    expect(cwPrompt).toContain(cwOwn(h));
    expect(cwPrompt).toContain("你的经验库");
    expect(cwPrompt).toContain("还是空的");
    // 业务经理那一轮(如有)不带这一段
    for (const p of h.prompts.filter((p) => p.role === "business_manager")) {
      expect(p.text).not.toContain("你自己的东西");
    }

    const root = cwOwn(h);
    expect(git(root, "ls-files")).toContain("tools/extract/SKILL.md");
    expect(git(root, "log", "--format=%an", "-1")).toBe("工程师");
    expect(git(root, "log", "--format=%s", "-1")).toContain("回合结束");
    // 项目仓里没有这个文件(项目仓与自己的仓库是两个根)
    expect(existsSync(join(workRoot, "projects", h.projectId, "tools", "extract", "SKILL.md"))).toBe(false);
    // 说明类工具:会话不换
    await new Promise((r) => setTimeout(r, 80));
    expect(cwSessions(h)).toHaveLength(1);
    expect(cwSessions(h)[0]?.disposed).toBe(false);
    // 下一轮的任务里列出了这个工具
    expect(cwPrompt).not.toContain("`extract`");
    expect(readFileSync(join(root, "tools", "extract", "SKILL.md"), "utf8")).toBe(SKILL);
  });

  it("② 写了 MCP 服务 ⇒ 收尾换会话 ⇒ 下一条会话的工具面里有它", async () => {
    const workIds: string[] = [];
    let h: Harness | null = null;
    h = await startHost(({ role, text, call }) => {
      if (role === "coding_worker" && text.includes("# 工作项")) {
        if (workStatus(h as Harness, workIds[0] ?? "") !== "done") {
          call("own_write", { path: "tools/rag/SKILL.md", content: SKILL }, role);
          call("own_write", { path: "tools/rag/mcp.json", content: RAG_JSON }, role);
          call("work_update", { workId: workIds[0], status: "done" }, role);
        } else {
          call("work_update", { workId: workIds[1], status: "done" }, role);
        }
        return "做完了";
      }
      return "好的";
    });
    workIds.push(assignWork(h, "写一个 MCP 工具"), assignWork(h, "第二条活"));
    h.drainNow();
    await waitFor(h, "第一条会话因新提交被换掉", () => cwSessions(h).length >= 2 && cwSessions(h)[0]?.disposed === true);
    await waitFor(h, "第二条活做完", () => workStatus(h, workIds[1] ?? "") === "done");
    // 第一条会话:工具面里没有自己的 MCP(那时还没写)
    expect(allowlistOf(h, cwSessions(h)[0] as FakeSession).some((t) => t.startsWith("mcp__own_"))).toBe(false);
    // 第二条会话:有
    expect(allowlistOf(h, cwSessions(h)[1] as FakeSession)).toContain("mcp__own_coding_worker_rag__*");
    const later = cwPrompts(h)[1] ?? "";
    expect(later).toMatch(/`rag`\(MCP 服务\)/);
    expect(later).toContain("mcp__own_coding_worker_rag__*");
    expect(git(cwOwn(h), "ls-files")).toContain("tools/rag/mcp.json");
  });
});

// ── ③ 停用端点 ────────────────────────────────────────────────

describe("自己的工具 · 停用端点与换会话", () => {
  it("③ 停用 ⇒ 换会话;下一轮工具面里没有它、任务里写着「甲方停用了」;恢复后回来", async () => {
    // 一次只派一条活:排空器一趟会把所有能做的活都做掉,几条一起派就分不出「停用前 / 后」。
    const workIds: string[] = [];
    let h: Harness | null = null;
    h = await startHost(({ role, text, call }) => {
      if (role !== "coding_worker" || !text.includes("# 工作项")) return "好的";
      if (workIds.length === 1) {
        call("own_write", { path: "tools/rag/SKILL.md", content: SKILL }, role);
        call("own_write", { path: "tools/rag/mcp.json", content: RAG_JSON }, role);
      }
      const open = workIds.find((id) => workStatus(h as Harness, id) !== "done");
      if (open !== undefined) call("work_update", { workId: open, status: "done" }, role);
      return "做完了";
    });
    // 第 1 轮:写出 MCP 服务 ⇒ 收尾换会话
    workIds.push(assignWork(h, "写出 MCP 服务"));
    h.drainNow();
    await waitFor(h, "第 1 轮跑完、会话因新提交被换掉", () => workStatus(h, workIds[0] ?? "") === "done" && cwSessions(h)[0]?.disposed === true);
    expect(cwSessions(h)).toHaveLength(1);

    // 404 / 400 三种
    expect((await toggle(h, "business_manager", "rag", { disabled: true })).status).toBe(404);
    expect((await toggle(h, "coding_worker", "nope", { disabled: true })).status).toBe(404);
    expect((await toggle(h, "coding_worker", "rag", {})).status).toBe(400);

    const off = await toggle(h, "coding_worker", "rag", { disabled: true });
    expect(off.status).toBe(200);
    const offBody = await json<{ tool: { state: string; disabledAt: number | null }; changed: boolean }>(off);
    expect(offBody.tool.state).toBe("disabled");
    expect(offBody.changed).toBe(true);
    // 幂等:再停一次不算改动,也**不换会话**(没改动却丢会话 = 把一个空操作说成了生效)
    const disposedBefore = cwSessions(h).filter((x) => x.disposed).length;
    const again = await toggle(h, "coding_worker", "rag", { disabled: true });
    expect((await json<{ changed: boolean }>(again)).changed).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(cwSessions(h).filter((x) => x.disposed).length).toBe(disposedBefore);

    // 第 2 轮:新会话的工具面里没有它,任务里写着停用
    workIds.push(assignWork(h, "停用之后的一轮"));
    h.drainNow();
    await waitFor(h, "第 2 轮跑完", () => workStatus(h, workIds[1] ?? "") === "done");
    await waitFor(h, "停用后的新会话建出来", () => cwSessions(h).length >= 2);
    const second = cwSessions(h)[1] as FakeSession;
    expect(allowlistOf(h, second).some((t) => t.startsWith("mcp__own_"))).toBe(false);
    expect(cwPrompts(h)[1] ?? "").toMatch(/`rag`\(MCP 服务\):甲方停用了/);

    // 恢复 ⇒ 在池里的那条会话被丢掉;下一轮工具面里又有它
    const on = await toggle(h, "coding_worker", "rag", { disabled: false });
    const onBody = await json<{ tool: { state: string; disabledAt: number | null }; changed: boolean }>(on);
    expect(onBody.tool.state).toBe("usable");
    expect(onBody.tool.disabledAt).toBeNull();
    expect(onBody.changed).toBe(true);
    await waitFor(h, "恢复后池里的会话被丢掉", () => second.disposed);
    workIds.push(assignWork(h, "恢复之后的一轮"));
    h.drainNow();
    await waitFor(h, "第 3 轮跑完", () => workStatus(h, workIds[2] ?? "") === "done");
    await waitFor(h, "恢复后的新会话", () => cwSessions(h).length >= 3);
    expect(allowlistOf(h, cwSessions(h)[2] as FakeSession)).toContain("mcp__own_coding_worker_rag__*");
    expect(cwPrompts(h)[2] ?? "").not.toContain("甲方停用了");
  }, 30_000);

  it("③ 他正在跑的时候停用:这一轮不打断,收尾之后才换", async () => {
    const workIds: string[] = [];
    let h: Harness | null = null;
    let disposedDuringTurn: boolean | null = null;
    h = await startHost(async ({ role, text, call }) => {
      if (role !== "coding_worker" || !text.includes("# 工作项")) return "好的";
      call("own_write", { path: "tools/rag/SKILL.md", content: SKILL }, role);
      call("own_write", { path: "tools/rag/mcp.json", content: RAG_JSON }, role);
      // 回合进行中踩刹车
      const res = await toggle(h as Harness, "coding_worker", "rag", { disabled: true });
      expect(res.status).toBe(200);
      disposedDuringTurn = cwSessions(h as Harness)[0]?.disposed ?? null;
      call("work_update", { workId: workIds[0], status: "done" }, role);
      return "做完了";
    });
    workIds.push(assignWork(h));
    h.drainNow();
    await waitFor(h, "这一轮跑完", () => workStatus(h, workIds[0] ?? "") === "done");
    // 回合进行中:没有被丢
    expect(disposedDuringTurn).toBe(false);
    // 收尾之后:被丢了
    await waitFor(h, "收尾后会话被丢掉", () => cwSessions(h)[0]?.disposed === true);
  });
});

// ── ④ 读面 ───────────────────────────────────────────────────

describe("自己的东西 · 读面", () => {
  it("④ GET /api/harness:三个执行角色带 own,业务经理与项目经理不带;经验条目列得出、搜得到、删得掉、别人删不了", async () => {
    let saved = false;
    let noteId = "";
    let h: Harness | null = null;
    h = await startHost(({ role, text, call }) => {
      if (role === "coding_worker" && text.includes("# 工作项") && !saved) {
        saved = true;
        call("own_write", { path: "tools/rag/SKILL.md", content: SKILL }, role);
        const r = call("experience_save", { kind: "research", title: "某站要 referer", content: "不带 referer 打不开", source: "https://example.com/a" }, role);
        if (r.ok) noteId = /an_\w+/.exec(r.text)?.[0] ?? "";
        return "记下了";
      }
      return "好的";
    });
    assignWork(h);
    h.drainNow();
    await waitFor(h, "记下经验", () => noteId !== "");

    type RoleView = { role: string; own?: { repoDir: string; repoState: string; tools: Array<{ name: string; kind: string; state: string }>; notes: { lesson: number; research: number } | null } };
    const harness = await json<{ roles: RoleView[] }>(await fetch(`${h.baseUrl}/api/harness`));
    const byRole = new Map(harness.roles.map((r) => [r.role, r]));
    expect(byRole.get("business_manager")?.own).toBeUndefined();
    expect(byRole.get("project_manager")?.own).toBeUndefined();
    const cw = byRole.get("coding_worker")?.own;
    expect(cw?.repoState).toBe("ready");
    expect(cw?.repoDir).toBe(cwOwn(h));
    expect(cw?.tools).toEqual([expect.objectContaining({ name: "rag", kind: "skill", state: "usable", problem: null, disabledAt: null })]);
    expect(cw?.notes).toEqual({ lesson: 0, research: 1 });
    expect(byRole.get("quality_reviewer")?.own).toMatchObject({ repoState: "ready", tools: [] });

    const list = await json<{ notes: Array<{ id: string; kind: string; source: string | null }>; counts: { lesson: number; research: number } }>(
      await fetch(`${h.baseUrl}/api/harness/own/coding_worker/notes`),
    );
    expect(list.counts).toEqual({ lesson: 0, research: 1 });
    expect(list.notes[0]).toMatchObject({ id: noteId, kind: "research", source: "https://example.com/a" });
    const hit = await json<{ notes: Array<{ id: string }> }>(await fetch(`${h.baseUrl}/api/harness/own/coding_worker/notes?q=referer`));
    expect(hit.notes.map((n) => n.id)).toEqual([noteId]);
    expect((await fetch(`${h.baseUrl}/api/harness/own/coding_worker/notes?q=a`)).status).toBe(400);
    expect((await fetch(`${h.baseUrl}/api/harness/own/business_manager/notes`)).status).toBe(404);
    // 别人的条目删不了(与不存在同一种回答)
    expect((await fetch(`${h.baseUrl}/api/harness/own/research_worker/notes/${noteId}`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${h.baseUrl}/api/harness/own/coding_worker/notes/${noteId}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${h.baseUrl}/api/harness/own/coding_worker/notes/${noteId}`, { method: "DELETE" })).status).toBe(404);
  });
});
