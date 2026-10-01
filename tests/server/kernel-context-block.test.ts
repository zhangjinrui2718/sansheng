/**
 * 批次 5a.5 · T1 — 记忆循环修复(上):kernel.prompt raw/enriched 分离
 *
 * 根因(docs/CODE-REVIEW-2026-10-01.md §B1,用户实测):
 *  ws.ts send 把「# Relevant Memories…---User: 原文」拼成 enriched 全文传给
 *  kernel.prompt → agentKernel 把收到的**全文**作为 role:"user" 落 messages 表
 *  → http.ts 历史 API 读出 → UI 刷新/会话对齐后用户消息变成 blob。
 *
 * 修复契约:
 *  - kernel.prompt(text, { contextBlock }) — Pi session 收到
 *    `contextBlock + "\n\n---\n\nUser: " + text`(记忆能力保留,进 Pi JSONL,用户不可见);
 *  - sansheng messages 表 insertMessage(role:"user") 持久化 **raw text**。
 *
 * RED(旧代码失败):
 *  ① prompt(raw, {contextBlock}) — 旧签名忽略第二参 → session 只收到 raw
 *  ④ ws send 路径 — 旧代码把 enriched 全文落库(blob)且 summary 垃圾被注入
 * harness 参照 tests/server/ws-lifecycle.test.ts(vi.mock FakeSession 回放 Pi 事件流,
 * 其余全部真实:AgentKernel/attachWebSocket/Storage/Communicator decide 启发式)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import { nanoid } from "nanoid";

/* ────────────────────────────────────────────────────────── *
 * Fake Pi session(唯一 fake 的 SDK 组件)— 捕获 session.prompt 全文
 * ────────────────────────────────────────────────────────── */

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

    /** 同步回放最小 Pi 事件流;全文进 capture 供断言 */
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
    // agentKernel/communicator 的 value import(本测试的 harness prompt 注入不触发)
    DefaultResourceLoader: class {},
  };
});

import { attachWebSocket } from "../../src/server/ws.js";
import { AgentKernel, type ServerEvent } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import {
  Keyring,
  Storage,
  insertFragment,
  listMessagesByConversation,
} from "../../src/server/storage/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────── *
 * 真实 server 栈(临时目录)
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
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-ctx-block-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;

  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-cb",
        label: "ctx-block-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-ctx-block-test-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-cb",
    cwd: dataDir,
    personaName: "三生-cb",
  });

  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  await kernel.start();

  httpServer = createServer();
  wss = attachWebSocket(httpServer, kernel, { storage, settingsStore, dataDir });
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
 * ws client helper(与 ws-lifecycle.test.ts 同构)
 * ────────────────────────────────────────────────────────── */

interface TestClient {
  readonly events: ServerEvent[];
  send(cmd: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function connectClient(): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

function lastUserContent(): string | undefined {
  const msgs = listMessagesByConversation(storage.db, kernel.getConversationId());
  return msgs.filter((m) => m.role === "user").at(-1)?.content;
}

/* ────────────────────────────────────────────────────────── *
 * 场景
 * ────────────────────────────────────────────────────────── */

describe("kernel.prompt contextBlock(raw/enriched 分离,批次 5a.5 T1)", () => {
  it("① prompt(raw, {contextBlock}):Pi session 收 enriched 全文,messages 表 user content == raw", async () => {
    const raw = "MARK-RAW-今天喝什么茶";
    const ctx = "# Relevant Memories\n- [fact] MARK-CTX-用户喜欢普洱";
    __cap.sessionPrompts.length = 0;

    // 新契约签名;旧代码 prompt(text) 在运行时忽略第二参 → 下方 session 断言红
    await kernel.prompt(raw, { contextBlock: ctx });

    // Pi session 收到 contextBlock + 分隔 + raw(记忆能力保留,只进 Pi JSONL)
    expect(__cap.sessionPrompts.at(-1)).toBe(`${ctx}\n\n---\n\nUser: ${raw}`);
    // sansheng messages 表持久化 raw 原文(UI 历史不再出现 blob)
    expect(lastUserContent()).toBe(raw);
  }, 20_000);

  it("② prompt 不带 contextBlock:session 与落库都是 raw(其它调用方零改动兼容)", async () => {
    const raw = "MARK-PLAIN-随便聊聊";
    __cap.sessionPrompts.length = 0;
    await kernel.prompt(raw);
    expect(__cap.sessionPrompts.at(-1)).toBe(raw);
    expect(lastUserContent()).toBe(raw);
  }, 20_000);

  it("④ ws send:富集经 contextBlock 传递 — 落库 raw、session 含 fact、summary 垃圾不再注入", async () => {
    // seed:同 token 的 fact(应注入)+ 存量 summary 垃圾(应失活)
    const q = "MARKQ-有什么茶推荐";
    insertFragment(storage.db, {
      id: nanoid(),
      kind: "fact",
      content: `${q}-FACT-用户喜欢普洱`,
      sourceConversationId: kernel.getConversationId(),
      sourceMessageId: null,
      importance: 0.6,
      decayFactor: 0.95,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: Date.now(),
      metadata: null,
    });
    insertFragment(storage.db, {
      id: nanoid(),
      kind: "summary",
      content: `${q}-SUMMARY-JUNK-旧回复原文拼接垃圾`,
      sourceConversationId: kernel.getConversationId(),
      sourceMessageId: null,
      importance: 0.4,
      decayFactor: 0.95,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: Date.now(),
      metadata: null,
    });
    __cap.sessionPrompts.length = 0;

    const c = await connectClient();
    try {
      c.send({ type: "send", content: q });
      await waitForEvent(c, "agent_end", { timeoutMs: 6_000 });

      const enriched = __cap.sessionPrompts.at(-1) ?? "";
      // 记忆能力保留:fact 仍然注入 Pi session 上下文
      expect(enriched).toContain("# Relevant Memories");
      expect(enriched).toContain(`${q}-FACT-用户喜欢普洱`);
      expect(enriched).toContain(`User: ${q}`);
      // 存量失活:summary 垃圾不再进 enriched(RED:旧代码 LIKE 命中即注入)
      expect(enriched).not.toContain("SUMMARY-JUNK");
      // 落库 raw 原文(RED:旧代码存「# Relevant Memories…---User: …」blob)
      expect(lastUserContent()).toBe(q);
    } finally {
      await c.close();
    }
  }, 20_000);
});
