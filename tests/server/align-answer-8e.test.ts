/**
 * 批次 8-E · 对齐问答闭环(由一次实机事故写进来)
 *
 * 事故:`conv_murrw192_wxbg`(2026-10-03)。用户要一份「催收外呼语音机器人方案」,
 * 沟通员在 t=3 与 t=6 **两次**对用户说「已交给规划链路,会展开:架构图、模块拆解…」,
 * 而整场对话的工件是 `{ insight: 9 }` —— **intent / todo / evidence 全为 0**。
 * 用户等了好几轮,什么也没等到。
 *
 * 复盘出的三处机制缺陷,本文件逐条钉死:
 *
 *  E1 **答完即开工**:闸门问过之后,用户的回答是「C 端个人逾期用户」这种纯答案 ——
 *     没有指令动词,decide 的四选一必然落到 chat,于是永远等不到「开始吧」。
 *     现在 pendingTask 存在时,除非用户明说不要了,一律直接走 task 并跳过闸门。
 *  E2 **闸门不重复**:同一个问题被换了个措辞又问了一遍(用户当场质问「上下文清空了吗」)。
 *     现在是**代码层**去重(pendingTask 存在就不再问),不靠模型自觉。
 *  E3 **不许口头交付**:沟通员主提示词写明「你现在在直接回话,就说明系统没有派活」。
 *
 * harness 参照 align-gate.test.ts:只 fake Pi SDK 的 createAgentSession,
 * kernel / ws / Communicator / Storage 全部生产代码。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketServer } from "ws";

const __cap = vi.hoisted(() => ({
  plannerCalls: [] as string[],
  alignCalls: [] as string[],
  decideCalls: [] as string[],
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
      const fire = (ev: unknown) => {
        for (const l of [...this.listeners]) l(ev);
      };
      void text;
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
import { Keyring, Storage } from "../../src/server/storage/index.js";
import { BUILTIN_PROMPTS } from "../../src/server/harness/promptUnits.js";

interface LlmInput {
  systemPrompt: string;
  userPrompt: string;
}

// planner 的输出:一个最小 todo DAG(8-E 只关心「有没有被叫起来」)
async function planChainLlmCall(input: LlmInput): Promise<string> {
  if (input.systemPrompt.includes("Planner")) {
    __cap.plannerCalls.push(input.userPrompt);
    return JSON.stringify([{ id: "ag-todo", title: "t", body: "b", dependsOn: [] }]);
  }
  return JSON.stringify({ outcome: "evidence", evidence: { title: "e", body: "b" } });
}

const stacks: Array<{
  dataDir: string;
  storage: Storage;
  kernel: AgentKernel;
  httpServer: Server;
  wss: WebSocketServer;
}> = [];

async function makeStack(opts: { decide: (i: LlmInput) => Promise<string>; align: (i: LlmInput) => Promise<string> }) {
  const dataDir = mkdtempSync(join(tmpdir(), "sansheng-8e-"));
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-8e",
        label: "8e-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-8e-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-8e",
    cwd: dataDir,
    personaName: "三生-8e",
  });
  const classify = async (input: LlmInput) => {
    if (input.systemPrompt.includes("对齐检查")) {
      __cap.alignCalls.push(input.userPrompt);
      return opts.align(input);
    }
    __cap.decideCalls.push(input.userPrompt);
    return opts.decide(input);
  };
  const kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage, {
    decideLlmCall: classify,
    alignLlmCall: classify,
  });
  const httpServer = createServer();
  const wss = attachWebSocket(httpServer, kernel, {
    storage,
    settingsStore,
    dataDir,
    llmCallFactory: () => planChainLlmCall,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  stacks.push({ dataDir, storage, kernel, httpServer, wss });
  return { storage, kernel };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resetCap(): void {
  __cap.plannerCalls.length = 0;
  __cap.alignCalls.length = 0;
  __cap.decideCalls.length = 0;
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

const TASK_DECIDE = async () =>
  JSON.stringify({ kind: "task", taskGoal: "产出一份催收外呼语音机器人方案", ack: "收到，已启动。" });
const ASK_Q = async () =>
  JSON.stringify({ question: "外呼对象是 C 端个人逾期用户,还是 B 端企业欠款?" });
// **复刻事故**:用户的回答被判成 chat(实机就是如此)
const CHAT_DECIDE = async () => JSON.stringify({ kind: "chat" });

describe("批次 8-E · 对齐问答闭环", () => {
  it("E1 用户回答对齐问题后直接开工,即使 decide 判成 chat(事故复现)", async () => {
    resetCap();
    const { kernel } = await makeStack({ decide: TASK_DECIDE, align: ASK_Q });
    await kernel.start();

    // 第一轮:decide=task → 闸门提问
    await kernel.prompt("帮我出一份催收外呼语音机器人的方案");
    await sleep(200);
    expect(__cap.alignCalls).toHaveLength(1);
    expect(__cap.plannerCalls).toHaveLength(0);

    // 第二轮:用户**只答了问题**,decide 判 chat(事故现场)
    resetCap();
    await kernel.prompt("C 端个人逾期用户");
    await sleep(300);

    expect(__cap.plannerCalls.length, "planner 应该被叫起来").toBeGreaterThan(0);
    // E2:闸门**不能**再问一遍(事故里问了两遍)
    expect(__cap.alignCalls, "同一问题不该问第二次").toHaveLength(0);
  });

  it("E1b decide 的输入里带着「用户正在回答我的问题」这个前提", async () => {
    resetCap();
    const { kernel } = await makeStack({ decide: TASK_DECIDE, align: ASK_Q });
    await kernel.start();
    await kernel.prompt("帮我出一份催收外呼语音机器人的方案");
    await sleep(200);
    resetCap();
    await kernel.prompt("C 端个人逾期用户");
    await sleep(200);
    const last = __cap.decideCalls.at(-1) ?? "";
    expect(last).toContain("[当前状态]");
    expect(last).toContain("外呼对象是 C 端个人逾期用户");
  });

  it("E1 逃生舱:用户明说「算了不做了」→ 不开工", async () => {
    resetCap();
    const { kernel } = await makeStack({ decide: TASK_DECIDE, align: ASK_Q });
    await kernel.start();
    await kernel.prompt("帮我出一份催收外呼语音机器人的方案");
    await sleep(200);
    resetCap();
    await kernel.prompt("算了,先不做了");
    await sleep(250);
    expect(__cap.plannerCalls, "用户收回了,不该开工").toHaveLength(0);
  });

  it("E3 沟通员主提示词明写「不许口头交付」", () => {
    const prompt = BUILTIN_PROMPTS.communicator;
    expect(prompt).toContain("不许口头交付");
    expect(prompt).toContain("已交给规划链路");
    expect(prompt).toContain("系统没有派活");
  });
});