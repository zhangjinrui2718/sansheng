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
      failMs: 5000,
    });

    const events: ProgressEvent[] = [];
    // A2 语义:todo 进入 waiting_for_decision 后 run() 不再提前 settle —
    // run 跨越「提问 → decision → resume」完整周期(由 watchdog/maxRunMs 兜底)。
    // 所以这里不 await run,等回调路由发生后断言,最后 abort() 收尾。
    const runP = orch.run("conv-cb", "trigger callback", (e) => events.push(e));
    const runGuard = runP.catch((err) => err); // 防 abort 后 unhandled rejection

    await vi.waitFor(() => expect(routeCallback).toHaveBeenCalledTimes(1));
    const arg = routeCallback.mock.calls[0]![0]!;
    expect(arg.todoId).toBe("t-cb");
    expect(arg.reason).toBe("judgment");

    const todo = getArtifact(db, "t-cb");
    expect(todo?.status).toBe("waiting_for_decision");
    expect(events.some((e) => e.type === "callback_routed")).toBe(true);

    orch.abort();
    expect(await runGuard).toBeInstanceOf(Error);
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
    // Attach rejection handler synchronously to avoid an unhandled-rejection
    // window between orch.abort() (which rejects runP) and the later assertion.
    const runPAssertion = expect(runP).rejects.toThrow(/abort/i);

    await new Promise((r) => setTimeout(r, 5));
    expect(events.some((e) => e.type === "todo_started")).toBe(true);

    orch.abort();
    await new Promise((r) => setTimeout(r, 5));

    resolveExec?.();

    await runPAssertion;

    orch.shutdown();
  });

  // A4 重写(docs/CODE-REVIEW-2026-10-01.md §A4):旧版用 todoId 冒充 executorSessionId
  // 发 resume(todoByExecutorSession 查不到 → 实际 no-op),断言又是三选一宽松集合,
  // 没测到真实 depth 路径。现在:routeCallback 用**真实 executorSessionId** 发 resume,
  // executor 每次重跑都产 hypothesis → depth 按 todoId 跨 session 累计,
  // 超过 maxCallbackDepth 走 failTodoDueToDepth(旧实现按 session 计数恒 1,生产不可达)。
  it("depth limit: same todo across sessions → failTodoDueToDepth after maxCallbackDepth", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "t-depth", title: "loop", body: "endless callback", dependsOn: [] },
      ]);

    // 每次执行都产 hypothesis → 若无 depth 防线即无界循环
    const executor: ExecutorLlmCall = vi.fn(async () =>
      JSON.stringify({
        outcome: "hypothesis",
        hypothesis: {
          title: "still needs judgment",
          body: "again",
          callbackReason: "judgment",
        },
      }),
    );

    // routeCallback:用真实 executorSessionId 回 decision + executor_resume。
    // setTimeout(0):executor_callback 在 executor.execute 调用栈内 publish,
    // 此时 spawnExecutor 的 activeExecutors 尚未释放,同步 resume 会被忽略;
    // 延到下一个宏任务,模拟真实「用户回答稍后到达」。
    const routeCallback = vi.fn(async (arg: { executorSessionId: string }) => {
      await new Promise((r) => setTimeout(r, 0));
      const dec = makeArtifact({
        kind: "decision",
        title: "test decision",
        body: "approved",
        scope: "conversation",
        conversationId: "conv-depth",
        author: "communicator",
        status: "open",
      });
      upsertArtifact(db, dec);
      artifactBus.publish({ type: "artifact_created", artifact: dec });
      artifactBus.publish({
        type: "executor_resume",
        executorSessionId: arg.executorSessionId,
        decisionArtifactId: dec.id,
      });
    });

    const orch = makeOrch({
      planner,
      executor,
      routeCallback: routeCallback as never,
      maxCallbackDepth: 2,
      failMs: 60_000, // watchdog 不参与:run 必须由 depth 防线收尾
    });

    const events: ProgressEvent[] = [];
    // cb#1(depth1)→resume→cb#2(depth2)→resume→cb#3(depth3>2)→failTodoDueToDepth
    // → intent failed → run settle
    await orch.run("conv-depth", "infinite loop", (e) => events.push(e));

    const todo = getArtifact(db, "t-depth");
    expect(todo?.status).toBe("failed");

    // executor 恰好跑 maxCallbackDepth+1 次(1 初始 + 2 resume),第 3 次 callback 被掐断
    expect(executor).toHaveBeenCalledTimes(3);
    // routeCallback 只路由前 2 次(第 3 次超限直接 failed,不再提问)
    expect(routeCallback).toHaveBeenCalledTimes(2);

    // 失败 reason 来自 depth 防线(而非 watchdog / executor 错误)
    expect(
      events.some(
        (e) => e.type === "todo_failed" && /max callback depth exceeded/.test(e.reason),
      ),
    ).toBe(true);

    // depth 失败 note 已落库
    const notes = listArtifacts(db, {
      scope: "conversation",
      conversationId: "conv-depth",
    }).filter((a) => a.kind === "note");
    expect(notes.some((n) => n.title.includes("max callback depth"))).toBe(true);

    orch.shutdown();
  }, 20_000);

  // A3-followup(open question #2 → 追加任务):dep-failed 级联。
  // 旧行为:上游 todo failed 后,下游永远 open(areDepsResolved 要求全部 resolved)
  // → intent 不终态 → run 等满 maxRunMs 才超时 reject。
  // 新行为:failed 触发级联(只对 open 下游,递归 + visited 防环)→ intent 立即
  // 终态 → run 同步 settle(远早于 maxRunMs)。
  it("dep-failed cascade: upstream fail → open 下游递归 failed → run 立即 settle", async () => {
    const planner: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "t-c-root", title: "root", body: "will fail", dependsOn: [] },
        { id: "t-c-mid", title: "mid", body: "dep root", dependsOn: ["t-c-root"] },
        { id: "t-c-leaf", title: "leaf", body: "dep mid", dependsOn: ["t-c-mid"] },
      ]);
    // 只有 root 会被执行(且失败);mid/leaf 不应被执行 — 级联直接标 failed
    const executor: ExecutorLlmCall = vi.fn(async () =>
      JSON.stringify({
        outcome: "failed",
        note: { title: "boom", body: "root failed on purpose" },
      }),
    );

    const orch = makeOrch({
      planner,
      executor,
      maxRunMs: 15_000, // 刻意大于断言阈值:settle 必须来自级联,而非超时兜底
    });

    const events: ProgressEvent[] = [];
    const t0 = Date.now();
    const finalBb = await orch.run("conv-cascade", "cascade test", (e) => events.push(e));
    const elapsed = Date.now() - t0;

    // run 及时 settle(级联是同步路径,实际 <1s;阈值 5s ≪ maxRunMs 15s)
    expect(elapsed).toBeLessThan(5_000);

    // 三级 todos 全部 failed(root 由 executor, mid/leaf 由级联)
    expect(getArtifact(db, "t-c-root")?.status).toBe("failed");
    expect(getArtifact(db, "t-c-mid")?.status).toBe("failed");
    expect(getArtifact(db, "t-c-leaf")?.status).toBe("failed");
    // executor 只跑了 root;mid/leaf 从未 spawn
    expect(executor).toHaveBeenCalledTimes(1);

    // 级联 reason 持久化且注明上游(metadata.errorReason,case3 sink 同源读取)
    expect(String(getArtifact(db, "t-c-mid")?.metadata?.errorReason)).toContain(
      "cascade from t-c-root",
    );
    expect(String(getArtifact(db, "t-c-leaf")?.metadata?.errorReason)).toContain(
      "cascade from t-c-mid",
    );

    // intent 终态 failed(finalBb 是 settle 时刻的快照)
    const intent = (finalBb.artifacts ?? []).find((a) => a.kind === "intent");
    expect(intent?.status).toBe("failed");

    // sink 收到级联 todo_failed(reason 含 cascade 字样)
    expect(
      events.some((e) => e.type === "todo_failed" && e.reason.includes("cascade from t-c-root")),
    ).toBe(true);

    orch.shutdown();
  }, 20_000);

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
    // Attach rejection handler synchronously to avoid an unhandled-rejection
    // window between the run() timeout firing inside advanceTimersByTimeAsync
    // and the later assertion.
    const runPAssertion = expect(runP).rejects.toThrow(/timeout/i);

    await vi.advanceTimersByTimeAsync(150);
    await runPAssertion;

    orch.shutdown();
  });
});