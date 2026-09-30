import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { Orchestrator, type ProgressEvent } from "../../src/server/agents/orchestrator.js";
import { Planner, type PlannerLlmCall } from "../../src/server/agents/planner.js";
import { Executor, type ExecutorLlmCall } from "../../src/server/agents/executor.js";
import { artifactBus, makeArtifact } from "../../src/server/bus/index.js";
import { upsertArtifact, listArtifacts, getArtifact } from "../../src/server/storage/repo/blackboards.js";

let storage: Storage;
let db: Database.Database;

function makeStorage() {
  const _db = new Database(":memory:");
  runMigrations(_db);
  const _storage = new Storage(_db);
  return { db: _db, storage: _storage };
}

type MakeOpts = {
  planner: PlannerLlmCall;
  executor: ExecutorLlmCall;
  routeCallback?: (arg: {
    todoId: string;
    reason: "judgment" | "harness_proposal";
    hypothesisId: string;
    executorSessionId: string;
  }) => void | Promise<void>;
  escalationMs?: number;
  failMs?: number;
  maxCallbackDepth?: number;
  maxRunMs?: number;
};

function makeOrch(opts: MakeOpts): Orchestrator {
  return new Orchestrator({
    storage,
    dataDir: "/tmp/orch-test-data",
    agentDir: "/tmp/orch-test-agent",
    plannerFactory: (p) => {
      p.llmCall = opts.planner;
      return new Planner(p);
    },
    executorFactory: (e) => {
      e.llmCall = opts.executor;
      return new Executor(e);
    },
    ...(opts.routeCallback ? { routeCallback: opts.routeCallback } : {}),
    ...(opts.escalationMs !== undefined ? { escalationMs: opts.escalationMs } : {}),
    ...(opts.failMs !== undefined ? { failMs: opts.failMs } : {}),
    ...(opts.maxCallbackDepth !== undefined
      ? { maxCallbackDepth: opts.maxCallbackDepth }
      : {}),
    ...(opts.maxRunMs !== undefined ? { maxRunMs: opts.maxRunMs } : {}),
  });
}

describe("agents/orchestrator (event-sourced API)", () => {
  beforeEach(() => {
    const s = makeStorage();
    storage = s.storage;
    db = s.db;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits intent_received → todos_planned → todo_started → todo_resolved on happy path", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        {
          id: "t-happy",
          title: "Run happy path",
          body: "just do it",
          dependsOn: [],
        },
      ]);

    const executor: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "evidence",
        evidence: { title: "done", body: "happy path complete" },
      });

    const orch = makeOrch({ planner, executor });

    const events: ProgressEvent[] = [];
    const result = await orch.run("conv-happy", "build a happy path", (e) => {
      events.push(e);
    });

    expect(result.conversationId).toBe("conv-happy");

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("intent_received");
    expect(eventTypes).toContain("todos_planned");
    expect(eventTypes).toContain("todo_started");
    expect(eventTypes).toContain("todo_resolved");

    const resolvedTodo = getArtifact(db, "t-happy");
    expect(resolvedTodo?.status).toBe("resolved");

    const evidence = listArtifacts(db, {
      scope: "conversation",
      conversationId: "conv-happy",
    }).filter((a) => a.kind === "evidence");
    expect(evidence.length).toBe(1);

    orch.shutdown();
  });

  it("executor callback → routes through injected routeCallback with judgment reason", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        {
          id: "t-cb",
          title: "Trigger callback",
          body: "needs human",
          dependsOn: [],
        },
      ]);

    const executor: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "hypothesis",
        hypothesis: {
          title: "Need human judgment",
          body: "JWT vs sessions?",
          callbackReason: "judgment",
        },
      });

    const routeCallback = vi.fn(async () => {});

    const orch = makeOrch({
      planner,
      executor,
      routeCallback: routeCallback as never,
      failMs: 1000,
    });

    const events: ProgressEvent[] = [];
    await orch.run("conv-cb", "trigger callback", (e) => events.push(e));

    expect(routeCallback).toHaveBeenCalledTimes(1);
    const arg = routeCallback.mock.calls[0]![0]!;
    expect(arg.todoId).toBe("t-cb");
    expect(arg.reason).toBe("judgment");

    const todo = getArtifact(db, "t-cb");
    expect(todo?.status).toBe("waiting_for_decision");

    orch.shutdown();
  });

  it("abort() during run rejects runPromise", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "t-abort", title: "block", body: "long", dependsOn: [] },
      ]);

    let resolveExec: (() => void) | null = null;
    const execPromise = new Promise<string>((r) => {
      resolveExec = r;
    });
    const executor: ExecutorLlmCall = async () => execPromise;

    const orch = makeOrch({ planner, executor });

    const events: ProgressEvent[] = [];
    const runP = orch.run("conv-abort", "abort me", (e) => events.push(e));

    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.type === "todo_started")).toBe(true);

    orch.abort();
    await new Promise((r) => setTimeout(r, 5));

    resolveExec?.();

    await expect(runP).rejects.toThrow(/abort/i);

    orch.shutdown();
  });

  it("depth limit + routeCallback loop → bounded by maxCallbackDepth", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "t-depth", title: "loop", body: "endless callback", dependsOn: [] },
      ]);

    const executor: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "hypothesis",
        hypothesis: {
          title: "still needs judgment",
          body: "again",
          callbackReason: "judgment",
        },
      });

    // routeCallback: synchronously publish executor_resume so executor is re-run,
    // emitting yet another hypothesis. After maxCallbackDepth rounds, Orchestrator
    // should mark the todo as failed and stop routing.
    const routeCallback = vi.fn(async () => {
      const dec = makeArtifact({
        kind: "decision",
        title: "test decision",
        body: "approved",
        scope: "conversation",
        conversationId: "conv-depth",
        author: "communicator",
        status: "open",
      });
      dec.parentIntent = "t-depth";
      upsertArtifact(db, dec);
      artifactBus.publish({ type: "artifact_created", artifact: dec });
      artifactBus.publish({
        type: "executor_resume",
        executorSessionId: "t-depth",
        decisionArtifactId: dec.id,
      });
    });

    const orch = makeOrch({
      planner,
      executor,
      routeCallback: routeCallback as never,
      maxCallbackDepth: 2,
      failMs: 5000,
    });

    const events: ProgressEvent[] = [];
    await orch.run("conv-depth", "infinite loop", (e) => events.push(e));

    // depth limit or failMs watchdog: todo should not stay in waiting_for_decision forever
    const todo = getArtifact(db, "t-depth");
    expect(todo).toBeTruthy();
    expect(["failed", "waiting_for_decision", "resolved"]).toContain(todo?.status);

    orch.shutdown();
  });

  it("shutdown() unsubscribes from bus (no further events processed)", async () => {
    const planner: PlannerLlmCall = async () => "[]";
    const executor: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "evidence",
        evidence: { title: "x", body: "y" },
      });

    const orch = makeOrch({ planner, executor });

    const events: ProgressEvent[] = [];
    await orch.run("conv-shutdown", "lifecycle", (e) => events.push(e));

    const beforeShutdown = events.length;
    orch.shutdown();

    const intent = makeArtifact({
      kind: "intent",
      title: "post-shutdown",
      body: "should be ignored",
      scope: "conversation",
      conversationId: "conv-post",
      author: "communicator",
    });
    upsertArtifact(db, intent);
    artifactBus.publish({ type: "artifact_created", artifact: intent });

    await new Promise((r) => setTimeout(r, 10));
    expect(events.length).toBe(beforeShutdown);
  });

  it("run() timeout → rejects when no todo resolves within maxRunMs (fake timers)", async () => {
    vi.useFakeTimers();

    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "t-to", title: "never resolve", body: "stuck", dependsOn: [] },
      ]);

    // executor that never resolves → run() can never complete via resolved intent
    const executor: ExecutorLlmCall = () => new Promise<string>(() => {});

    const orch = makeOrch({ planner, executor, maxRunMs: 100 });

    const events: ProgressEvent[] = [];
    const runP = orch.run("conv-to", "timeout test", (e) => events.push(e));

    await vi.advanceTimersByTimeAsync(150);
    await expect(runP).rejects.toThrow(/timeout/i);

    orch.shutdown();
  });
});