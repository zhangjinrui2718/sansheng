/**
 * 批次 5b-1 · P2 — task 只走 runPlan(根治 §B2 双执行)+ P1 集成接线
 *
 * 现状(基线 49d31ed,docs/CODE-REVIEW-2026-10-01.md §B2):
 *   decide=task 时 onTask→runPlan 与 kernel.prompt 尾部 session.prompt **并行双执行**
 *   (agentKernel.ts:861-873 注释块自认「留待批次 5b 根治」);沟通员的 task 确认
 *   delta 在 kernel 翻译层被丢弃(用户看不到交接确认);task+离线时 offline_no_session
 *   与 runPlan 的 no_api_key 并列 emit(5a.5 open#2 事件重复)。
 *
 * 新契约(jev A 方案):
 *   ① decide=task → 只触发 onTask→runPlan;不再 session.prompt(双执行根治)。
 *   ② 用户可见**恰好一条**交接确认(完整 turn 事件序列 turn_start→delta→
 *      message_end→agent_end,经 ws 到达客户端;后续进展走 plan 事件/plan_done)。
 *   ③ raw 用户消息 + 交接确认都落 messages 表(刷新后历史完整)。
 *   ④ task+无 session/离线:只发 plan 链路自己的错误(no_api_key),抑制
 *      offline_no_session 重复;且确认先于错误到达(error banner 不被 turn 清掉)。
 *   ⑤ P1 集成:kernel 构造注入 decideLlmCall seam → LLM 判 task 时 runPlan 用
 *      taskGoal(提炼目标,非 raw),确认用 ack;LLM 判 chat 时仍 Pi 直答。
 *   ⑥ chat 路径守护:5a.5 语义不动(Pi 直答 + raw 落库 + 离线 offline_no_session)。
 *
 * RED(基线):T1(确认 delta 不存在 + session.prompt 被调)红;T2(offline_no_session
 * 出现 + 无确认)红;T3(第 5 构造参数被忽略 → 正则 chat → planner 不被调)红。
 * T4/T5/T6 为守护(基线也绿)。
 *
 * harness 参照 ws-lifecycle.test.ts:唯一 fake 的 SDK 组件 = createAgentSession
 * (FakeSession 捕获 session.prompt);runPlan/Orchestrator/Communicator/Storage/
 * attachWebSocket 全部生产代码(llmCall 经 AttachOptions.llmCallFactory seam)。
 * 临时目录,不碰真实 ~/.sansheng;PI_OFFLINE=1 不触网。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";

/* ── Fake Pi session(捕获 session.prompt 全文 = 双执行探针)── */
const __cap = vi.hoisted(() => ({ sessionPrompts: [] as string[] }));

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

    async prompt(text: string): Promise<void> {
      __cap.sessionPrompts.push(text);
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
        assistantMessageEvent: { type: "text", delta: `echo:${tail}`, text: `echo:${tail}` },
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
    DefaultResourceLoader: class {},
  };
});

import { attachWebSocket } from "../../src/server/ws.js";
import { AgentKernel, type ServerEvent } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import {
  Keyring,
  Storage,
  listMessagesByConversation,
} from "../../src/server/storage/index.js";

/* ── Fake plan-chain LLM(经 llmCallFactory seam;单 todo 秒完成)── */
interface LlmInput {
  systemPrompt: string;
  userPrompt: string;
}
const plannerPrompts: string[] = [];
const executorPrompts: string[] = [];

function isPlannerInput(input: LlmInput): boolean {
  return input.systemPrompt.includes("Planner");
}

async function recordingLlmCall(input: LlmInput): Promise<string> {
  if (isPlannerInput(input)) {
    plannerPrompts.push(input.userPrompt);
    return JSON.stringify([{ id: "tsp-1", title: "tsp todo", body: "b", dependsOn: [] }]);
  }
  executorPrompts.push(input.userPrompt);
  return JSON.stringify({ outcome: "evidence", evidence: { title: "tsp done", body: "ok" } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── per-test 真实 server 栈 ── */
interface Stack {
  dataDir: string;
  storage: Storage;
  settingsStore: SettingsStore;
  kernel: AgentKernel;
  httpServer: Server;
  wss: WebSocketServer;
  port: number;
}
const stacks: Stack[] = [];

async function makeStack(opts: {
  providers: "fake-key" | "none";
  decideLlmCall?: (input: LlmInput) => Promise<string>;
}): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), "sansheng-task-single-"));
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers:
      opts.providers === "fake-key"
        ? [
            {
              id: "p-tsp",
              label: "tsp-test",
              provider: "openai",
              modelId: "gpt-4o-mini",
              apiKey: "sk-tsp-test-fake",
              thinkingLevel: "off",
            },
          ]
        : [],
    activeProviderId: opts.providers === "fake-key" ? "p-tsp" : "",
    cwd: dataDir,
    personaName: "三生-tsp",
  });
  // 批次 5b-1 P1 seam:第 5 构造参数(基线忽略 → T3 RED)
  const kernel = new AgentKernel(
    settingsStore,
    join(dataDir, "pi"),
    dataDir,
    storage,
    opts.decideLlmCall ? { decideLlmCall: opts.decideLlmCall } : undefined,
  );
  const httpServer = createServer();
  const wss = attachWebSocket(httpServer, kernel, {
    storage,
    settingsStore,
    dataDir,
    llmCallFactory: () => recordingLlmCall,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const stack = { dataDir, storage, settingsStore, kernel, httpServer, wss, port };
  stacks.push(stack);
  return stack;
}

let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

beforeAll(() => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  process.env.PI_OFFLINE = "1";
});

afterAll(async () => {
  for (const s of stacks) {
    try { s.wss.close(); } catch { /* ignore */ }
    try { s.httpServer.closeAllConnections?.(); } catch { /* ignore */ }
    try {
      await new Promise<void>((resolve) => s.httpServer.close(() => resolve()));
    } catch { /* ignore */ }
    try { s.kernel.invalidate(); } catch { /* ignore */ }
    try { s.storage.close(); } catch { /* ignore */ }
    try { rmSync(s.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (savedPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedPiOffline;
  if (savedSanshengData === undefined) delete process.env.SANSHENG_DATA;
  else process.env.SANSHENG_DATA = savedSanshengData;
});

/* ── ws client helper(与 ws-lifecycle 同构)── */
interface TestClient {
  readonly events: ServerEvent[];
  send(cmd: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function connectClient(stack: Stack): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/ws`);
  const events: ServerEvent[] = [];
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

function dbMessages(stack: Stack, convId: string) {
  return listMessagesByConversation(stack.storage.db, convId);
}

/* ────────────────────────────────────────────────────────── */

describe("batch5b-1 P2 · task 只走 runPlan(§B2 双执行根治)", () => {
  it("T1: task → planner 被调 + session.prompt 不被调 + 恰好一条交接确认 turn + raw/ack 落库", async () => {
    const stack = await makeStack({ providers: "fake-key" });
    await stack.kernel.start();
    plannerPrompts.length = 0;
    executorPrompts.length = 0;
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      const raw = "帮我重构 TSP-MARK-A 模块";
      c.send({ type: "send", content: raw, conversationId: stack.kernel.getConversationId() });

      // ① runPlan 被触发(planner 收到 goal)
      await vi.waitFor(
        () => expect(plannerPrompts.some((p) => p.includes("TSP-MARK-A"))).toBe(true),
        { timeout: 10_000 },
      );
      // ② 用户可见交接确认(RED 基线:kernel 丢弃 communicator delta → 永不到达)
      const ackDelta = await waitForEvent(c, "delta", {
        timeoutMs: 6_000,
        where: (e) => e.text.includes("规划执行链路"),
      });
      expect(ackDelta.conversationId).toBe(stack.kernel.getConversationId());
      // 完整 turn 序列(前端渲染依赖:turn_start 建 turn,agent_end 收尾)
      expect(c.events.some((e) => e.type === "turn_start")).toBe(true);
      await waitForEvent(c, "agent_end", { timeoutMs: 3_000 });
      // 确认只此一条:含「规划执行链路」的 delta 恰好 1 个
      const ackDeltas = c.events.filter(
        (e) => e.type === "delta" && e.text.includes("规划执行链路"),
      );
      expect(ackDeltas).toHaveLength(1);

      // 等 plan 收尾,避免跨测试 activeOrchestrator 干扰(本 stack 用完即弃,双保险)
      await waitForEvent(c, "plan_done", { timeoutMs: 10_000 }).catch(() => undefined);

      // ③ 双执行根治(RED 基线:session.prompt 与 runPlan 并行,捕获含 raw)
      expect(__cap.sessionPrompts.some((p) => p.includes("TSP-MARK-A"))).toBe(false);

      // ④ 落库:raw 用户消息 + assistant 交接确认(刷新后历史完整)
      const msgs = dbMessages(stack, stack.kernel.getConversationId());
      const userRow = msgs.find((m) => m.role === "user");
      expect(userRow?.content).toBe(raw); // raw 原文,非 enriched blob(5a.5 语义保留)
      const ackRow = msgs.find((m) => m.role === "assistant");
      expect(ackRow?.content).toContain("规划执行链路");
      // echo(FakeSession 直答产物)不得落库 —— 直答根本没发生
      expect(msgs.some((m) => m.content.includes("echo:"))).toBe(false);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("T2: task+无 provider 离线 → 交接确认 + no_api_key,无 offline_no_session 重复,确认先于错误", async () => {
    const stack = await makeStack({ providers: "none" });
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      c.send({
        type: "send",
        content: "帮我重构 TSP-MARK-C 模块",
        conversationId: stack.kernel.getConversationId(),
      });
      // plan 链路自己的错误(no_api_key)仍然到达
      await waitForEvent(c, "error", {
        timeoutMs: 8_000,
        where: (e) => e.error.code === "no_api_key",
      });
      // 交接确认到达(RED 基线:delta 被 kernel 丢弃)
      const ackDelta = await waitForEvent(c, "delta", {
        timeoutMs: 4_000,
        where: (e) => e.text.includes("规划执行链路"),
      });
      expect(ackDelta).toBeTruthy();
      // 5a.5 open#2 收编:task 且无 session → 不再并列 emit offline_no_session
      // (RED 基线:与 no_api_key 重复出现)
      expect(
        c.events.some((e) => e.type === "error" && e.error.code === "offline_no_session"),
      ).toBe(false);
      // 顺序:确认先于错误(前端 turn_start 会清 error banner —— 错误必须最后到,
      // 用户才能看到「plan 链路起不来」)
      const ackIdx = c.events.indexOf(ackDelta);
      const errIdx = c.events.findIndex(
        (e) => e.type === "error" && e.error.code === "no_api_key",
      );
      expect(ackIdx).toBeLessThan(errIdx);
      // raw 仍落库(离线也不丢用户消息)
      const msgs = dbMessages(stack, stack.kernel.getConversationId());
      expect(msgs.some((m) => m.role === "user" && m.content.includes("TSP-MARK-C"))).toBe(true);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("T3: P1 集成 — decideLlmCall 判 task:runPlan 用 taskGoal、确认用 ack、直答不发生", async () => {
    const decideInputs: LlmInput[] = [];
    const stack = await makeStack({
      providers: "fake-key",
      decideLlmCall: async (input) => {
        decideInputs.push(input);
        return JSON.stringify({
          kind: "task",
          taskGoal: "TG-INJECT-B 提炼后的规划目标",
          ack: "ACK-INJECT-B 已交接给规划执行链路。",
        });
      },
    });
    await stack.kernel.start();
    plannerPrompts.length = 0;
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      // 正则启发式判 chat 的文本(无动作词)—— LLM decide 判 task 才会触发 plan
      const raw = "今天过得真快啊 TSP-B";
      c.send({ type: "send", content: raw, conversationId: stack.kernel.getConversationId() });

      // RED 基线:第 5 构造参数被忽略 → 正则 chat → planner 永不收到 TG-INJECT-B
      await vi.waitFor(
        () => expect(plannerPrompts.some((p) => p.includes("TG-INJECT-B"))).toBe(true),
        { timeout: 10_000 },
      );
      // planner 收到的是提炼目标,不是 raw 闲聊原文
      expect(plannerPrompts.some((p) => p.includes("今天过得真快啊"))).toBe(false);
      // 确认 = LLM ack(唯一一条)
      await waitForEvent(c, "delta", {
        timeoutMs: 4_000,
        where: (e) => e.text === "ACK-INJECT-B 已交接给规划执行链路。",
      });
      // 直答不发生
      expect(__cap.sessionPrompts.some((p) => p.includes("TSP-B"))).toBe(false);
      // 分类输入 = 用户 raw 消息
      expect(decideInputs.length).toBeGreaterThanOrEqual(1);
      expect(decideInputs[0]!.userPrompt).toContain(raw);
      // ack 落库为 assistant 消息
      const msgs = dbMessages(stack, stack.kernel.getConversationId());
      expect(msgs.some((m) => m.role === "assistant" && m.content.includes("ACK-INJECT-B"))).toBe(true);
      expect(msgs.some((m) => m.role === "user" && m.content === raw)).toBe(true);

      await waitForEvent(c, "plan_done", { timeoutMs: 10_000 }).catch(() => undefined);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("T4: P1 集成守护 — decideLlmCall 判 chat:仍 Pi 直答,不触发 plan", async () => {
    const stack = await makeStack({
      providers: "fake-key",
      decideLlmCall: async () => JSON.stringify({ kind: "chat", taskGoal: "", ack: "" }),
    });
    await stack.kernel.start();
    plannerPrompts.length = 0;
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      c.send({ type: "send", content: "随便聊聊 TSP-D", conversationId: stack.kernel.getConversationId() });
      await waitForEvent(c, "delta", {
        timeoutMs: 8_000,
        where: (e) => e.text.includes("echo:"),
      });
      expect(__cap.sessionPrompts.some((p) => p.includes("TSP-D"))).toBe(true);
      expect(plannerPrompts.some((p) => p.includes("TSP-D"))).toBe(false);
      await waitForEvent(c, "agent_end", { timeoutMs: 3_000 });
    } finally {
      await c.close();
    }
  }, 40_000);

  it("T5: chat 守护 — 正则降级 chat 路径行为不变(直答 + raw 落库)", async () => {
    const stack = await makeStack({ providers: "fake-key" });
    await stack.kernel.start();
    plannerPrompts.length = 0;
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      const raw = "你好呀 TSP-E";
      c.send({ type: "send", content: raw, conversationId: stack.kernel.getConversationId() });
      await waitForEvent(c, "delta", {
        timeoutMs: 8_000,
        where: (e) => e.text.includes("echo:"),
      });
      expect(__cap.sessionPrompts.some((p) => p.includes("TSP-E"))).toBe(true);
      expect(plannerPrompts.length).toBe(0);
      await waitForEvent(c, "agent_end", { timeoutMs: 3_000 });
      const msgs = dbMessages(stack, stack.kernel.getConversationId());
      expect(msgs.some((m) => m.role === "user" && m.content === raw)).toBe(true);
      // chat 路径没有任何「交接确认」
      expect(c.events.filter((e) => e.type === "delta" && e.text.includes("规划执行链路"))).toHaveLength(0);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("T6: chat+离线守护 — offline_no_session 仍然单独出现(chat 语义不受 P2 影响)", async () => {
    const stack = await makeStack({ providers: "none" });
    const c = await connectClient(stack);
    try {
      c.send({ type: "send", content: "你好,有人在吗", conversationId: stack.kernel.getConversationId() });
      await waitForEvent(c, "error", {
        timeoutMs: 8_000,
        where: (e) => e.error.code === "offline_no_session",
      });
      expect(stack.kernel.isReady()).toBe(false);
    } finally {
      await c.close();
    }
  }, 40_000);
});
