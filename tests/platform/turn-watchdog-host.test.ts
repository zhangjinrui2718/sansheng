/**
 * 看门狗在**宿主**里的接线(2026-11-25)· 回归
 *
 * ── 为什么需要这一份 ────────────────────────────────────────────
 *
 * `turn.test.ts` / `execution.test.ts` 钉的是 `runTurn` / `runWorkItem` 自己的判据 ——
 * 它们直接把选项传进去。而「宿主有没有把 `turnIdleMs` 真的交到那两条调用链上」
 * 是另一件事:`turnWallClockMs` 当年就是判定与打断都做完了、宿主却没接线,
 * 于是「调了上界」与「它根本没生效」在真机上长得一样。只接一条路径等于没接。
 *
 * 所以这里走**真宿主 + 真 WS**,只把 SDK 会话换成假的:
 *   ① 工作路径:无进展到点 ⇒ 工作项记 failed + 写出 work_failed;
 *   ② 聊天路径:无进展到点 ⇒ 广播 `turn_timeout`;
 *   ③ 单工具窗口**同时**到了会话工厂(内置 bash 的默认超时用的就是它);
 *   ④ 负样本:不给看门狗选项的宿主,一个正常回合什么都不会发生。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  createPlatformHost, type PlatformHost, type ServeOptions,
} from "../../src/platform/host/serve.js";
import { attachHub } from "../../src/platform/transport/hub.js";
import { listProviders, providerEnvKey } from "../../src/platform/runtime/agentRuntime/pi/providers.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertWork, getWork } from "../../src/platform/storage/repo/works.js";
import { listPendingDispatchEvents } from "../../src/platform/storage/repo/dispatch.js";
import type { CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立(真机链路是异步的,固定 sleep 会假绿也会假红)。 */
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

const ROLE_RE = /你是:.*?\(`([a-z_]+)`\)/;

// ⚠️ 下面三个构造器发的是 **pi 方言**:宿主建出来的会话外面裹着适配器
// (`agentRuntime/pi/events.ts`),它只翻译 pi 方言;平台方言的事件会被它当
// 「不认识」丢掉 —— 发错了方言,看门狗永远看不到那个工具(第一版就栽在这里)。
const text = (delta: string): AgentSessionEvent =>
  ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } }) as AgentSessionEvent;
const toolStart = (id: string, name: string, args: unknown): AgentSessionEvent =>
  ({ type: "tool_execution_start", toolCallId: id, toolName: name, args }) as AgentSessionEvent;
const toolEnd = (id: string, name: string): AgentSessionEvent =>
  ({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [] }, isError: false }) as AgentSessionEvent;

/**
 * 假会话的行为(`h.mode`):
 *   - `hang`      :`prompt()` 一直挂着、**一个事件都不发**(无进展的形状),只有 `abort()` 能放它走;
 *   - `quiet`     :正常收尾(发一句正文)—— 负样本用;
 *   - `tool`      :开始一次工具调用之后一直挂着一动不动(单个工具卡死的形状);
 *   - `twoTools`  :做完一次工具调用、又开始第二次之后挂着不动(「用满上限之后还要再来」的形状,上限 1)。
 */
type FakeMode = "hang" | "quiet" | "tool" | "toolDone" | "twoTools";

function makeCreateSession(h: {
  abortedRoles: string[];
  sessionOpts: Parameters<CreateSessionFn>[0] | null;
  mode: FakeMode;
}): CreateSessionFn {
  return async (opts) => {
    h.sessionOpts = opts;
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    let lastRole: string | null = null;
    let release: (() => void) | null = null;
    let aborted = false;
    const session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.add(fn);
        return () => { listeners.delete(fn); };
      },
      async prompt(payload?: unknown) {
        const text = typeof payload === "string" ? payload : "";
        lastRole = text.match(ROLE_RE)?.[1] ?? null;
        const emit = (ev: AgentSessionEvent): void => { for (const l of [...listeners]) l(ev); };
        const mode = h.mode;
        if (mode === "quiet") {
          emit(text("做完了。"));
          emit({ type: "agent_settled" } as AgentSessionEvent);
          return { messages: [] };
        }
        if (mode === "toolDone") {
          // 一次安静但按时做完的工具调用(约 50ms)—— 合法的形状,不该被任何一道闸碰到。
          emit(toolStart("t1", "bash", { command: "npm test" }));
          await new Promise<void>((r) => setTimeout(r, 50));
          emit(toolEnd("t1", "bash"));
          emit(text("测完了。"));
          emit({ type: "agent_settled" } as AgentSessionEvent);
          return { messages: [] };
        }
        if (mode === "tool") {
          emit(toolStart("t1", "bash", { command: "npm install" }));
        } else if (mode === "twoTools") {
          emit(toolStart("t1", "board_list", {}));
          emit(toolEnd("t1", "board_list"));
          // 上限(1)已用满;第 2 次开始就是「到顶」的那一刻,然后卡住不动。
          emit(toolStart("t2", "board_read", { id: "a1" }));
        }
        // ⚠️ abort 可能先于这次挂起到达(工具次数在剧本开头就到顶)—— 那一刻
        // `release` 还不存在。所以挂起之前先看「是不是已经被中止」,挂起之后再补看一次。
        if (aborted) return { messages: [] };
        await new Promise<void>((res) => {
          release = res;
          if (aborted) res();
        });
        return { messages: [] };
      },
      async abort() {
        aborted = true;
        h.abortedRoles.push(lastRole ?? "(没跑过的会话)");
        release?.();
      },
      dispose() {},
    };
    return { session: session as unknown as AgentSession };
  };
}

let dataDir: string;
let root: string;
let host: PlatformHost | undefined;
let server: Server | undefined;
let wss: WebSocketServer | undefined;
let ws: WebSocket | undefined;
const h = {
  abortedRoles: [] as string[],
  sessionOpts: null as Parameters<CreateSessionFn>[0] | null,
  mode: "hang" as FakeMode,
};
let events: Array<Record<string, unknown>>;

/** 写一份 settings:一个有 env 凭据通道的 provider(没有映射的 provider 建不出会话)。 */
function writeSettings(): void {
  const ps = listProviders().filter((p) => p.models.length > 0 && providerEnvKey(p.id) !== undefined);
  const a = ps[0];
  if (a === undefined || a.models[0] === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 夹具造不出「已配置 provider」的现场");
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [{
        id: "prov_a", label: "A", provider: a.id, modelId: a.models[0].id,
        apiKey: "key-a-not-used", thinkingLevel: "off",
      }],
      activeProviderId: "prov_a", cwd: root, personaName: "测试",
    }),
    { mode: 0o600 },
  );
}

async function startHost(over: Partial<ServeOptions> = {}): Promise<void> {
  writeSettings();
  h.abortedRoles = [];
  h.sessionOpts = null;
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    cwd: root,
    // 定时器挪到一小时之后:这里要的是**显式触发**,不是兜底 tick。
    dispatchIntervalMs: 3_600_000,
    maxCascadeRounds: 1,
    createSession: makeCreateSession(h),
    ...over,
  });
  server = createServer();
  wss = attachHub(server, host.hub);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("拿不到监听端口");
  ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  ws.on("message", (raw: unknown) => {
    try {
      events.push(JSON.parse(String(raw)) as Record<string, unknown>);
    } catch {
      /* 非 JSON 不入账 */
    }
  });
  await new Promise<void>((res, rej) => {
    ws!.once("open", () => res());
    ws!.once("error", rej);
  });
}

function seedProject(workId: string | null): void {
  const db = host!.booted.deps.db;
  ensureOrg(db, 1);
  insertProject(db, {
    id: "p1", name: "p1", client: "甲方", goal: "g", status: "active", createdAt: 1,
  });
  ensureProjectOrg(db, "p1", 1);
  if (workId !== null) {
    insertWork(db, {
      confirmedAt: 1, id: workId, projectId: "p1", parentWorkId: null, title: workId, goal: "g",
      status: "open", assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
    });
  }
}

const errorEvents = (code: string): Array<Record<string, unknown>> =>
  events.filter((e) => (e.error as { code?: string } | undefined)?.code === code);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-watchdog-"));
  root = join(dataDir, "ws");
  h.mode = "hang";
  events = [];
});

afterEach(async () => {
  await sleep(10);
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

describe("宿主 · 看门狗接进了两条执行路径", () => {
  it("① 工作路径:无进展到点 ⇒ 执行者那条会话被 abort,工作项记 failed 并写出 work_failed", async () => {
    await startHost({ turnIdleMs: 40 });
    seedProject("w1");
    const db = host!.booted.deps.db;
    await host!.dispatchTimer.runNow();
    expect(await until(() => getWork(db, "w1")?.status === "failed"), "看门狗到点后工作项必须记 failed").toBe(true);
    expect(h.abortedRoles, "被打断的是执行者那条会话").toContain("research_worker");
    expect(listPendingDispatchEvents(db, "p1").map((e) => e.kind)).toContain("work_failed");
  });

  it("① 工作路径:单个工具卡死到点 ⇒ 同样记 failed(`turnToolMs` 这一道闸也接在这条路上)", async () => {
    h.mode = "tool";
    await startHost({ turnToolMs: 40, turnIdleMs: 60_000 });
    seedProject("w1");
    const db = host!.booted.deps.db;
    await host!.dispatchTimer.runNow();
    expect(await until(() => getWork(db, "w1")?.status === "failed"), "单个工具到点后工作项必须记 failed").toBe(true);
    expect(h.abortedRoles).toContain("research_worker");
  });

  it("① 工作路径:工具次数到顶 ⇒ 同样记 failed(`turnMaxToolCalls` 这一道闸也接在这条路上)", async () => {
    h.mode = "twoTools";
    await startHost({ turnMaxToolCalls: 1 });
    seedProject("w1");
    const db = host!.booted.deps.db;
    await host!.dispatchTimer.runNow();
    expect(await until(() => getWork(db, "w1")?.status === "failed"), "工具次数到顶后工作项必须记 failed").toBe(true);
    expect(h.abortedRoles).toContain("research_worker");
  });

  it("② 聊天路径:无进展到点 ⇒ 业务经理那条会话被 abort,并广播 turn_timeout", async () => {
    await startHost({ turnIdleMs: 40 });
    seedProject(null);
    ws!.send(JSON.stringify({ type: "send", projectId: "p1", content: "在吗" }));
    expect(await until(() => errorEvents("turn_timeout").length > 0), "甲方必须被告知这一轮超时收尾").toBe(true);
    expect(h.abortedRoles).toContain("business_manager");
  });

  it("③ 单工具窗口**同时**到了会话工厂(内置 bash 的默认超时与看门狗第二道闸同一个数)", async () => {
    // 回合正常收尾(这条只看「建会话时收到了什么」)—— 否则无进展窗口是缺省的 10 分钟,回合永远不结束。
    h.mode = "quiet";
    await startHost({ turnToolMs: 90_000 });
    seedProject("w1");
    await host!.dispatchTimer.runNow();
    await until(() => h.sessionOpts !== null);
    expect(h.sessionOpts?.toolTimeoutMs, "宿主必须把窗口交给会话工厂").toBe(90_000);
  });

  it("④ 负样本:不给看门狗选项(用缺省的 10 分钟)⇒ 一个正常回合什么都不发生", async () => {
    h.mode = "quiet";
    await startHost();
    seedProject("w1");
    const db = host!.booted.deps.db;
    await host!.dispatchTimer.runNow();
    expect(h.abortedRoles, "正常回合不许被缺省看门狗碰到").toEqual([]);
    expect(getWork(db, "w1")?.status, "没到点 ⇒ 不是 failed(留在 in_progress,由模型自己收尾)").not.toBe("failed");
    expect(listPendingDispatchEvents(db, "p1")).toEqual([]);
  });

  it("④ 负样本:窗口之内做完的工具调用不触发看门狗", async () => {
    // 窗口 400ms;工具 50ms 就做完、然后正常收尾。
    h.mode = "toolDone";
    await startHost({ turnToolMs: 400 });
    seedProject("w1");
    const db = host!.booted.deps.db;
    await host!.dispatchTimer.runNow();
    expect(h.abortedRoles, "按时做完的工具不是卡死").toEqual([]);
    expect(getWork(db, "w1")?.status).not.toBe("failed");
  });
});
