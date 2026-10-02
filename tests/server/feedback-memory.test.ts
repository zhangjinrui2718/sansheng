/**
 * 批次 5b-1 · P4 — feedback 身份/偏好接线(用户侧记忆入库 + 收录确认)
 *
 * 新契约:
 *   ① decide=feedback(正则降级「记住:/我叫/我喜欢…」或 LLM 分类)→ 不再
 *      session.prompt 直答(P2 早退),用户可见**恰好一条**收录确认
 *      (LLM ack 字段;降级固定文案「已记下。」)。
 *   ② 记忆从**用户 raw 文本**提取入库(extractor P4 用户侧模式):
 *      「记住:X」→ fact X;「我叫X」→ fact 用户名字:X + profile.name 接线;
 *      「我喜欢/讨厌…」→ preference 原句。
 *   ③ raw + 收录确认落 messages 表(与 task 交接同一条 persistHandoff 路径)。
 *   ④ assistant 侧 extractAndStoreFragments 既有路径零改动(memory-loop 守护)。
 *
 * RED(基线):feedback 确认 delta 被 kernel 丢弃(不可见)+ 无任何 fragment/
 * profile 入库 → ①②③ 全红。
 *
 * harness 与 task-single-path.test.ts 同构:FakeSession 探针 + 真实
 * attachWebSocket/Communicator/Storage;embedText mock 成 no-op(fake key 不发
 * 真实嵌入请求,测试封闭不触网)。PI_OFFLINE=1;临时 dataDir,不碰 ~/.sansheng。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";

/* ── Fake Pi session(session.prompt 探针:feedback 不得进直答)── */
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

/* ── embedText no-op(fake key 不发真实嵌入 HTTP;fragment 入库本体不受影响)── */
vi.mock("../../src/server/storage/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../src/server/storage/index.js")>();
  return { ...orig, embedText: async () => null };
});

import { attachWebSocket } from "../../src/server/ws.js";
import { AgentKernel, type ServerEvent } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import {
  Keyring,
  Storage,
  getProfile,
  listMessagesByConversation,
} from "../../src/server/storage/index.js";

interface LlmInput {
  systemPrompt: string;
  userPrompt: string;
}
const plannerPrompts: string[] = [];

async function recordingLlmCall(input: LlmInput): Promise<string> {
  if (input.systemPrompt.includes("Planner")) {
    plannerPrompts.push(input.userPrompt);
    return JSON.stringify([{ id: "fb-1", title: "fb todo", body: "b", dependsOn: [] }]);
  }
  return JSON.stringify({ outcome: "evidence", evidence: { title: "fb done", body: "ok" } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── per-test 真实 server 栈(与 task-single-path 同构)── */
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
  const dataDir = mkdtempSync(join(tmpdir(), "sansheng-feedback-mem-"));
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers:
      opts.providers === "fake-key"
        ? [
            {
              id: "p-fb",
              label: "fb-test",
              provider: "openai",
              modelId: "gpt-4o-mini",
              apiKey: "sk-fb-test-fake",
              thinkingLevel: "off",
            },
          ]
        : [],
    activeProviderId: opts.providers === "fake-key" ? "p-fb" : "",
    cwd: dataDir,
    personaName: "三生-fb",
  });
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

/* ── ws client helper ── */
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

interface FragRow {
  kind: string;
  content: string;
  importance: number;
}
function dbFragments(stack: Stack): FragRow[] {
  return stack.storage.db
    .prepare("SELECT kind, content, importance FROM fragments ORDER BY created_at")
    .all() as FragRow[];
}

/* ────────────────────────────────────────────────────────── */

describe("batch5b-1 P4 · feedback 身份/偏好接线(用户侧记忆入库 + 收录确认)", () => {
  it("F1: 「记住:我喜欢绿茶」→ fact fragment 入库 + 恰好一条收录确认 + 不进直答", async () => {
    const stack = await makeStack({ providers: "fake-key" });
    await stack.kernel.start();
    __cap.sessionPrompts.length = 0;
    plannerPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      const raw = "记住:我喜欢绿茶";
      c.send({ type: "send", content: raw, conversationId: stack.kernel.getConversationId() });

      // ① 收录确认(正则降级固定文案)可见且唯一 —— RED 基线:delta 被 kernel 丢弃
      await waitForEvent(c, "delta", { timeoutMs: 6_000, where: (e) => e.text.includes("已记下") });
      await waitForEvent(c, "agent_end", { timeoutMs: 3_000 });
      expect(c.events.filter((e) => e.type === "delta")).toHaveLength(1);

      // ② 不进 Pi 直答 / 不进 plan 链路
      expect(__cap.sessionPrompts).toHaveLength(0);
      expect(plannerPrompts).toHaveLength(0);

      // ③ fragment 入库(REMEMBER_RE → fact「我喜欢绿茶」)+ raw/ack 落库
      await vi.waitFor(() => expect(dbFragments(stack).length).toBeGreaterThanOrEqual(1), {
        timeout: 4_000,
      });
      const frags = dbFragments(stack);
      expect(frags.some((f) => f.kind === "fact" && f.content.includes("我喜欢绿茶"))).toBe(true);
      const msgs = dbMessages(stack, stack.kernel.getConversationId());
      expect(msgs.some((m) => m.role === "user" && m.content === raw)).toBe(true);
      expect(msgs.some((m) => m.role === "assistant" && m.content.includes("已记下"))).toBe(true);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("F2: 「我叫小明」→ fact 用户名字:小明 + profile.name 接线 + 收录确认", async () => {
    const stack = await makeStack({ providers: "fake-key" });
    await stack.kernel.start();
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      c.send({ type: "send", content: "我叫小明", conversationId: stack.kernel.getConversationId() });
      await waitForEvent(c, "delta", { timeoutMs: 6_000, where: (e) => e.text.includes("已记下") });

      // 身份 fact + profile 接线(listProfile 已在 ws contextBlock 读回 → 闭环)
      await vi.waitFor(() => {
        const name = getProfile(stack.storage.db, "name");
        expect(name?.value).toBe("小明");
      }, { timeout: 4_000 });
      const frags = dbFragments(stack);
      expect(frags.some((f) => f.kind === "fact" && f.content === "用户名字:小明")).toBe(true);
      expect(__cap.sessionPrompts).toHaveLength(0);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("F3: LLM decide 判 feedback → 确认用注入 ack;preference fragment 从用户 raw 提取", async () => {
    const stack = await makeStack({
      providers: "none",
      decideLlmCall: async () =>
        JSON.stringify({ kind: "feedback", taskGoal: "", ack: "ACK-F3 已收录你的偏好。" }),
    });
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      const raw = "我讨厌加班 FB-MARK-3";
      c.send({ type: "send", content: raw, conversationId: stack.kernel.getConversationId() });

      // 确认 = LLM ack(非固定文案)
      await waitForEvent(c, "delta", {
        timeoutMs: 6_000,
        where: (e) => e.text === "ACK-F3 已收录你的偏好。",
      });
      // feedback 早退 → 离线也不 emit offline_no_session(那是 chat 专属兜底)
      expect(
        c.events.some((e) => e.type === "error" && e.error.code === "offline_no_session"),
      ).toBe(false);

      // preference fragment(用户侧 LIKE_RE 原句保存)
      await vi.waitFor(() => expect(dbFragments(stack).length).toBeGreaterThanOrEqual(1), {
        timeout: 4_000,
      });
      const frags = dbFragments(stack);
      expect(
        frags.some((f) => f.kind === "preference" && f.content.includes("我讨厌加班")),
      ).toBe(true);
      const msgs = dbMessages(stack, stack.kernel.getConversationId());
      expect(msgs.some((m) => m.role === "user" && m.content === raw)).toBe(true);
      expect(msgs.some((m) => m.role === "assistant" && m.content.includes("ACK-F3"))).toBe(true);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("F4: chat 守护 — 普通消息不产用户侧 fragment,直答路径不变", async () => {
    const stack = await makeStack({ providers: "fake-key" });
    await stack.kernel.start();
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      c.send({ type: "send", content: "你好呀 FB-MARK-4", conversationId: stack.kernel.getConversationId() });
      await waitForEvent(c, "delta", { timeoutMs: 8_000, where: (e) => e.text.includes("echo:") });
      expect(__cap.sessionPrompts.some((p) => p.includes("FB-MARK-4"))).toBe(true);
      await waitForEvent(c, "agent_end", { timeoutMs: 3_000 });
      // 无触发词的 chat 用户消息不产 fragment(assistant echo 也不产 —— 5a.5 T1 语义)
      expect(dbFragments(stack)).toHaveLength(0);
      expect(getProfile(stack.storage.db, "name")).toBeNull();
    } finally {
      await c.close();
    }
  }, 40_000);
});
