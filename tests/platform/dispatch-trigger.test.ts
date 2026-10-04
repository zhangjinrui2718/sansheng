/**
 * 排空器的**触发边界**(真机 E2E 抓到的一个洞的守卫)
 *
 * ── 洞里是什么 ──────────────────────────────────────────────────
 *
 * 门铃挂在工具调用上(`dispatch()` → `ctx.nudge()`),而门铃一响 `drainAll` 会扫
 * **全部活跃项目**。接待会话里 `project_open` 刚把项目建出来的那一刻,新项目
 * 就已经是 active —— 于是门铃在用户**还没看过项目目标**之前就叫醒了项目经理
 * 去拆解。这正是批次 20 明确定为不该发生的事(在用户确认之前花他的 token)。
 *
 * 真机第一次跑 A 就是这个形态:立项那一步的日志里紧跟着
 * `dispatcher: 第 1/8 回合 → pm`,而用户的「开工」还没说出口。
 *
 * 守它的方式:**接待会话的会话不装门铃**(`host/serve.ts` 的 `getOrCreateSession`)。
 * 这个测试走的是真链路:真 WS 指令 → 真建会话(注入假 SDK)→ 真的 `project_open`
 * 工具调用 → 真门铃 → 真排空。断言的是「**没有人**被叫起来」与「项目内那句话
 * 之后**有人**被叫起来」这一对对照。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders } from "../../src/platform/infra/providers.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";

let dataDir: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-dispatch-trigger-"));
  const p = listProviders()[0];
  const model = p?.models[0];
  if (p === undefined || model === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 测试夹具无法造出「已配置 provider」的现场");
  }
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [
        {
          id: "prov_test", label: "test", provider: p.id, modelId: model.id,
          apiKey: "test-key-not-used", thinkingLevel: "off",
        },
      ],
      activeProviderId: "prov_test",
      cwd: dataDir,
      personaName: "测试",
    }),
    { mode: 0o600 },
  );
});

afterEach(async () => {
  ws?.close();
  ws = undefined;
  host?.close();
  host = undefined;
  wss?.close();
  wss = undefined;
  await new Promise<void>((r) => (server !== undefined ? server.close(() => r()) : r()));
  server = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 轮询直到条件成立(或超时)。真机链路是异步的,这里不能靠固定 sleep。 */
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

/**
 * 假会话:接待会话那一轮真的调一次 `project_open`(走平台工具 → 门铃)。
 * 项目内的回合什么都不做(空转),这样「有没有人被叫起来」只能由排空器自己决定。
 */
function makeCreateSession(db: () => import("better-sqlite3").Database): CreateSessionFn {
  return async (opts) => {
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    const emit = (ev: AgentSessionEvent): void => {
      for (const l of [...listeners]) l(ev);
    };
    const customs = opts.customTools ?? [];
    const session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      async prompt(payload?: unknown) {
        const projects = (db().prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n;
        const open = customs.find((t) => t.name === "project_open");
        if (projects === 0 && open !== undefined) {
          emit({
            type: "tool_execution_start", toolCallId: "tc_open", toolName: "project_open", args: {},
          } as unknown as AgentSessionEvent);
          const result = await open.execute("tc_open", {
            name: "语音机器人调研", client: "甲方", goal: "给出三条技术路线的对比与选型建议",
          });
          emit({
            type: "tool_execution_end", toolCallId: "tc_open", toolName: "project_open",
            result, isError: false,
          } as unknown as AgentSessionEvent);
          emit({ type: "agent_settled" } as AgentSessionEvent);
          return;
        }
        /**
         * 项目内的回合:调一次 `report`(capability `work.report`,在门铃清单里)。
         *
         * 真机上这个动作来自 worker 的 `work.update` —— 而这里要的是**同一个机制**:
         * 排空自己跑出来的工具门铃会把「重跑一次」置真。没有它,「重跑绕过硬上界」
         * 那个洞在测试里根本不会显形(第一版就是这么写的,而那版测试没有牙:
         * 把修复回滚掉它照样全绿)。
         */
        const text = typeof payload === "string" ? payload : "";
        const workId = text.match(/工作项\s+(\S+)/)?.[1];
        const report = customs.find((t) => t.name === "report");
        if (workId !== undefined && report !== undefined) {
          await report.execute("tc_report", { workId, summary: "进行中" });
        }
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      async abort() {
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      dispose() { /* 无需清理 */ },
    } as unknown as AgentSession;
    return { session };
  };
}

async function startHost(opts: { maxCascadeRounds?: number } = {}): Promise<{
  send: (cmd: unknown) => void;
  db: () => import("better-sqlite3").Database;
}> {
  let dbRef: import("better-sqlite3").Database | undefined;
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    // 定时器挪到一小时之后 —— 这条测试要的是**门铃**,不是定时器兜底
    dispatchIntervalMs: 3_600_000,
    ...(opts.maxCascadeRounds !== undefined ? { maxCascadeRounds: opts.maxCascadeRounds } : {}),
    createSession: makeCreateSession(() => {
      if (dbRef === undefined) throw new Error("宿主还没起来");
      return dbRef;
    }),
  });
  dbRef = host.booted.deps.db;

  server = createServer();
  wss = attachHub(server, host.hub);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");

  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws!.once("open", () => resolve());
    ws!.once("error", reject);
  });
  return {
    send: (cmd) => ws!.send(JSON.stringify(cmd)),
    db: () => dbRef!,
  };
}

describe("触发边界 · 接待会话的立项**不叫**组织起来", () => {
  it("立项之后没有任何人被唤醒(没有工作项、没有尝试账本、没有常驻会话)", async () => {
    const h = await startHost();
    const db = h.db();

    h.send({ type: "send", projectId: null, content: "我想做一个语音机器人的调研,直接立项吧" });

    // 立项真的发生了(否则下面「没人被叫醒」是一句空话)
    expect(await until(() => (db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n === 1)).toBe(true);
    // 再等一会儿,给「门铃 → 排空」这条 fire-and-forget 的路留出犯错的时间
    await sleep(400);

    const works = (db.prepare(`SELECT COUNT(*) AS n FROM works`).get() as { n: number }).n;
    const attempts = (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_attempts`).get() as { n: number }).n;
    expect(works, "立项之后不该有人开始拆解工作项").toBe(0);
    expect(attempts, "立项之后不该有排空尝试(门铃在接待会话里不该响)").toBe(0);
    expect(host?.sessionCount(), "接待会话已被丢弃,新项目里也不该有人被叫醒").toBe(0);
  });

  it("对照组:用户在新项目里说一句话之后,门铃把组织叫起来", async () => {
    const h = await startHost();
    const db = h.db();

    h.send({ type: "send", projectId: null, content: "我想做一个语音机器人的调研,直接立项吧" });
    expect(await until(() => (db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n === 1)).toBe(true);
    await sleep(400);
    const projectId = (db.prepare(`SELECT id FROM projects LIMIT 1`).get() as { id: string }).id;

    // 用户切进新项目,说了第一句话
    h.send({ type: "send", projectId, content: "开工" });
    expect(
      await until(
        () => (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_attempts WHERE project_id = ?`).get(projectId) as { n: number }).n > 0,
      ),
      "项目内的那句话之后,排空器应该已经叫醒过项目经理",
    ).toBe(true);
    expect(host?.sessionCount(), "bm 的项目会话 + pm 的会话").toBeGreaterThanOrEqual(2);
  });
});

describe("硬上界不会被门铃的重跑绕过(真机跑出来的洞)", () => {
  it("maxCascadeRounds=1:只跑 1 个回合就停,不「重跑一趟再跑 1 个」", async () => {
    const h = await startHost({ maxCascadeRounds: 1 });
    const db = h.db();

    // 直接造「一个项目 + 两条派给 worker 的工作项」——不经过立项,免得混进别的变量
    insertAgent(db, { id: "wk1", role: "worker", specialization: "engineering", displayName: "工", createdAt: 1 });
    insertAgent(db, { id: "pm1", role: "project_manager", specialization: null, displayName: "经", createdAt: 1 });
    insertAgent(db, { id: "bm1", role: "business_manager", specialization: null, displayName: "业", createdAt: 1 });
    insertProject(db, { id: "pj_x", name: "x", client: "甲", goal: "g", status: "active", createdAt: 1 });
    for (const id of ["wk1", "pm1", "bm1"]) addMember(db, "pj_x", id, 1);
    for (const id of ["w1", "w2"]) {
      insertWork(db, {
        id, projectId: "pj_x", parentWorkId: null, title: id, goal: "g", status: "open",
        assigneeAgentId: "wk1", createdAt: 1, updatedAt: 1,
      });
    }

    // 门铃(用户在这个项目里说一句话 → 回合结束后的 nudge)
    h.send({ type: "send", projectId: "pj_x", content: "开工" });

    // 排空自己跑出来的工具门铃会把「重跑」置真 —— 那正是这个洞。等它充分暴露:
    expect(
      await until(
        () => (db.prepare(`SELECT COUNT(*) AS n FROM dispatch_attempts`).get() as { n: number }).n > 0,
      ),
    ).toBe(true);
    await sleep(600);

    const total = (db.prepare(`SELECT COALESCE(SUM(attempts),0) AS n FROM dispatch_attempts`).get() as { n: number }).n;
    expect(total, "maxRounds=1 → 整次排空只该有 1 个回合,重跑不许绕过它").toBe(1);
    // 第二条工作项根本没被碰过(没有被叫醒的痕迹)
    const w2 = db.prepare(`SELECT status FROM works WHERE id='w2'`).get() as { status: string };
    expect(w2.status).toBe("open");
  });
});

// ── A1 · 「建轮那一刻说清是谁」在真链路上的兑现(设计 1 §2.10.2)────────
//
// A1 把 `agentId` 加成了**必填**字段。必填只在类型上约束构造点,而构造点按
// **驱动路径**分岔:接待会话的 bm、项目内用户消息那条 bm、排空器叫起来的
// pm / qa(`drainProject` 的回调)、worker 执行那条(`runWorkInSession`)。
// 各自构造事件的单测证明不了「宿主在每条路上都传对了」—— 必须把**线上收到的
// json** 收下来看,而且要用**不是 `bm` 的 id** 去验:硬编码 `"bm"` 的实现在
// 默认组织(`runtime/org.ts` 的 id 恰好就是 bm/pm/wk/qa)下**看起来是对的**。

interface StartsSeen {
  starts: Array<{ role: string | null; agentId: string | null }>;
  toolStarts: Array<{ name: string; agentId: string | null }>;
}

/** 把这条 WS 连接上收到的 message_start / tool_start 收下来(NULL 原样保留) */
function collectStarts(): StartsSeen {
  const seen: StartsSeen = { starts: [], toolStarts: [] };
  ws!.on("message", (raw: unknown) => {
    const ev = JSON.parse(String(raw)) as Record<string, unknown>;
    if (ev.type === "message_start") {
      seen.starts.push({
        role: typeof ev.role === "string" ? ev.role : null,
        agentId: typeof ev.agentId === "string" ? ev.agentId : null,
      });
    }
    if (ev.type === "tool_start") {
      const tool = ev.tool as { name?: unknown } | undefined;
      seen.toolStarts.push({
        name: typeof tool?.name === "string" ? tool.name : "",
        agentId: typeof ev.agentId === "string" ? ev.agentId : null,
      });
    }
  });
  return seen;
}

describe("A1 · 说话者身份在每条驱动路径上都传对(不硬编码 bm)", () => {
  it("接待会话 → 项目内 bm → 排空器:每个建轮事件的 agentId 都是库里那个 agent", async () => {
    const h = await startHost();
    const db = h.db();
    const seen = collectStarts();

    // ① 接待会话:用户那句 → 业务经理立项(含它的 tool_start)
    h.send({ type: "send", projectId: null, content: "我想做一个语音机器人的调研,直接立项吧" });
    expect(
      await until(() => (db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number }).n === 1),
    ).toBe(true);
    expect(await until(() => seen.starts.some((s) => s.role === "assistant"))).toBe(true);

    const bmId = (db.prepare(`SELECT id FROM agents WHERE role = 'business_manager'`).get() as { id: string }).id;
    // 用户那条的 `null` 是**甲方**(与 session_messages.agent_id 同义),不是「没填」
    expect(seen.starts.find((s) => s.role === "user")?.agentId).toBeNull();
    expect(seen.starts.filter((s) => s.role === "assistant").map((s) => s.agentId)).toEqual([bmId]);
    // bridge 那条路:tool_start 也带作者(project_open 由业务经理调)
    expect(seen.toolStarts.find((t) => t.name === "project_open")?.agentId).toBe(bmId);

    // ② 项目内说一句 → 回合结束敲铃 → 排空器叫起**别的角色**(pm / worker)
    const projectId = (db.prepare(`SELECT id FROM projects LIMIT 1`).get() as { id: string }).id;
    h.send({ type: "send", projectId, content: "开工" });

    expect(
      await until(() => seen.starts.some((s) => s.role === "assistant" && s.agentId !== bmId)),
      "排空器叫起来的那个 agent 必须出现在建轮事件里(硬编码 bm 的实现在这里露馅)",
    ).toBe(true);

    // ③ 全部助手轮的作者:必须是 agents 表里真实存在的 id,且不许是 null
    const agentIds = new Set(
      (db.prepare(`SELECT id FROM agents`).all() as Array<{ id: string }>).map((r) => r.id),
    );
    const authors = seen.starts.filter((s) => s.role === "assistant").map((s) => s.agentId);
    expect(authors).not.toContain(null);
    expect(agentIds.size).toBeGreaterThanOrEqual(4);
    for (const a of authors) expect(agentIds.has(a!)).toBe(true);
  });

  it("自定义 worker id:执行那条路(`runWorkInSession`)的作者是分派给它的 worker", async () => {
    const h = await startHost();
    const db = h.db();
    // 默认组织的 id 恰是 bm/pm/wk(`runtime/org.ts`)—— 那会让「硬编码 bm」与
    // 「真传参」长得一模一样。这里把 **worker** 换成 wk1:把执行那条路的作者
    // 写死成任何默认 id 都会当场失败。
    //
    // ⚠️ 业务经理这一条**只能**用 ORG 的 id:用户消息那条路由 `handleUserMessage`
    // 按 `ORG` 常量选人(`serve.ts`),不按项目成员选 —— 这是本次复核发现的另一处
    // 「id 来自代码常量」,不在 A1 的改动范围内(见报告)。
    insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业", createdAt: 1 });
    insertAgent(db, { id: "pm1", role: "project_manager", specialization: null, displayName: "经", createdAt: 1 });
    insertAgent(db, { id: "wk1", role: "worker", specialization: "engineering", displayName: "工", createdAt: 1 });
    insertProject(db, { id: "pj_a", name: "a", client: "甲", goal: "g", status: "active", createdAt: 1 });
    for (const id of ["bm", "pm1", "wk1"]) addMember(db, "pj_a", id, 1);
    insertWork(db, {
      id: "w1", projectId: "pj_a", parentWorkId: null, title: "w1", goal: "g", status: "open",
      assigneeAgentId: "wk1", createdAt: 1, updatedAt: 1,
    });

    const seen = collectStarts();
    h.send({ type: "send", projectId: "pj_a", content: "开工" });

    expect(await until(() => seen.starts.some((s) => s.role === "assistant"))).toBe(true);
    // 这条工作项派给了 wk1、前置为空 ⇒ 排空器会走 `runWorkInSession`(worker 那条)
    expect(
      await until(() => seen.starts.some((s) => s.agentId === "wk1")),
      "worker 执行路的建轮事件必须写 worker 自己的 id(不是 bm,也不是任何默认 id)",
    ).toBe(true);
    // 用户那条仍然是甲方;业务经理那条是它自己的 id
    expect(seen.starts.find((s) => s.role === "user")?.agentId).toBeNull();
    expect(seen.starts.some((s) => s.role === "assistant" && s.agentId === "bm")).toBe(true);
  });
});
