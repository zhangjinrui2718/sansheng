/**
 * 批次 4a · C8 — resume/prompt 并发无互斥 → 孤儿 Pi session
 * (docs/CODE-REVIEW-2026-10-01.md §C8)
 *
 * 缺陷形态:
 *  1. ws.ts 的 load_conversation 与 send 两条 async 链各自
 *     `ensureStarted → resume → prompt`,无互斥:快速切会话+发消息可**并发进
 *     resume/start** → 多条链各自 createPiSession 后覆写 `this.session` →
 *     被覆写的旧 session 永不 dispose(仍持文件句柄/监听器)= 孤儿;
 *     同 id resume 同样覆写不 dispose(resume 仅在换会话时才 disposeSession)。
 *  2. createPiSession 的 8s 超时:timeout 先 reject 后,createPromise 仍在后台
 *     完成 → 产出的 session 无人接收、永不 dispose;成功路径 setTimeout 不
 *     clearTimeout(平白挂住 event loop 8s)。
 *
 * 修复契约(互斥方案论证见 agentKernel.ts enqueueOp 注释):
 *  - FIFO 串行队列覆盖 start/resume/prompt/reset/newConversation/restart;
 *  - resume 无条件 dispose 旧 session(含同 id resume);
 *  - createPiSession 成功/失败都 clearTimeout;失败(超时)后挂尾巴处理器,
 *    迟到的 session 一产出即 dispose;
 *  - `AgentKernelOptions.createSessionTimeoutMs` 测试 seam(生产默认 8000)。
 *
 * harness:vi.mock 替换 createAgentSession(与 ws-lifecycle 同款,唯一 fake 的
 * SDK 组件,追踪 created/disposed);AgentKernel/Storage/SettingsStore/
 * attachWebSocket 全部真实。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";

/* ────────────────────────────────────────────────────────── *
 * Fake Pi session:追踪每个被创建的 session 及其 dispose 状态
 * ────────────────────────────────────────────────────────── */

interface SessionRec {
  id: number;
  disposed: boolean;
}

const __t = vi.hoisted(() => ({
  created: [] as Array<{ id: number; disposed: boolean }>,
  prompts: [] as string[],
  createDelayMs: 10,
  nextId: 1,
  reset() {
    this.created.length = 0;
    this.prompts.length = 0;
    this.nextId = 1;
    this.createDelayMs = 10;
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeSession {
    readonly rec: { id: number; disposed: boolean };
    isIdle = true;
    isStreaming = false;
    private listeners: Array<(ev: unknown) => void> = [];

    constructor() {
      this.rec = { id: __t.nextId++, disposed: false };
      __t.created.push(this.rec);
    }

    subscribe(listener: (ev: unknown) => void): () => void {
      this.listeners.push(listener);
      return () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      };
    }

    /** 回放最小 Pi 事件流(与 ws-lifecycle mock 同款),并记录 prompt 全文 */
    async prompt(text: string): Promise<void> {
      __t.prompts.push(text);
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
      this.rec.disposed = true;
      this.listeners = [];
    }
  }
  return {
    createAgentSession: async () => {
      if (__t.createDelayMs > 0) {
        await new Promise((r) => setTimeout(r, __t.createDelayMs));
      }
      return { session: new FakeSession() };
    },
    DefaultResourceLoader: class {
      async reload(): Promise<void> {}
    },
  };
});

import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { attachWebSocket } from "../../src/server/ws.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage, upsertConversation } from "../../src/server/storage/index.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────────────────────────────────── *
 * 真实栈构造(每测试独立临时目录)
 * ────────────────────────────────────────────────────────── */

interface Stack {
  dataDir: string;
  storage: Storage;
  settingsStore: SettingsStore;
  kernel: AgentKernel;
}

const tmpDirs: string[] = [];
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;
let savedDecideLlm: string | undefined;
let savedSediment: string | undefined;

beforeAll(() => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  savedDecideLlm = process.env.SANSHENG_DECIDE_LLM;
  savedSediment = process.env.SANSHENG_SEDIMENT;
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DECIDE_LLM = "0";
  process.env.SANSHENG_SEDIMENT = "0";
});

afterAll(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("PI_OFFLINE", savedPiOffline);
  restore("SANSHENG_DATA", savedSanshengData);
  restore("SANSHENG_DECIDE_LLM", savedDecideLlm);
  restore("SANSHENG_SEDIMENT", savedSediment);
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const liveKernels: AgentKernel[] = [];
afterEach(() => {
  for (const k of liveKernels.splice(0)) {
    try {
      k.invalidate();
    } catch {
      /* ignore */
    }
  }
});

function makeStack(kernelOpts: Record<string, unknown> = {}): Stack {
  const dataDir = mkdtempSync(join(tmpdir(), "sansheng-c8-conc-"));
  tmpDirs.push(dataDir);
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-c8",
        label: "c8-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-c8-test-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-c8",
    cwd: dataDir,
    personaName: "三生-c8",
  });
  // 预置两个可 resume 的会话
  upsertConversation(storage.db, { id: "conv-a", cwd: dataDir, modelId: "gpt-4o-mini", provider: "openai" });
  upsertConversation(storage.db, { id: "conv-b", cwd: dataDir, modelId: "gpt-4o-mini", provider: "openai" });

  const kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage, kernelOpts);
  liveKernels.push(kernel);
  return { dataDir, storage, settingsStore, kernel };
}

function currentRec(kernel: AgentKernel): SessionRec | null {
  const s = kernel.getSession() as unknown as { rec?: SessionRec } | null;
  return s?.rec ?? null;
}

function orphans(kernel: AgentKernel, created: SessionRec[]): SessionRec[] {
  const cur = currentRec(kernel);
  return created.filter((rec) => !rec.disposed && rec !== cur);
}

/* ────────────────────────────────────────────────────────── *
 * 用例
 * ────────────────────────────────────────────────────────── */

describe("C8 · resume/prompt 互斥(内核层)", () => {
  it("并发 resume(c1)+prompt+resume(c2) 快速交替 → 无孤儿 session,末次 resume 生效", async () => {
    __t.reset();
    const { kernel } = makeStack();
    const mark = __t.created.length;

    // 复现审查形态:三条 async 链同 tick 发起,互不等待
    const p1 = kernel.resume("conv-a");
    const p2 = kernel.prompt("hello there");
    const p3 = kernel.resume("conv-b");
    await Promise.allSettled([p1, p2, p3]);
    await sleep(80);

    const created = __t.created.slice(mark);
    // RED(修复前):三条链各自 createPiSession 覆写 this.session → ≥1 个未 dispose 孤儿
    expect(orphans(kernel, created), `孤儿 session(created=${created.length})`).toHaveLength(0);
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(kernel.getConversationId()).toBe("conv-b");
    // 存活 session = 最后创建的那个
    expect(currentRec(kernel)?.id).toBe(created[created.length - 1]?.id);
  });

  it("同 id 重复 resume 也不泄漏:旧 session 必被 dispose", async () => {
    __t.reset();
    const { kernel } = makeStack();
    const mark = __t.created.length;
    await kernel.resume("conv-a");
    await kernel.resume("conv-a"); // 同 id:修复前不 dispose 直接覆写 → 孤儿
    await sleep(30);
    const created = __t.created.slice(mark);
    expect(created).toHaveLength(2);
    expect(orphans(kernel, created)).toHaveLength(0);
  });

  it("createPiSession 超时 → 迟到成功的 session 被 dispose(不产孤儿)", async () => {
    __t.reset();
    __t.createDelayMs = 120; // 创建耗时 > 超时阈值
    const { kernel } = makeStack({ createSessionTimeoutMs: 30 });
    const mark = __t.created.length;

    let err: unknown = null;
    try {
      await kernel.start();
    } catch (e) {
      err = e;
    }
    // RED(修复前):createSessionTimeoutMs seam 不存在 → 8s 硬编码 → 120ms 的创建
    // 先于超时完成 → start 成功(err=null)
    expect(err, "超时 seam 应生效:start 必须以 timeout 拒绝").toBeInstanceOf(Error);
    expect((err as Error)?.message).toMatch(/timeout/i);

    // 迟到孤儿:createPromise 在超时后仍在后台完成 → 必须被 dispose
    await sleep(300);
    const created = __t.created.slice(mark);
    expect(created).toHaveLength(1);
    // RED(修复前,即便走到超时路径):无尾巴处理器 → 迟到 session 永不 dispose
    expect(created[0]?.disposed, "迟到 session 应被 dispose").toBe(true);
    expect(currentRec(kernel)).toBeNull();
  });

  it("成功路径 clearTimeout:start 完成后无遗留 timeout 定时器", async () => {
    __t.reset();
    __t.createDelayMs = 0;
    const { kernel } = makeStack();
    vi.useFakeTimers();
    try {
      const before = vi.getTimerCount();
      await kernel.start();
      // RED(修复前):createPiSession 的 8s setTimeout 从不 clear → 残留 1 个定时器
      expect(vi.getTimerCount(), "start 成功后不应残留 timeout 定时器").toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("C8 · ws 层快速切会话+发消息(批次 3 F3 路径交互)", () => {
  it("load_conversation ∥ send 4 连发 → 无孤儿 session,两条消息都到达 Pi,终态会话=conv-b", async () => {
    __t.reset();
    const { kernel, storage, settingsStore, dataDir } = makeStack();
    const httpServer: Server = createServer();
    let wss: WebSocketServer | null = null;
    let ws: WebSocket | null = null;
    try {
      wss = attachWebSocket(httpServer, kernel, { storage, settingsStore, dataDir });
      await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
      const port = (httpServer.address() as AddressInfo).port;

      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws?.once("open", () => resolve());
        ws?.once("error", (e) => reject(e));
      });
      const markCreated = __t.created.length;
      const markPrompts = __t.prompts.length;

      // 复现「快速切会话+发消息」:4 条命令连发,互不等待
      ws.send(JSON.stringify({ type: "load_conversation", conversationId: "conv-a" }));
      ws.send(JSON.stringify({ type: "send", content: "first message", conversationId: "conv-a" }));
      ws.send(JSON.stringify({ type: "load_conversation", conversationId: "conv-b" }));
      ws.send(JSON.stringify({ type: "send", content: "second message", conversationId: "conv-b" }));

      await sleep(1500);

      const created = __t.created.slice(markCreated);
      // RED(修复前):连接触发 start 与 load_conversation 的 resume、send 的
      // ensureStarted/prompt 多链并发覆写 this.session → 孤儿
      expect(orphans(kernel, created), `孤儿 session(created=${created.length})`).toHaveLength(0);
      expect(kernel.getConversationId()).toBe("conv-b");
      // 互斥不丢消息:两条用户消息都真实到达 Pi session.prompt
      const prompts = __t.prompts.slice(markPrompts);
      expect(prompts.some((t) => t.includes("first message")), "first message 应到达 Pi").toBe(true);
      expect(prompts.some((t) => t.includes("second message")), "second message 应到达 Pi").toBe(true);
    } finally {
      try {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
      } catch { /* ignore */ }
      try { wss?.close(); } catch { /* ignore */ }
      httpServer.closeAllConnections?.();
      await new Promise<void>((r) => httpServer.close(() => r()));
      try { storage.close(); } catch { /* ignore */ }
    }
  });
});
