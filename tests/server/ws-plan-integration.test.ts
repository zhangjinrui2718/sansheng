/**
 * Sansheng · /plan 主链路集成测试(批次 1 验收防线)
 *
 * 来源:docs/CODE-REVIEW-2026-10-01.md §E —
 *   「补一组走真实 ws.ts attachWebSocket + 真实 Orchestrator 的集成测试
 *     (fake llmCall 可以保留,但闭包/生命周期必须是生产代码路径)」
 *
 * 真实组件:attachWebSocket + ws.ts runPlan 闭包 + AgentKernel(真实 Pi session,
 * PI_OFFLINE=1)+ Orchestrator/Planner/Executor + Storage(临时目录 SQLite)+ ws client。
 * 唯一 fake:llmCall,经 attachWebSocket 的 llmCallFactory DI seam 注入(生产默认 makeLlmCall)。
 *
 * 回归覆盖(4 个 P0):
 *  ① 无依赖 plan 完成 → 客户端收到 plan_done          (A1:TDZ 崩溃/永久挂起)
 *  ② 两级 dependsOn 计划按序全部 resolve → plan_done   (A3:"*" 通配恒空 → DAG 永不解锁)
 *  ③ 连续两次 plan → planner fake 每个 plan 恰好 1 次  (A2:僵尸 Orchestrator 重复消费)
 *  ④ executor callback → answer_question → resume 后
 *    executor 第二次 prompt 含 decision.body 原文       (A4:decision 内容不达 resumed executor)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type WebSocketServer } from "ws";
import { attachWebSocket } from "../../src/server/ws.js";
import { AgentKernel, type ServerEvent } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";

/* ────────────────────────────────────────────────────────── *
 * Fake LLM(唯一允许 fake 的组件)
 * ────────────────────────────────────────────────────────── */

interface LlmInput {
  systemPrompt: string;
  userPrompt: string;
}

/** 全部 planner prompt(userPrompt)按调用顺序记录 */
const plannerPrompts: string[] = [];
/** 全部 executor prompt(userPrompt)按调用顺序记录 */
const executorPrompts: string[] = [];

/** 每个场景重写这个函数来决定 fake 行为 */
let fakeLlm: (input: LlmInput) => Promise<string> = async () => {
  throw new Error("fakeLlm not configured for current scenario");
};

function isPlannerInput(input: LlmInput): boolean {
  return input.systemPrompt.includes("Planner");
}

/** 注入到 attachWebSocket 的 recording fake(生产路径为 makeLlmCall) */
function recordingLlmCall(input: LlmInput): Promise<string> {
  if (isPlannerInput(input)) plannerPrompts.push(input.userPrompt);
  else executorPrompts.push(input.userPrompt);
  return fakeLlm(input);
}

/* ────────────────────────────────────────────────────────── *
 * 真实 server 栈(临时目录,整个文件共享一套;每场景新建 ws 连接)
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
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-ws-plan-it-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;

  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-it",
        label: "integration-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-integration-test-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-it",
    cwd: dataDir,
    personaName: "三生-it",
  });

  // 真实 kernel:启动真实 Pi session(PI_OFFLINE=1,不触网)。
  // 场景④依赖 start() 里 ensureCommunicator 建出的 Communicator
  // (routeCallback → kernel.handleExecutorCallback → pending_question 的生产路径)。
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  await kernel.start(() => {});
  expect(kernel.getCommunicator()).toBeTruthy();

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
 * 真实 ws client helper
 * ────────────────────────────────────────────────────────── */

interface TestClient {
  readonly events: ServerEvent[];
  send(cmd: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function connectClient(): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events: ServerEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
  });
  ws.on("message", (raw) => {
    events.push(JSON.parse(raw.toString()) as ServerEvent);
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
  const timeoutMs = opts.timeoutMs ?? 15_000;
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
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ────────────────────────────────────────────────────────── *
 * 场景
 * ────────────────────────────────────────────────────────── */

describe("ws /plan integration (real attachWebSocket + runPlan + Orchestrator + Storage)", () => {
  it("① 无依赖 plan 完成 → 客户端收到 plan_done(A1 回归)", async () => {
    plannerPrompts.length = 0;
    executorPrompts.length = 0;
    fakeLlm = async (input) => {
      if (isPlannerInput(input)) {
        return JSON.stringify([
          { id: "it1-t1", title: "第一步", body: "单步任务", dependsOn: [] },
        ]);
      }
      return JSON.stringify({
        outcome: "evidence",
        evidence: { title: "it1 done", body: "已完成" },
      });
    };

    const c = await connectClient();
    try {
      c.send({ type: "plan", goal: "集成①:无依赖计划", conversationId: "conv-it-1" });
      const done = await waitForEvent(c, "plan_done");
      expect(done.conversationId).toBe("conv-it-1");
      expect(done.intentId).toBeTruthy();
      expect(done.summary).toContain("完成 1/1");
      expect(
        (done.artifacts ?? []).some((a) => a.id === "it1-t1" && a.status === "resolved"),
      ).toBe(true);
    } finally {
      await c.close();
    }
  }, 30_000);

  it("② 两级 dependsOn 计划按序全部 resolve → plan_done(A3 回归)", async () => {
    plannerPrompts.length = 0;
    executorPrompts.length = 0;
    fakeLlm = async (input) => {
      if (isPlannerInput(input)) {
        return JSON.stringify([
          { id: "it2-a", title: "上游", body: "先做", dependsOn: [] },
          { id: "it2-b", title: "下游", body: "后做", dependsOn: ["it2-a"] },
        ]);
      }
      if (input.userPrompt.includes("id: it2-a")) {
        return JSON.stringify({ outcome: "evidence", evidence: { title: "a done", body: "ok" } });
      }
      return JSON.stringify({ outcome: "evidence", evidence: { title: "b done", body: "ok" } });
    };

    const c = await connectClient();
    try {
      c.send({ type: "plan", goal: "集成②:两级依赖计划", conversationId: "conv-it-2" });
      const done = await waitForEvent(c, "plan_done", { timeoutMs: 20_000 });
      expect(done.summary).toContain("完成 2/2");
      const artifacts = done.artifacts ?? [];
      expect(artifacts.some((a) => a.id === "it2-a" && a.status === "resolved")).toBe(true);
      // A3 核心:下游 todo 必须被解锁并 resolve(通配符 bug 下永远不会发生)
      expect(artifacts.some((a) => a.id === "it2-b" && a.status === "resolved")).toBe(true);

      // 执行顺序:it2-a 的第一次 executor 调用必须早于 it2-b 的第一次
      const firstA = executorPrompts.findIndex((p) => p.includes("id: it2-a"));
      const firstB = executorPrompts.findIndex((p) => p.includes("id: it2-b"));
      expect(firstA).toBeGreaterThanOrEqual(0);
      expect(firstB).toBeGreaterThan(firstA);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("③ 连续两次 plan → planner 每个 plan 恰好被调 1 次(A2 回归:无僵尸重复消费)", async () => {
    plannerPrompts.length = 0;
    executorPrompts.length = 0;
    const goalA = "集成③:plan-A-unique";
    const goalB = "集成③:plan-B-unique";
    fakeLlm = async (input) => {
      if (isPlannerInput(input)) {
        if (input.userPrompt.includes("plan-A-unique")) {
          return JSON.stringify([{ id: "it3-a1", title: "A1", body: "a", dependsOn: [] }]);
        }
        return JSON.stringify([{ id: "it3-b1", title: "B1", body: "b", dependsOn: [] }]);
      }
      return JSON.stringify({ outcome: "evidence", evidence: { title: "ok", body: "ok" } });
    };

    const c = await connectClient();
    try {
      c.send({ type: "plan", goal: goalA, conversationId: "conv-it-3a" });
      const doneA = await waitForEvent(c, "plan_done", {
        where: (e) => e.conversationId === "conv-it-3a",
      });
      expect(doneA.summary).toContain("完成 1/1");

      // 第一个 plan 结束后立刻发第二个:若前一个 Orchestrator 未 shutdown(僵尸),
      // 它会再次消费 intent-B → planner 被调 2 次;或 activeOrchestrator 未清 → plan_busy。
      c.send({ type: "plan", goal: goalB, conversationId: "conv-it-3b" });
      const doneB = await waitForEvent(c, "plan_done", {
        where: (e) => e.conversationId === "conv-it-3b",
      });
      expect(doneB.summary).toContain("完成 1/1");

      const plannerCallsA = plannerPrompts.filter((p) => p.includes("plan-A-unique")).length;
      const plannerCallsB = plannerPrompts.filter((p) => p.includes("plan-B-unique")).length;
      expect(plannerCallsA).toBe(1);
      expect(plannerCallsB).toBe(1);

      const busy = c.events.filter(
        (e) => e.type === "error" && e.error.code === "plan_busy",
      );
      expect(busy.length).toBe(0);
    } finally {
      await c.close();
    }
  }, 40_000);

  it("④ executor callback → answer_question → resumed executor prompt 含 decision.body 原文(A4 回归)", async () => {
    plannerPrompts.length = 0;
    executorPrompts.length = 0;
    const DECISION_BODY =
      "用 JWT。理由:无状态、可横向扩展、无需服务端 session 存储。MARKER-IT4-7391";
    fakeLlm = async (input) => {
      if (isPlannerInput(input)) {
        return JSON.stringify([
          { id: "it4-q1", title: "需要决策的任务", body: "问用户", dependsOn: [] },
        ]);
      }
      if (input.userPrompt.includes("# Decision")) {
        // resume 重跑:看到用户决策 → 产 evidence 收尾
        return JSON.stringify({
          outcome: "evidence",
          evidence: { title: "it4 done", body: "按用户决策完成" },
        });
      }
      return JSON.stringify({
        outcome: "hypothesis",
        hypothesis: {
          title: "需要用户确认",
          body: "JWT 还是 session?",
          callbackReason: "judgment",
        },
      });
    };

    const c = await connectClient();
    try {
      c.send({ type: "plan", goal: "集成④:阻塞回调计划", conversationId: "conv-it-4" });

      // 生产路径:executor_callback → orchestrator.routeCallback → kernel.handleExecutorCallback
      // → Communicator.handleWorkerAsk(knowIt=false) → pending_question → ws
      const q = await waitForEvent(c, "pending_question");
      expect(q.questionId).toMatch(/^q-exec-/);
      expect(q.conversationId).toBe("conv-it-4");

      // 客户端回答 → kernel.handleUserAnswer → decision artifact(body=payload)+ executor_resume
      c.send({
        type: "answer_question",
        questionId: q.questionId,
        payload: DECISION_BODY,
        conversationId: "conv-it-4",
      });

      // resume 后 executor 第二次被调(跨 ws → kernel → bus → orchestrator → executor 全生产路径)
      await vi.waitFor(
        () => {
          const prompts = executorPrompts.filter((p) => p.includes("id: it4-q1"));
          expect(prompts.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 15_000 },
      );

      const prompts = executorPrompts.filter((p) => p.includes("id: it4-q1"));
      // A4 核心:第二次 prompt 必须携带 decision 的标题段 + 用户回答全文
      expect(prompts[1]).toContain("# Decision");
      expect(prompts[1]).toContain(DECISION_BODY);

      // run 在 resume 闭环后才收尾 → plan_done(完成 1/1)
      const done = await waitForEvent(c, "plan_done", { timeoutMs: 20_000 });
      expect(done.conversationId).toBe("conv-it-4");
      expect(done.summary).toContain("完成 1/1");
    } finally {
      await c.close();
    }
  }, 60_000);
});
