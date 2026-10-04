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
