/**
 * Sansheng · WS 连接生命周期集成测试(批次 3 A7/C7 验收防线)
 *
 * 来源:docs/CODE-REVIEW-2026-10-01.md §A7 + §C7 —
 *   「刷新页面后流式输出/bus 事件永久进死 socket」
 *
 * RED 复现形态(旧代码全部失败):
 *  A. 双连接:conn1 触发 kernel start 后关闭,conn2 重连再发消息 →
 *     session.subscribe 的 handler 闭包仍持 conn1 的 sink → conn2 收不到 delta。
 *  B. MessageBus 订阅闭包一次性捕获 conn1 sink → conn1 死后 bus.broadcast
 *     的 bus_event 进死 socket,活连接 conn3 收不到。
 *  C. runPlan 的 plan_done 用 send(发起连接) → 发起连接中途关闭后,
 *     重连的 conn2 收不到 plan_done(进度丢失,C7)。
 *  D. kernel.reset() 后(旧代码 http.ts 传 log stub sink)事件不再到达任何活连接;
 *     新代码 reset 不再接受 sink 覆盖,事件经 emit 多播到活连接。
 *  E. setOnTask 单槽被每连接覆盖(C7):task 触发 plan 后发起连接关闭,
 *     重连的连接收不到 plan_done。
 *  F. kernel.attachSink 多播语义(detach / 单 sink 异常隔离)——新 API 单测。
 *
 * harness 参照 tests/server/ws-plan-integration.test.ts(真实 attachWebSocket +
 * 真实 AgentKernel + 真实 Orchestrator + 真实 Storage + ws client)。
 *
 * fake 说明(报告项):流式输出路径需要 Pi session 发事件,而真实 Pi session
 * 在测试中无法离线产生 LLM 流(PI_OFFLINE 只保证不触网,不产生假回复)。
 * 因此本文件用 vi.mock 替换 `createAgentSession`(agentKernel.createPiSession 的
 * 唯一注入点,已 grep 确认 kernel/communicator 均从该包 import)——fake session
 * 的 prompt() 同步回放一段标准 Pi 事件流。除 session 外全部真实:
 * AgentKernel(含 makeHandler/ensureCommunicator/MessageBus 订阅)、
 * attachWebSocket 闭包、Orchestrator(经 llmCallFactory seam 注入 fake llmCall)、
 * Communicator(decide 正则启发式,无 LLM)、Storage(临时目录 SQLite)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";

/* ────────────────────────────────────────────────────────── *
 * Fake Pi session(唯一 fake 的 SDK 组件)
 * ────────────────────────────────────────────────────────── */

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeSession {
    isIdle = true;
    isStreaming = false;
    private listeners: Array<(ev: unknown) => void> = [];

    subscribe(listener: (ev: unknown) => void): () => void {
      this.listeners.push(listener);
      return () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      };
    }

    /** 同步回放一段最小 Pi 事件流;delta 内容 echo prompt 尾部便于断言 */
    async prompt(text: string): Promise<void> {
      const mid = `fake-${Math.random().toString(36).slice(2, 10)}`;
      const tail = text.slice(-60);
      const fire = (ev: unknown) => {
        for (const l of [...this.listeners]) l(ev);
      };
      fire({ type: "agent_start" });
      fire({ type: "turn_start", turnIndex: 1 });
      fire({ type: "message_start", message: { role: "user", id: `u-${mid}` } });
      fire({ type: "message_start", message: { role: "assistant", id: mid } });
      fire({
        type: "message_update",
        // 真实形状:pi-ai 的 AssistantMessageEvent 增量事件叫 **text_delta**
        // (types.d.ts:470+),文本在 delta 上,没有 "text" 这个 type、也没有 text 字段。
        // 旧形状是拍脑袋编的,靠 kernel 宽松的 else 分支才跑得通 —— 7-I(A) 修掉
        // 那个宽松 else 后它就露馅了。
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `echo:${tail}` },
      });
      fire({ type: "message_end", message: { id: mid, usage: { input: 3, output: 4 } } });
      fire({ type: "agent_end" });
    }

    abort(): void {}
    dispose(): void {
      this.listeners = [];
    }
  }
  return {
    createAgentSession: async () => ({ session: new FakeSession() }),
    // communicator.ts 的 value import(仅 ensureSession LLM 路径使用,本测试不触达)
    DefaultResourceLoader: class {},
  };
});

import { attachWebSocket } from "../../src/server/ws.js";
import { AgentKernel, type ServerEvent } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";

/* ────────────────────────────────────────────────────────── *
 * Fake LLM(经 AttachOptions.llmCallFactory,批次 1 seam)
 * ────────────────────────────────────────────────────────── */

interface LlmInput {
  systemPrompt: string;
  userPrompt: string;
}

const plannerPrompts: string[] = [];
const executorPrompts: string[] = [];

let fakeLlm: (input: LlmInput) => Promise<string> = async () => {
  throw new Error("fakeLlm not configured for current scenario");
};

function isPlannerInput(input: LlmInput): boolean {
  return input.systemPrompt.includes("Planner");
}

function recordingLlmCall(input: LlmInput): Promise<string> {
  if (isPlannerInput(input)) plannerPrompts.push(input.userPrompt);
  else executorPrompts.push(input.userPrompt);
  return fakeLlm(input);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────── *
 * 真实 server 栈(临时目录;kernel 不预 start —— 由首个连接触发,
 * 精确复现「conn1 触发 kernel start」的生产时序)
 * ────────────────────────────────────────────────────────── */

let dataDir: string;
let storage: Storage;
let settingsStore: SettingsStore;
let kernel: AgentKernel;
let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-ws-life-it-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;

  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-lc",
        label: "lifecycle-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-lifecycle-test-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-lc",
    cwd: dataDir,
    personaName: "三生-lc",
  });

  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  // 注意:不预 start —— 场景 A 要求由 conn1 的连接触发 start(捕获时序即 bug 本体)

  httpServer = createServer();
  wss = attachWebSocket(httpServer, kernel, {
    storage,
    settingsStore,
    dataDir,
    llmCallFactory: () => recordingLlmCall,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  port = (httpServer.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  try { wss?.close(); } catch { /* ignore */ }
  if (httpServer) {
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  try { kernel?.invalidate(); } catch { /* ignore */ }
  try { storage?.close(); } catch { /* ignore */ }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (savedPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedPiOffline;
  if (savedSanshengData === undefined) delete process.env.SANSHENG_DATA;
  else process.env.SANSHENG_DATA = savedSanshengData;
});

/* ────────────────────────────────────────────────────────── *
 * ws client helper(与 ws-plan-integration.test.ts 同构)
 * ────────────────────────────────────────────────────────── */

interface TestClient {
  readonly events: ServerEvent[];
  send(cmd: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function connectClient(): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: ServerEvent[] = [];
  // message 监听必须在 await open 之前同步挂上:server 在 connection 处理里
  // 立即发握手 ready,mock 下 start() 的 ready 也在同一 tick 批写出 ——
  // 两帧会落在客户端首个 data read 里,先于 open 的 await 续体执行,晚挂即丢帧。
  ws.on("message", (raw) => {
    events.push(JSON.parse(raw.toString()) as ServerEvent);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  return {
    events,
    send(cmd) {
      ws.send(JSON.stringify(cmd));
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => resolve(), 500);
          ws.once("close", () => { clearTimeout(t); resolve(); });
          ws.close();
        });
      }
    },
  };
}

/** 等待某类型事件到达;超时抛错并附已见事件序列(RED 证据可读性) */
async function waitForEvent<T extends ServerEvent["type"]>(
  client: TestClient,
  type: T,
  opts: { timeoutMs?: number; where?: (e: Extract<ServerEvent, { type: T }>) => boolean } = {},
): Promise<Extract<ServerEvent, { type: T }>> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const raw of client.events) {
      if (raw.type !== type) continue;
      const e = raw as Extract<ServerEvent, { type: T }>;
      if (!opts.where || opts.where(e)) return e;
    }
    if (Date.now() > deadline) {
      const seen = client.events
        .map((e) => (e.type === "error" ? `error(${e.error.code})` : e.type))
        .join(", ");
      throw new Error(`waitForEvent: ${timeoutMs}ms 内未收到 "${type}"。已见事件:[${seen}]`);
    }
    await sleep(10);
  }
}

/** 场景收尾:abort 掉可能仍在跑的 plan(GREEN 态为 no-op) */
async function abortActivePlan(client: TestClient): Promise<void> {
  client.send({ type: "abort_plan" });
  try {
    await waitForEvent(client, "plan_failed", { timeoutMs: 1_000 });
  } catch {
    /* 没有在跑的 plan — 忽略 */
  }
}

/* ────────────────────────────────────────────────────────── *
 * 场景(顺序有意:A 要求 kernel 未 start,B-F 复用 started kernel)
 * ────────────────────────────────────────────────────────── */

describe("ws lifecycle (A7 多播 sink + C7 进度广播)", () => {
  it("A: conn1 触发 kernel start 后关闭,conn2 重连发消息 → conn2 收到流式 delta(A7-1 回归)", async () => {
    const c1 = await connectClient();
    try {
      // start() 完成的可靠信号:conn1 收到第 2 个 ready
      //(第 1 个 = 握手即发;第 2 个 = start 内部 sink/emit 的 ready,其后同步执行
      // session.subscribe —— 旧代码正是在这里把 conn1 的 sink 一次性捕获)
      await vi.waitFor(
        () => {
          const readys = c1.events.filter((e) => e.type === "ready").length;
          expect(readys).toBeGreaterThanOrEqual(2);
        },
        { timeout: 15_000 },
      );
      expect(kernel.isReady()).toBe(true);
    } finally {
      await c1.close();
    }

    // conn2 重连(= 浏览器刷新):kernel 已 ready,旧代码 ensureStarted 提前 return,
    // conn2 的 sink 永远不会接进 kernel 事件流
    const c2 = await connectClient();
    try {
      c2.send({ type: "send", content: "hello-a7-mark" });
      const d = await waitForEvent(c2, "delta", {
        timeoutMs: 6_000,
        where: (e) => e.text.includes("hello-a7-mark"),
      });
      expect(d.conversationId).toBe(kernel.getConversationId());
      // 完整流:agent_end 也必须到达(streaming 状态闭环,否则 UI 卡「推演中」)
      await waitForEvent(c2, "agent_end", { timeoutMs: 3_000 });
    } finally {
      await c2.close();
    }
  }, 40_000);

  it("B: bus 订阅闭包多播 — conn1 死后 broadcast 的 bus_event 到达活连接(A7-1 回归)", async () => {
    const c3 = await connectClient();
    try {
      kernel.getBus().broadcast({
        fromRole: "communicator",
        toRole: "user",
        conversationId: kernel.getConversationId(),
        payload: "B-multicast-mark",
      });
      // 旧代码:bus.subscribe 闭包持有的还是 conn1 的 sink(ensureCommunicator 早退
      // 不重绑)→ 事件进死 socket,c3 永远收不到
      const ev = await waitForEvent(c3, "bus_event", {
        timeoutMs: 4_000,
        where: (e) => e.message.payload === "B-multicast-mark",
      });
      expect(ev.message.conversationId).toBe(kernel.getConversationId());
    } finally {
      await c3.close();
    }
  }, 20_000);

  it("C: plan 发起连接中途关闭 → plan_done 广播到重连的 conn2(C7 回归)", async () => {
    plannerPrompts.length = 0;
    executorPrompts.length = 0;
    fakeLlm = async (input) => {
      if (isPlannerInput(input)) {
        return JSON.stringify([
          { id: "lc-c1", title: "广播任务", body: "b", dependsOn: [] },
        ]);
      }
      await sleep(500); // 保证 plan 在 conn1 关闭时仍在跑
      return JSON.stringify({ outcome: "evidence", evidence: { title: "c done", body: "ok" } });
    };

    const c1 = await connectClient();
    try {
      c1.send({ type: "plan", goal: "lifecycle-C-broadcast-mark", conversationId: "conv-lc-c" });
      await vi.waitFor(
        () => expect(plannerPrompts.some((p) => p.includes("lifecycle-C-broadcast-mark"))).toBe(true),
        { timeout: 10_000 },
      );
      // plan 在跑,发起连接关闭(= 用户刷新页面)
      await c1.close();

      const c2 = await connectClient();
      try {
        // 旧代码:plan_done 走 send(conn1) → 死 socket;conn2 只能看到 artifact_*
        // (artifactBus 每连接订阅),看不到 plan 完成闭环
        const done = await waitForEvent(c2, "plan_done", {
          timeoutMs: 10_000,
          where: (e) => e.conversationId === "conv-lc-c",
        });
        expect(done.summary).toContain("完成 1/1");
      } finally {
        await abortActivePlan(c2);
        await c2.close();
      }
    } finally {
      if (c1) await c1.close().catch(() => {});
    }
  }, 40_000);

  it("D: kernel.reset() 不再被 stub sink 劫持 — reset 后事件仍到达活连接(A7-3 回归)", async () => {
    const cD = await connectClient();
    try {
      // 旧签名 reset(sink) 且生产传 log stub(http.ts)→ 事件全进日志桩;
      // 新签名 reset() 无参 —— 旧代码下此调用直接 TypeError(sink is not a function)
      await kernel.reset();
      // reset 会 dispose 旧 session 并重新 start + subscribe:
      // 新代码 subscribe 恰好一次且 handler 走 emit 多播
      cD.send({ type: "send", content: "post-reset-mark" });
      const d = await waitForEvent(cD, "delta", {
        timeoutMs: 8_000,
        where: (e) => e.text.includes("post-reset-mark"),
      });
      expect(d.conversationId).toBe(kernel.getConversationId());
    } finally {
      await cD.close();
    }
  }, 30_000);

  it("E: setOnTask boot 级接线 — task 触发 plan 后发起连接关闭,重连连接收到 plan_done(C7 回归)", async () => {
    plannerPrompts.length = 0;
    executorPrompts.length = 0;
    fakeLlm = async (input) => {
      if (isPlannerInput(input)) {
        return JSON.stringify([
          { id: "lc-e1", title: "onTask 任务", body: "e", dependsOn: [] },
        ]);
      }
      await sleep(500);
      return JSON.stringify({ outcome: "evidence", evidence: { title: "e done", body: "ok" } });
    };

    const cE1 = await connectClient();
    try {
      // "重构" 命中 Communicator decide 正则 → task → onTask → runPlan(生产路径)
      cE1.send({ type: "send", content: "帮我重构 lifecycle-E-task-mark 模块" });
      await vi.waitFor(
        () => expect(plannerPrompts.some((p) => p.includes("lifecycle-E-task-mark"))).toBe(true),
        { timeout: 10_000 },
      );
      await cE1.close();

      const cE2 = await connectClient();
      try {
        // 旧代码:onTask 单槽指向 cE1 的 runPlan 闭包 → plan_done 进死 socket
        const done = await waitForEvent(cE2, "plan_done", { timeoutMs: 10_000 });
        expect(done.summary).toContain("完成 1/1");
      } finally {
        await abortActivePlan(cE2);
        await cE2.close();
      }
    } finally {
      if (cE1) await cE1.close().catch(() => {});
    }
  }, 40_000);

  it("F: attachSink 多播语义 — 多个 sink 同时收事件,detach 生效,单 sink 异常不影响其他(S1 单测)", async () => {
    const seenA: ServerEvent[] = [];
    const seenB: ServerEvent[] = [];
    const detachA = kernel.attachSink((e) => seenA.push(e));
    const boom = kernel.attachSink(() => {
      throw new Error("sink-boom-mark");
    });
    const detachB = kernel.attachSink((e) => seenB.push(e));
    try {
      kernel.getBus().broadcast({
        fromRole: "communicator",
        toRole: "user",
        conversationId: kernel.getConversationId(),
        payload: "F-multicast-mark",
      });
      // boom sink 在中间抛错,A/B 都必须收到(逐个 try/catch)
      expect(seenA.some((e) => e.type === "bus_event" && e.message.payload === "F-multicast-mark")).toBe(true);
      expect(seenB.some((e) => e.type === "bus_event" && e.message.payload === "F-multicast-mark")).toBe(true);

      detachA();
      kernel.getBus().broadcast({
        fromRole: "communicator",
        toRole: "user",
        conversationId: kernel.getConversationId(),
        payload: "F-after-detach-mark",
      });
      expect(seenA.some((e) => e.type === "bus_event" && e.message.payload === "F-after-detach-mark")).toBe(false);
      expect(seenB.some((e) => e.type === "bus_event" && e.message.payload === "F-after-detach-mark")).toBe(true);
      // detach 幂等
      detachB();
      detachB();
    } finally {
      detachA();
      boom();
      detachB();
    }
  }, 20_000);
});
