/**
 * 批次 4b · C1 + C2 —— bus 订阅 void asyncFn 无 .catch / routeCallback 零日志;
 *                      abort 语义不完整
 * (docs/CODE-REVIEW-2026-10-01.md §C1 / §C2)
 *
 * C1:orchestrator.ts `void this.onArtifactCreated(e)` 一路裸奔 ——
 *    handler 内任何异步抛错都变成 unhandledRejection(审查原文:「= unhandled
 *    rejection 崩进程(A1 的放大器)」);routeCallback 的 catch 把 err 变量读了都
 *    没用(零日志),失败静默。
 * C2:Executor.abort 只设 flag —— 在飞 llmCall 照跑完并 persist 产物 + 改 todo
 *    终态 + 发 bus 事件;Orchestrator.abort 虽已退订(批次 1),但没有 aborted 守卫,
 *    同一个实例 abort 后还能再次 run() 并重新消费事件。
 *
 * 红线:批次 1 的 settle/终态语义不动(ws-plan-integration 5 场景在红线内);
 *      4a C8「abort 同步直调不入队」在 kernel 侧,本组不动 kernel。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { Orchestrator } from "../../src/server/agents/orchestrator.js";
import { Planner, type PlannerLlmCall } from "../../src/server/agents/planner.js";
import { Executor, type ExecutorLlmCall } from "../../src/server/agents/executor.js";
import { artifactBus } from "../../src/server/bus/index.js";
import { upsertArtifact, getArtifact, listArtifacts } from "../../src/server/storage/repo/blackboards.js";
import { makeArtifact } from "../../src/server/bus/index.js";
import { log } from "../../src/shared/log.js";

let storage: Storage;
let db: Database.Database;

function makeStorage(): Storage {
  const _db = new Database(":memory:");
  runMigrations(_db);
  return new Storage(_db);
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
  maxRunMs?: number;
}): Orchestrator {
  return new Orchestrator({
    storage,
    dataDir: "/tmp/orch-hygiene-data",
    agentDir: "/tmp/orch-hygiene-agent",
    plannerFactory: (p) => {
      p.llmCall = opts.planner;
      return new Planner(p);
    },
    executorFactory: (e) => {
      e.llmCall = opts.executor;
      return new Executor(e);
    },
    ...(opts.routeCallback ? { routeCallback: opts.routeCallback } : {}),
    maxRunMs: opts.maxRunMs ?? 800,
  });
}

const evidenceLlm: ExecutorLlmCall = async () =>
  JSON.stringify({ outcome: "evidence", evidence: { title: "done", body: "b" } });

beforeEach(() => {
  storage = makeStorage();
  db = storage.db;
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    storage.close();
  } catch {
    /* ignore */
  }
});

describe("C1 · bus 订阅 handler 的异步异常被兜住并留痕", () => {
  it("handler 内抛错不会变成 unhandledRejection,且有错误日志", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    // 制造一个「handler 内部 storage 访问抛错」的真实场景:
    // planner 的 llmCall 把 db 关掉,之后 Planner/Orchestrator 的任何写读都抛。
    const orch = makeOrch({
      planner: async () => {
        storage.close();
        return JSON.stringify([{ id: "t-c1", title: "x", body: "", dependsOn: [] }]);
      },
      executor: evidenceLlm,
    });
    try {
      await orch.run("conv-c1", "goal").catch(() => {});
      // 让所有 void handler 的 rejection 落地
      await new Promise((r) => setTimeout(r, 50));

      // RED(修复前):unhandled.length > 0(Node 会打印并可能终止进程)
      expect(unhandled).toEqual([]);
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      // RED(修复前):路由失败 err 未用、零日志 → 没有任何 handler 级日志
      expect(logged).toMatch(/onArtifactCreated|orchestrator/i);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      orch.shutdown();
    }
  });

  it("routeCallback 失败会被记录(err 变量不再被丢弃)", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const orch = makeOrch({
      planner: async () =>
        JSON.stringify([
          {
            id: "t-c1-route",
            title: "ask",
            body: "",
            dependsOn: [],
          },
        ]),
      executor: async () =>
        JSON.stringify({
          outcome: "hypothesis",
          hypothesis: { title: "need help", body: "?", callbackReason: "judgment" },
        }),
      routeCallback: () => {
        throw new Error("route-boom");
      },
    });
    try {
      await orch.run("conv-c1-route", "goal").catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      const logged = warnSpy.mock.calls
        .map((c) => c.map((x) => (x instanceof Error ? x.message : String(x))).join(" "))
        .join("\n");
      // RED(修复前):catch 块里 err 完全没用 → 没有任何日志
      expect(logged).toContain("route-boom");
    } finally {
      orch.shutdown();
    }
  });
});

describe("C2 · Executor.abort 后不再 persist 产物 / 不发事件", () => {
  it("在飞 llmCall 完成后不落 artifact、不改 todo 终态、不发 bus 事件", async () => {
    let release: (v: string) => void = () => {};
    const gate = new Promise<string>((r) => {
      release = r;
    });
    const published: string[] = [];
    const unsub = artifactBus.subscribe("artifact_created", (e) => {
      published.push(e.artifact.id);
    });

    const todo = makeArtifact({
      id: "todo-c2",
      kind: "todo",
      title: "long running",
      body: "",
      author: "planner",
      status: "open",
      scope: "conversation",
      conversationId: "conv-c2",
    });
    upsertArtifact(db, todo);

    const executor = new Executor({ storage, llmCall: () => gate });
    const running = executor.execute(todo);
    await new Promise((r) => setTimeout(r, 5));
    executor.abort();
    release(JSON.stringify({ outcome: "evidence", evidence: { title: "late", body: "b" } }));
    const result = await running;

    unsub();
    // RED(修复前):产物落库 + todo 标 resolved + bus 发 artifact_created
    expect(result.artifactIds).toEqual([]);
    expect(getArtifact(db, "todo-c2")?.status).toBe("in_progress");
    expect(listArtifacts(db, { scope: "conversation", conversationId: "conv-c2" }).filter((a) => a.kind === "evidence")).toEqual([]);
    expect(published).toEqual([]);
  });

  it("abort 后 execute() 直接返回,不调 llmCall(既有 early-return 契约不破)", async () => {
    let called = 0;
    const executor = new Executor({
      storage,
      llmCall: async () => {
        called += 1;
        return "{}";
      },
    });
    executor.abort();
    const todo = makeArtifact({
      id: "todo-c2-early",
      kind: "todo",
      title: "t",
      body: "",
      author: "planner",
      status: "open",
    });
    const res = await executor.execute(todo);
    expect(called).toBe(0);
    expect(res.outcome).toBe("failed");
  });
});

describe("C2 · Orchestrator.abort 守卫(退订之后不再消费任何事件)", () => {
  it("abort 之后同一个实例的 run() 直接 reject,planner 不再被调用", async () => {
    let plannerCalls = 0;
    const orch = makeOrch({
      planner: async () => {
        plannerCalls += 1;
        return JSON.stringify([{ id: "t-c2-orch", title: "x", body: "", dependsOn: [] }]);
      },
      executor: evidenceLlm,
    });
    const first = orch.run("conv-c2-orch", "goal").catch(() => "settled");
    await new Promise((r) => setTimeout(r, 30));
    orch.abort();
    await first;
    const callsAfterAbort = plannerCalls;

    // RED(修复前):abort 后 init() 会重新订阅,本实例复活并再次消费 intent 事件
    await expect(orch.run("conv-c2-orch", "goal-2")).rejects.toThrow(/abort/i);
    await new Promise((r) => setTimeout(r, 30));
    expect(plannerCalls).toBe(callsAfterAbort);
  });

  it("abort 之后不再向 sink 发任何进度事件", async () => {
    const events: string[] = [];
    const orch = makeOrch({
      planner: async () => JSON.stringify([{ id: "t-c2-sink", title: "x", body: "", dependsOn: [] }]),
      executor: evidenceLlm,
    });
    const run = orch.run("conv-c2-sink", "goal", (e) => events.push(e.type)).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    orch.abort();
    const seenAtAbort = events.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(events.length).toBe(seenAtAbort);
    await run;
  });

  it("shutdown 之后同样不可复活(终态语义)", async () => {
    const orch = makeOrch({
      planner: async () => JSON.stringify([{ id: "t-c2-sd", title: "x", body: "", dependsOn: [] }]),
      executor: evidenceLlm,
    });
    const run = orch.run("conv-c2-sd", "goal").catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    orch.shutdown();
    await run;
    await expect(orch.run("conv-c2-sd", "goal-2")).rejects.toThrow(/shutdown|abort/i);
  });
});
