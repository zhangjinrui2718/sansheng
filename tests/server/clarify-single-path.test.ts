/**
 * 批次 7-C · clarify 路径的 kernel 端到端契约。
 *
 * 用户反馈:「我说一句话,他就直接委派指令去了,并没有和我充分对齐我想要什么」。
 * 修复引入 decide 的第四类 `clarify`(需求没说清 → 先问一个关键问题,不委派)。
 *
 * 本文件锁死三件事,前两件最容易出错:
 *  ① **不委派**:onTask 不触发,planner / runPlan 一次都不被调;
 *  ② **不双回复**:clarify 走的是「不走 Pi 直答」那一支 —— 若在 promptInner
 *     漏掉 early return,就会「沟通员问了一个问题」+「Pi 把用户原话又答一遍」
 *     两条,正是 §B2 治过的双回复病。探针 = FakeSession 的 sessionPrompts 必须为空;
 *  ③ **落库**:raw 用户原文 + 沟通员的问题各一条,刷新后历史完整。
 *
 * harness 参照 task-single-path.test.ts:唯一 fake 的 SDK 组件是
 * createAgentSession(FakeSession 捕获 session.prompt);runPlan / Orchestrator /
 * Communicator / Storage / attachWebSocket 全部生产代码。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketServer } from "ws";

/* ── Fake Pi session:session.prompt 被调用 = 发生了不该发生的直答 ── */
const __cap = vi.hoisted(() => ({
  sessionPrompts: [] as string[],
  plannerCalls: [] as string[],
  executorCalls: [] as string[],
}));

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
      const fire = (ev: unknown) => {
        for (const l of [...this.listeners]) l(ev);
      };
      fire({ type: "agent_start" });
      fire({ type: "message_end", message: { id: "fake", usage: { input: 1, output: 1 } } });
      fire({ type: "agent_end", usage: { input: 1, output: 1, costUsd: 0 } });
    }
    interrupt(): void {}
    dispose(): Promise<void> {
      return Promise.resolve();
    }
    steer(): void {}
    setModel(): void {}
  }
  return {
    createAgentSession: async () => ({ session: new FakeSession() }),
    DefaultResourceLoader: class {},
  };
});

import { attachWebSocket } from "../../src/server/ws.js";
import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import {
  Keyring,
  Storage,
  listMessagesByConversation,
} from "../../src/server/storage/index.js";

interface LlmInput {
  systemPrompt: string;
  userPrompt: string;
}

/** plan 链路 LLM(经 llmCallFactory seam)—— clarify 路径下**一次都不该被调** */
async function planChainLlmCall(input: LlmInput): Promise<string> {
  if (input.systemPrompt.includes("Planner")) {
    __cap.plannerCalls.push(input.userPrompt);
    return JSON.stringify([{ id: "clarify-todo", title: "t", body: "b", dependsOn: [] }]);
  }
  __cap.executorCalls.push(input.userPrompt);
  return JSON.stringify({ outcome: "evidence", evidence: { title: "e", body: "b" } });
}

interface Stack {
  dataDir: string;
  storage: Storage;
  kernel: AgentKernel;
  httpServer: Server;
  wss: WebSocketServer;
  conversationId: string;
}
const stacks: Stack[] = [];

async function makeStack(
  decideLlmCall: (input: LlmInput) => Promise<string>,
): Promise<Stack> {
  const dataDir = mkdtempSync(join(tmpdir(), "sansheng-clarify-"));
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-clarify",
        label: "clarify-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-clarify-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-clarify",
    cwd: dataDir,
    personaName: "三生-clarify",
  });
  const kernel = new AgentKernel(
    settingsStore,
    join(dataDir, "pi"),
    dataDir,
    storage,
    { decideLlmCall },
  );
  const httpServer = createServer();
  const wss = attachWebSocket(httpServer, kernel, {
    storage,
    settingsStore,
    dataDir,
    llmCallFactory: () => planChainLlmCall,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  void (httpServer.address() as AddressInfo).port;
  const conversationId = `conv-clarify-${Math.random().toString(36).slice(2, 8)}`;
  const stack = { dataDir, storage, kernel, httpServer, wss, conversationId };
  stacks.push(stack);
  return stack;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

beforeAll(() => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  process.env.PI_OFFLINE = "1";
  __cap.sessionPrompts.length = 0;
  __cap.plannerCalls.length = 0;
  __cap.executorCalls.length = 0;
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

describe("批次 7-C · clarify:先对齐,再委派", () => {
  it("decide=clarify → 问用户一个问题,不委派 planner、不走 Pi 直答、落库完整", async () => {
    const stack = await makeStack(async () =>
      JSON.stringify({
        kind: "clarify",
        taskGoal: "",
        ack: "",
        question: "你说的『百外』是指面向百万用户规模的业务场景吗?",
      }),
    );

    await stack.kernel.start();
    await stack.kernel.prompt("调研一份能够服务百外用户的语音机器人技术方案");
    await sleep(150);

    // ① 不委派:planner / executor 一次都没被调
    expect(__cap.plannerCalls).toHaveLength(0);
    expect(__cap.executorCalls).toHaveLength(0);

    // ② 不双回复:Pi session.prompt 从未被调
    expect(__cap.sessionPrompts).toHaveLength(0);

    // ③ 落库:raw 用户原文 + 沟通员的问题,各一条
    const msgs = listMessagesByConversation(
      stack.storage.db,
      stack.kernel.getConversationId(),
    );
    const userMsg = msgs.find((m) => m.role === "user");
    const assistantMsg = msgs.find((m) => m.role === "assistant");
    expect(userMsg?.content).toBe("调研一份能够服务百外用户的语音机器人技术方案");
    expect(assistantMsg?.content).toContain("百外");
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("decide=task(信息说清)→ 仍然照旧委派,clarify 不吞掉正常任务", async () => {
    const stack = await makeStack(async () =>
      JSON.stringify({
        kind: "task",
        taskGoal: "重构 X 模块",
        ack: "收到，已转入规划执行链路。",
      }),
    );

    await stack.kernel.start();
    await stack.kernel.prompt("重构 X 模块");
    await sleep(500);

    // task 路径不受影响:planner 被调起
    expect(__cap.plannerCalls.length).toBeGreaterThan(0);
  });
});
