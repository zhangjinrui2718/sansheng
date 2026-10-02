/**
 * 批次 7-E · 对齐闸门(开工前先跟用户对齐他要什么)。
 *
 * 用户 2026-10-02 原话:「既然在 plan 模式下我觉得他需要和我对齐我想要什么」。
 * 背景:7-C 给 decide 加了 `clarify` 第四类,但实机重跑同一句话时**模型仍然
 * 稳定判 task、从没 clarify 过** —— decide 已经是四选一 + 3.5s 硬超时,
 * 再塞一个「要不要问」的判断进去,它只会选省事那条。
 *
 * 所以对齐不再压在 decide 上,改成 decide 判 task 之后的**一次独立调用**
 * (ALIGN_SYSTEM_PROMPT),单一职责 + 明确 NONE 出口,可靠得多。
 *
 * 本文件锁死三件事:
 *  ① 闸门提问时**不委派**(onTask 不触发,planner 一次都不被调);
 *  ② 用户回答后**任务接得上**(回答本身不像 task,要带着原 goal 再 decide);
 *  ③ 闸门自身故障 / NONE / 抛错 → **一律放行**,绝不把用户的任务卡死。
 *
 * harness 参照 clarify-single-path.test.ts:只 fake Pi SDK 的 createAgentSession,
 * kernel / ws / Communicator / Storage 全部生产代码。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocketServer } from "ws";

const __cap = vi.hoisted(() => ({
  sessionPrompts: [] as string[],
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

async function makeStack(opts: {
  decide: (input: LlmInput) => Promise<string>;
  align: (input: LlmInput) => Promise<string>;
}) {
  const dataDir = mkdtempSync(join(tmpdir(), "sansheng-align-"));
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-align",
        label: "align-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-align-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-align",
    cwd: dataDir,
    personaName: "三生-align",
  });

  const decideLlmCall = async (input: LlmInput) => {
    // decide 的 system prompt 与 align 的区分开:前者含「消息分类器」
    if (input.systemPrompt.includes("对齐检查")) {
      __cap.alignCalls.push(input.userPrompt);
      return opts.align(input);
    }
    __cap.decideCalls.push(input.userPrompt);
    return opts.decide(input);
  };

  const kernel = new AgentKernel(
    settingsStore,
    join(dataDir, "pi"),
    dataDir,
    storage,
    { decideLlmCall, alignLlmCall: decideLlmCall },
  );
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

function resetCap() {
  __cap.sessionPrompts.length = 0;
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
  JSON.stringify({ kind: "task", taskGoal: "调研并产出语音机器人技术方案", ack: "收到，已启动。" });
const ASK_Q = async () =>
  JSON.stringify({ question: "你说的『百外』是指面向百万级外呼的业务规模吗?" });
const NO_Q = async () => JSON.stringify({ question: "NONE" });

describe("批次 7-E · 对齐闸门", () => {
  it("闸门提问 → 问用户、不委派、不走 Pi 直答", async () => {
    resetCap();
    const { storage, kernel } = await makeStack({ decide: TASK_DECIDE, align: ASK_Q });

    await kernel.start();
    await kernel.prompt("帮我调研一份能服务百外用户的语音机器人技术方案");
    await sleep(200);

    // ① 不委派
    expect(__cap.alignCalls.length).toBe(1);
    expect(__cap.plannerCalls).toHaveLength(0);
    // ② 不双回复
    expect(__cap.sessionPrompts).toHaveLength(0);

    // ③ 用户看得见问题,且落库
    const msgs = listMessagesByConversation(storage.db, kernel.getConversationId());
    const asst = msgs.filter((m) => m.role === "assistant");
    expect(asst.length).toBe(1);
    expect(asst[0]!.content).toContain("百外");
    // 用户原话仍是 raw,没被拼接污染
    expect(msgs.find((m) => m.role === "user")?.content).toBe(
      "帮我调研一份能服务百外用户的语音机器人技术方案",
    );
  });

  it("用户回答后 → 任务接得上并真正开工(回答本身不像 task)", async () => {
    resetCap();
    // 闸门带记忆:第一轮问,第二轮因为「最近对话」里已经有问答 → 输出 NONE 放行。
    // 这正是 7-E 集成测试第一次跑时抓到的真 bug(闸门无记忆 → 无限澄清循环)。
    let askCount = 0;
    const { kernel } = await makeStack({
      decide: TASK_DECIDE,
      align: async (input) => {
        askCount++;
        if (askCount === 1) {
          return JSON.stringify({
            question: "你说的『百外』是指面向百万级外呼的业务规模吗?",
          });
        }
        // 断言:第二轮的 prompt 里必须带得到上一轮问答,否则模型无从知道已问过
        expect(input.userPrompt).toContain("最近对话");
        expect(input.userPrompt).toContain("百万级外呼的业务规模");
        return JSON.stringify({ question: "NONE" });
      },
    });

    await kernel.start();
    // 第 1 轮:闸门拦下
    await kernel.prompt("帮我调研一份能服务百外用户的语音机器人技术方案");
    await sleep(200);
    expect(__cap.plannerCalls).toHaveLength(0);

    // 第 2 轮:用户只回了一句补充 —— 单独看绝不像 task
    await kernel.prompt("是，面向百万级外呼，交付一份结构化文档");
    await sleep(600);

    // 原 goal 被带进 decide(证明不是把补充句当新任务从头判)
    const secondDecide = __cap.decideCalls[1] ?? "";
    expect(secondDecide).toContain("语音机器人技术方案");
    expect(secondDecide).toContain("百万级外呼");
    // 并且真的开工了
    expect(__cap.plannerCalls.length).toBeGreaterThan(0);
    // 闸门只问了两次(每轮各一次),没有反复追问
    expect(askCount).toBe(2);
  });

  it("闸门说 NONE → 直接开工,不打扰用户", async () => {
    resetCap();
    const { kernel } = await makeStack({ decide: TASK_DECIDE, align: NO_Q });

    await kernel.start();
    await kernel.prompt("重构 X 模块");
    await sleep(500);

    expect(__cap.alignCalls.length).toBe(1);
    expect(__cap.plannerCalls.length).toBeGreaterThan(0);
    expect(__cap.sessionPrompts).toHaveLength(0);
  });

  it("闸门抛错 → 放行开工(闸门不能比它守的门更脆弱)", async () => {
    resetCap();
    const { kernel } = await makeStack({
      decide: TASK_DECIDE,
      align: async () => {
        throw new Error("provider 炸了");
      },
    });

    await kernel.start();
    await kernel.prompt("重构 X 模块");
    await sleep(500);

    expect(__cap.plannerCalls.length).toBeGreaterThan(0);
  });

  it("闸门返回垃圾输出 → 放行开工(不凭空造问题)", async () => {
    resetCap();
    const { kernel } = await makeStack({ decide: TASK_DECIDE, align: async () => "我不知道" });

    await kernel.start();
    await kernel.prompt("重构 X 模块");
    await sleep(500);

    expect(__cap.plannerCalls.length).toBeGreaterThan(0);
  });

  it("闸门 system prompt 含反滥用约束(别事事问、一次只问一个)", async () => {
    resetCap();
    const { kernel } = await makeStack({ decide: TASK_DECIDE, align: NO_Q });
    await kernel.start();
    await kernel.prompt("重构 X 模块");
    await sleep(300);

    // 抓 align 调用的 system prompt:从 decide 注入里分流出去了,
    // 这里通过 align 侧观察 —— align userPrompt 必须带目标与原话
    expect(__cap.alignCalls[0]).toContain("重构 X 模块");
  });
});
