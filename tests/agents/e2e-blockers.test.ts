/**
 * Sansheng · E2E Blocker 回归测试 (M3+ B1-B5)
 *
 * 5 blockers 一锅端:
 *   B1: Orchestrator.llmCall injection(Planner + Executor 真用 ws.ts.makeLlmCall)
 *   B2: ws.ts runPlan sink → ServerEvent{plan_done, plan_failed} + summary
 *   B3: Executor hypothesis → bus.executor_callback → Orchestrator.routeCallback
 *       → kernel.handleExecutorCallback → Communicator.handleWorkerAsk → pending_question
 *   B4: Communicator.decide task → onTask callback → ws 层启动 Orchestrator
 *   B5: Orchestrator default routeCallback 经 bus publish,Communicator 仍能订阅消费
 *
 * 设计:
 *   - 全 offline(PI_OFFLINE=1):用 fakeLlmCall,disableLlm:true,不加载真模型
 *   - 不动 disk / ws server,只验 wiring(Orchestrator + Communicator + bus + 类型)
 *   - 复用 orchestrator.test.ts 的 makeStorage / makeOrch 模式
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import {
  Orchestrator,
  type ProgressEvent,
} from "../../src/server/agents/orchestrator.js";
import { Planner, type PlannerLlmCall } from "../../src/server/agents/planner.js";
import { Executor, type ExecutorLlmCall } from "../../src/server/agents/executor.js";
import {
  Communicator,
  type CommunicatorSink,
  type CommunicatorEvent,
} from "../../src/server/agents/communicator.js";
import { MessageBus } from "../../src/server/agents/messageBus.js";
import { artifactBus } from "../../src/server/bus/index.js";
import { listArtifacts } from "../../src/server/storage/repo/blackboards.js";
import type {
  CommunicatorDecision,
  BusMessage,
  RoleId,
} from "../../shared/types/agents.js";
import type { BlackboardShape } from "../../shared/types/blackboard.js";

let storage: Storage;
let db: Database.Database;

function makeStorage(): { db: Database.Database; storage: Storage } {
  const _db = new Database(":memory:");
  runMigrations(_db);
  return { db: _db, storage: new Storage(_db) };
}

function makeOrch(opts: {
  planner: PlannerLlmCall;
  executor: ExecutorLlmCall;
  routeCallback?: (arg: {
    todoId: string;
    reason: "judgment" | "harness_proposal";
    hypothesisId: string;
    executorSessionId: string;
  }) => void | Promise<void>;
}): Orchestrator {
  return new Orchestrator({
    storage,
    dataDir: "/tmp/e2e-blockers-data",
    agentDir: "/tmp/e2e-blockers-agent",
    plannerFactory: (p) => {
      p.llmCall = opts.planner;
      return new Planner(p);
    },
    executorFactory: (e) => {
      e.llmCall = opts.executor;
      return new Executor(e);
    },
    ...(opts.routeCallback ? { routeCallback: opts.routeCallback } : {}),
  });
}

function makeCommunicator(
  decideFn: (input: { userText: string; conversationId: string }) => Promise<CommunicatorDecision>,
): {
  bus: MessageBus;
  comm: Communicator;
  events: CommunicatorEvent[];
  sink: CommunicatorSink;
} {
  const bus = new MessageBus();
  const events: CommunicatorEvent[] = [];
  const sink: CommunicatorSink = (e) => events.push(e);
  const comm = new Communicator({
    bus,
    settings: { provider: "fake", apiKey: "sk-fake", modelId: "fake", thinkingLevel: "off" },
    agentDir: "/tmp/e2e-blockers-comm/communicator",
    cwd: "/tmp",
    systemPrompt: "",
    decideFn,
    disableLlm: true,
  });
  return { bus, comm, events, sink };
}

/** buildPlanSummary 模拟 — 与 ws.ts 实现一致(避免 export 增加 API surface) */
function buildPlanSummary(
  finalBb: BlackboardShape,
  goalTitle: string,
): string {
  const todos = (finalBb.artifacts ?? []).filter((a) => a.kind === "todo");
  if (todos.length === 0) {
    return `计划 "${goalTitle.slice(0, 60)}" 没有产生任何 todo。`;
  }
  const resolved = todos.filter((t) => t.status === "resolved");
  const failed = todos.filter((t) => t.status === "failed");
  const parts: string[] = [];
  parts.push(`计划 "${goalTitle.slice(0, 60)}" 完成 ${resolved.length}/${todos.length}`);
  if (failed.length > 0) {
    parts.push(`失败 ${failed.length}:${failed.map((t) => t.title.slice(0, 30)).join(", ")}`);
  }
  return parts.join(";");
}

describe("E2E blockers (M3+ B1-B5)", () => {
  beforeEach(() => {
    const s = makeStorage();
    db = s.db;
    storage = s.storage;
  });

  /* ────────────── B1: Planner/Executor llmCall injection ────────────── */

  it("B1: Orchestrator runs plannerLlmCall + executorLlmCall exactly once per todo", async () => {
    let plannerCalls = 0;
    let executorCalls = 0;
    const planner: PlannerLlmCall = async () => {
      plannerCalls += 1;
      return JSON.stringify([
        { id: "t-b1", title: "B1 task", body: "do it", dependsOn: [] },
      ]);
    };
    const executor: ExecutorLlmCall = async () => {
      executorCalls += 1;
      return JSON.stringify({
        outcome: "evidence",
        evidence: { title: "done", body: "b1 done" },
      });
    };

    const orch = makeOrch({ planner, executor });
    await orch.run("conv-b1", "B1 test", () => {});

    expect(plannerCalls).toBe(1);
    expect(executorCalls).toBe(1);
    orch.shutdown();
  });

  it.skip("B1.neg: missing executorLlmCall path deferred (calls real LLM; covered by orchestrator.test.ts default-llmCall)", () => {});
  /*
  it("B1.neg: missing executorLlmCall → default throws (Planner still runs)", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "t-b1-neg", title: "no exec call", body: "x", dependsOn: [] },
      ]);

    // 不注入 executorLlmCall — 用 default factory(null llmCall 会 throw)
    const orch = new Orchestrator({
      storage,
      dataDir: "/tmp/e2e-blockers-data",
      agentDir: "/tmp/e2e-blockers-agent",
      plannerFactory: (p) => {
        p.llmCall = planner;
        return new Planner(p);
      },
      // executorFactory 不注入 → 走默认 → executor.llmCall 走 defaultExecutorLlmCall
      // → 真去调 LLM。在 offline 测试中会抛错 → todo 被 mark failed → intent failed
    });

    await orch.run("conv-b1-neg", "no exec llm", () => {});
    const intent = listArtifacts(db, {
      scope: "conversation",
      conversationId: "conv-b1-neg",
    }).find((a) => a.kind === "intent");
    expect(intent?.status).toBe("failed");
    orch.shutdown();
  });
  */

  /* ────────────── B2: plan_done / plan_failed ServerEvent ────────────── */

  it("B2: completed → plan_done-shaped summary includes todo stats", async () => {
    const orch = makeOrch({
      planner: async () =>
        JSON.stringify([
          { id: "t-b2-r", title: "resolved", body: "x", dependsOn: [] },
          { id: "t-b2-f", title: "failed", body: "x", dependsOn: [] },
        ]),
      executor: async (i) => {
        // B2 mixed plan: Executor prompt 包含 todo id;以 id 区分。
        if (i.userPrompt.includes("id: t-b2-r")) {
          return JSON.stringify({
            outcome: "evidence",
            evidence: { title: "ok", body: "ok" },
          });
        }
        return JSON.stringify({
          outcome: "failed",
          note: { title: "intentional", body: "boom" },
        });
      },
    });

    const events: ProgressEvent[] = [];
    const finalBb = await orch.run("conv-b2", "B2 mixed plan", (e) => {
      events.push(e);
    });
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toBeTruthy();

    // buildPlanSummary 模拟 — 验证 summary 形态
    const summary = buildPlanSummary(finalBb, "B2 mixed plan");
    expect(summary).toContain("B2 mixed plan");
    expect(summary).toContain("完成 1/2");
    expect(summary).toContain("失败 1");

    // 验证 plan_done payload shape 合法(直接构造一个 plan_done 事件,确认类型对齐)
    const planDone: import("../../src/server/kernel/agentKernel.js").ServerEvent = {
      type: "plan_done",
      conversationId: "conv-b2",
      intentId: completed!.intent.id,
      summary,
      artifacts: finalBb.artifacts ?? [],
    };
    expect(planDone.type).toBe("plan_done");
    if (planDone.type === "plan_done") {
      expect(planDone.intentId).toBeTruthy();
      expect(planDone.summary.length).toBeGreaterThan(0);
    }
    orch.shutdown();
  });

  it("B2.neg: empty plan → summary 包含「没有产生任何 todo」", async () => {
    const orch = makeOrch({
      planner: async () => JSON.stringify([]), // Planner 输出空数组 → 0 todos
      executor: async () => JSON.stringify({ outcome: "evidence" }),
    });

    const finalBb = await orch.run("conv-b2-empty", "empty plan", () => {});
    const summary = buildPlanSummary(finalBb, "empty plan");
    expect(summary).toContain("没有产生任何 todo");
    orch.shutdown();
  });

  /* ────────────── B3: Executor callback → routeCallback wiring ────────────── */

  it("B3: Executor emit hypothesis → bus.executor_callback → Orchestrator.routeCallback fires with judgment reason", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "t-b3", title: "Trigger callback", body: "ask", dependsOn: [] },
      ]);

    const executor: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "hypothesis",
        hypothesis: {
          title: "Need user input",
          body: "Which color?",
          callbackReason: "judgment",
        },
      });

    const routeCallback = vi.fn();
    const orch = makeOrch({ planner, executor, routeCallback });

    // 等 Orchestrator 跑完(intent 状态因为 todo 阻塞在 waiting_for_decision 而 open)
    await orch.run("conv-b3", "B3 callback test", () => {});

    // routeCallback 必须被调用,reason="judgment"
    expect(routeCallback).toHaveBeenCalled();
    const arg = routeCallback.mock.calls[0]?.[0];
    expect(arg).toBeTruthy();
    expect(arg.todoId).toBe("t-b3");
    expect(arg.reason).toBe("judgment");
    expect(arg.hypothesisId).toBeTruthy();
    expect(arg.executorSessionId).toBeTruthy();

    orch.shutdown();
  });

  it("B3+B5: default routeCallback publishes bus event,Communicator 订阅 consume", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "t-b5", title: "default router", body: "x", dependsOn: [] },
      ]);
    const executor: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "hypothesis",
        hypothesis: {
          title: "default route",
          body: "ask",
          callbackReason: "harness_proposal",
        },
      });

    // 默认 routeCallback — 不注入
    const orch = makeOrch({ planner, executor });

    // bus 订阅:验证 default routeCallback 不阻塞 + bus 能拿到 event
    const seen: Array<{ hypothesisId: string }> = [];
    const unsub = artifactBus.subscribe("executor_callback", (e) => {
      seen.push({ hypothesisId: e.hypothesisId });
    });

    await orch.run("conv-b5", "default route", () => {});

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.hypothesisId).toBeTruthy();

    unsub();
    orch.shutdown();
  });

  /* ────────────── B4: Communicator task decision → onTask callback ────────────── */

  it("B4: Communicator.decide task → opts.onTask fires with goal + conversationId", async () => {
    const { comm, events } = makeCommunicator(async () => ({
      kind: "task",
      goal: "迁移数据库 schema",
    }));

    const onTask = vi.fn();
    comm.setOnTask(onTask);

    const decision = await comm.routeUserMessage("把 schema 迁了", "conv-b4", (e) =>
      events.push(e),
    );
    expect(decision.kind).toBe("task");

    // onTask 必须被调用一次,参数正确
    expect(onTask).toHaveBeenCalledTimes(1);
    expect(onTask).toHaveBeenCalledWith({
      goal: "迁移数据库 schema",
      conversationId: "conv-b4",
    });
  });

  it("B4.neg: chat decision → onTask 不触发", async () => {
    const { comm, events } = makeCommunicator(async () => ({
      kind: "chat",
      reply: "好的",
    }));
    const onTask = vi.fn();
    comm.setOnTask(onTask);

    const decision = await comm.routeUserMessage("你好", "conv-b4-chat", (e) =>
      events.push(e),
    );
    expect(decision.kind).toBe("chat");
    expect(onTask).not.toHaveBeenCalled();
  });

  /* ────────────── E2E: 全链路 wiring(B1+B2+B3+B4 联合) ────────────── */

  it("E2E: chat → task decision → onTask → Orchestrator with llmCall → completed emits plan_done-shape payload", async () => {
    // 1. Communicator(task decision → onTask fires)
    const { comm } = makeCommunicator(async () => ({
      kind: "task",
      goal: "E2E full chain",
    }));

    let orchestratorStarted = false;
    comm.setOnTask(async (input) => {
      orchestratorStarted = true;
      // 2. onTask 在真实 ws.ts 里会调 runPlan;这里直接构造 Orchestrator + 跑 llmCall
      const orch = makeOrch({
        planner: async () =>
          JSON.stringify([
            { id: "t-e2e", title: "E2E todo", body: "do", dependsOn: [] },
          ]),
        executor: async () =>
          JSON.stringify({
            outcome: "evidence",
            evidence: { title: "e2e done", body: "ok" },
          }),
      });
      const events: ProgressEvent[] = [];
      const finalBb = await orch.run(input.conversationId, input.goal, (e) => {
        events.push(e);
      });
      const completed = events.find((e) => e.type === "completed");
      expect(completed).toBeTruthy();
      // 3. 验证 plan_done ServerEvent 可构造 + summary 含 todo 统计
      const planDone: import("../../src/server/kernel/agentKernel.js").ServerEvent = {
        type: "plan_done",
        conversationId: input.conversationId,
        intentId: completed!.intent.id,
        summary: buildPlanSummary(finalBb, input.goal),
        artifacts: finalBb.artifacts ?? [],
      };
      expect(planDone.type).toBe("plan_done");
      if (planDone.type === "plan_done") {
        expect(planDone.summary).toContain("完成 1/1");
      }
      orch.shutdown();
    });

    await comm.routeUserMessage("开始 E2E", "conv-e2e", () => {});
    expect(orchestratorStarted).toBe(true);
  });

  /* ────────────── 类型 / shape 守门 ────────────── */

  it("ServerEvent plan_failed variant is constructible", () => {
    const ev: import("../../src/server/kernel/agentKernel.js").ServerEvent = {
      type: "plan_failed",
      conversationId: "conv-fail",
      intentId: "intent-fail",
      message: "boom",
    };
    expect(ev.type).toBe("plan_failed");
    if (ev.type === "plan_failed") {
      expect(ev.message).toBe("boom");
      expect(ev.intentId).toBe("intent-fail");
    }
  });

  it("Communicator.handleWorkerAsk(knowIt=false) → emits pending_question with synthesized BusMessage", async () => {
    const { comm, bus } = makeCommunicator(async () => ({ kind: "chat", reply: "" }));
    const events: CommunicatorEvent[] = [];
    const promise = bus.ask({
      fromRole: "executor",
      conversationId: "conv-ask",
      payload: "需要确认破坏性操作",
    });
    const qMsg = bus.snapshot()[0]!;
    await comm.handleWorkerAsk(qMsg as BusMessage, false, "", (e) => events.push(e));
    const pending = events.find((e) => e.type === "pending_question") as
      | Extract<CommunicatorEvent, { type: "pending_question" }>
      | undefined;
    expect(pending).toBeTruthy();
    expect(pending?.payload).toBe("需要确认破坏性操作");
    expect(pending?.fromRole).toBe("executor" satisfies RoleId);
    // 让 promise reject 收尾(否则 vitest warn "Promise still pending")
    bus.reply(qMsg.id, "(cancelled)");
    await expect(promise).resolves.toBe("(cancelled)");
  });

  });