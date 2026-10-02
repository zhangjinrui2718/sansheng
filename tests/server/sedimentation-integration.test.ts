/**
 * 批次 5b-2 · T1 — 回合后异步智能沉淀(kernel 集成)
 *
 * 契约:
 *  ① chat 回合 Pi message_end 之后触发沉淀(注入 sedimentLlmCall seam):
 *     LLM 输入含本轮 user raw + assistant 回复;产物落 blackboard storage
 *     (conversation scope)+ artifact_created 经 WS 到达客户端(UI 已能消费)。
 *  ④ task 的合成 ack turn **不触发**沉淀(只有 Pi 真回复触发)。
 *  ⑥ 沉淀 LLM 抛错不影响主路径:.catch 守护(审查 C1 教训),chat 回合正常
 *     完成,无 unhandledRejection。
 *  卫生:tests/setup-env.ts 全局 SANSHENG_SEDIMENT=0 —— 未注入 seam 的既有
 *  37 个测试文件零沉淀调用;本文件注入 seam(绕过闸门,显式测试意图)。
 *
 * harness 参照 task-single-path.test.ts:唯一 fake 的 SDK 组件 = createAgentSession;
 * kernel/ws/Communicator/Storage/artifactBus 全部生产代码。
 * 临时目录,不碰真实 ~/.sansheng;PI_OFFLINE=1 不触网。
 *
 * RED 基线(6fca0e2):AgentKernelOptions 无 sedimentLlmCall(第 5 构造参数被忽略)
 * → I1 的沉淀调用/artifact_created 永不到达;I2/I3 为守护(基线也绿)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";

/* ── Fake Pi session(echo 直答,产 message_end = 沉淀触发点)── */
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
import { Keyring, Storage } from "../../src/server/storage/index.js";
import { listArtifacts } from "../../src/server/storage/repo/blackboards.js";

interface LlmInput {
  systemPrompt: string;
  userPrompt: string;
}

/* ── Fake plan-chain LLM(task 用例走 runPlan 用)── */
async function recordingLlmCall(input: LlmInput): Promise<string> {
  if (input.systemPrompt.includes("Planner")) {
    return JSON.stringify([{ id: "sed-1", title: "sed todo", body: "b", dependsOn: [] }]);
  }
  return JSON.stringify({ outcome: "evidence", evidence: { title: "sed done", body: "ok" } });
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
  sedimentLlmCall?: (input: LlmInput) => Promise<string>;
}): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), "sansheng-sed-int-"));
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers:
      opts.providers === "fake-key"
        ? [
            {
              id: "p-sed",
              label: "sed-test",
              provider: "openai",
              modelId: "gpt-4o-mini",
              apiKey: "sk-sed-test-fake",
              thinkingLevel: "off",
            },
          ]
        : [],
    activeProviderId: opts.providers === "fake-key" ? "p-sed" : "",
    cwd: dataDir,
    personaName: "三生-sed",
  });
  const kernelOpts: Record<string, unknown> = {};
  if (opts.decideLlmCall) kernelOpts.decideLlmCall = opts.decideLlmCall;
  if (opts.sedimentLlmCall) kernelOpts.sedimentLlmCall = opts.sedimentLlmCall;
  // 批次 5b-2 seam:第 5 构造参数(基线忽略 sedimentLlmCall → I1 RED)
  const kernel = new AgentKernel(
    settingsStore,
    join(dataDir, "pi"),
    dataDir,
    storage,
    kernelOpts as never,
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
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeAll(() => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  process.env.PI_OFFLINE = "1";
  process.on("unhandledRejection", onUnhandled);
});

afterAll(async () => {
  process.off("unhandledRejection", onUnhandled);
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

/* ── ws client helper(与 task-single-path 同构)── */
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

/* ────────────────────────────────────────────────────────── */

describe("batch5b-2 T1 · 回合后异步沉淀(kernel 集成)", () => {
  it("I1: chat 回合 message_end → sedimentLlmCall 收到本轮转录 → artifact 落库 + WS artifact_created", async () => {
    const sedimentInputs: LlmInput[] = [];
    const stack = await makeStack({
      providers: "fake-key",
      sedimentLlmCall: async (input) => {
        sedimentInputs.push(input);
        return JSON.stringify({
          artifacts: [
            {
              kind: "note",
              title: "SED-MARK-A 用户关注数据库备份",
              body: "讨论中确认备份策略为每日全量。",
            },
          ],
        });
      },
    });
    await stack.kernel.start();
    __cap.sessionPrompts.length = 0;

    const c = await connectClient(stack);
    try {
      const raw = "聊聊备份策略 SED-MARK-A";
      c.send({ type: "send", content: raw, conversationId: stack.kernel.getConversationId() });
      // chat 直答完成(FakeSession echo)
      await waitForEvent(c, "delta", { timeoutMs: 8_000, where: (e) => e.text.includes("echo:") });
      await waitForEvent(c, "agent_end", { timeoutMs: 3_000 });

      // 沉淀异步触发(RED 基线:seam 被忽略 → 永不调用)
      await vi.waitFor(() => expect(sedimentInputs.length).toBe(1), { timeout: 5_000 });
      expect(sedimentInputs[0]!.userPrompt).toContain(raw);
      expect(sedimentInputs[0]!.userPrompt).toContain("echo:");

      // artifact_created 经 WS 到达客户端(metadata.source=sedimentation)
      const ev = await waitForEvent(c, "artifact_created", {
        timeoutMs: 5_000,
        where: (e) => e.artifact.metadata?.source === "sedimentation",
      });
      expect(ev.artifact.scope).toBe("conversation");
      expect(ev.artifact.conversationId).toBe(stack.kernel.getConversationId());
      expect(ev.artifact.title).toContain("SED-MARK-A");

      // blackboard storage 落库
      const stored = listArtifacts(stack.storage.db, {
        scope: "conversation",
        conversationId: stack.kernel.getConversationId(),
        limit: 50,
      });
      expect(stored.some((a) => a.id === ev.artifact.id)).toBe(true);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("I4: task 的合成 ack turn 不触发沉淀(decide=task → runPlan,零沉淀调用)", async () => {
    const sedimentInputs: LlmInput[] = [];
    const stack = await makeStack({
      providers: "fake-key",
      decideLlmCall: async () =>
        JSON.stringify({ kind: "task", taskGoal: "TG-SED-B 重构目标", ack: "收到,已转入规划执行链路。" }),
      sedimentLlmCall: async (input) => {
        sedimentInputs.push(input);
        return JSON.stringify({ artifacts: [] });
      },
    });
    await stack.kernel.start();

    const c = await connectClient(stack);
    try {
      c.send({
        type: "send",
        content: "帮我重构 SED-MARK-B 模块",
        conversationId: stack.kernel.getConversationId(),
      });
      // 交接确认 + plan 链路跑完(fake planner/executor)
      await waitForEvent(c, "delta", { timeoutMs: 6_000, where: (e) => e.text.includes("规划执行链路") });
      await waitForEvent(c, "plan_done", { timeoutMs: 10_000 });
      // 合成 ack turn 走 prompt() 内 closeAckTurn(不经 Pi handler message_end)→ 零沉淀
      await sleep(300);
      expect(sedimentInputs).toHaveLength(0);
      const stored = listArtifacts(stack.storage.db, {
        scope: "conversation",
        conversationId: stack.kernel.getConversationId(),
        limit: 50,
      });
      expect(stored.some((a) => a.metadata?.source === "sedimentation")).toBe(false);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("I6: 沉淀 LLM 抛错 → .catch 守护:chat 回合正常完成,无 unhandledRejection,进程不崩", async () => {
    const stack = await makeStack({
      providers: "fake-key",
      sedimentLlmCall: async () => {
        throw new Error("SED-BOOM 沉淀服务故障");
      },
    });
    await stack.kernel.start();
    const before = unhandled.length;

    const c = await connectClient(stack);
    try {
      c.send({ type: "send", content: "随便聊聊 SED-MARK-C", conversationId: stack.kernel.getConversationId() });
      await waitForEvent(c, "delta", { timeoutMs: 8_000, where: (e) => e.text.includes("echo:") });
      await waitForEvent(c, "agent_end", { timeoutMs: 3_000 });
      await sleep(300); // 给 fire-and-forget 沉淀链路时间落地(抛错 → 被 .catch 吃掉)
      expect(unhandled.length).toBe(before); // 无新增 unhandled rejection(审查 C1)
      // 主路径不受影响:后续消息照常
      c.send({ type: "send", content: "再来一条 SED-MARK-D", conversationId: stack.kernel.getConversationId() });
      await waitForEvent(c, "delta", {
        timeoutMs: 8_000,
        where: (e) => e.text.includes("SED-MARK-D"),
      });
    } finally {
      await c.close();
    }
  }, 40_000);
});
