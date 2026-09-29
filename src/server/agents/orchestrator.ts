/**
 * Sansheng · Orchestrator · M3+ B3 (event-sourced, DAG-aware)
 *
 * 角色:订阅 BlackboardArtifact 生命周期 bus,负责:
 *   1. intent artifact → spawn Planner
 *   2. Planner 产 todo → spawn Executor(按 dependsOn DAG)
 *   3. Executor 阻塞回调 → 路由给 Communicator + watchdog + depth limit
 *   4. decision artifact 落地 → resume waiting Executor(把 decision 注入 scope)
 *   5. 全部 todo resolved → mark intent resolved
 *
 * 设计点:
 * - **事件溯源**:所有状态变更通过 bus event,无内部 polling
 * - **依赖注入**:Planner/Executor 工厂 + bus + storage 全部可替换 → 测试 easy
 * - **Watchdog**:callback 5min 未响应 → 写 escalation note + 发 user message
 *   1hr 未响应 → mark todo failed
 * - **Depth limit**(默认 3):同一 executor session 多次 callback 时循环防御
 * - **回调路由**:通过注入 `routeCallback` 函数调用 Communicator(B2 产物),
 *   不直接 import Communicator(避免循环依赖,Communicator 在测试中可被 fake 替换)
 *
 * 兼容性:
 * - **run(convId, goal, sink)** 保留 ws.ts 调用面 — 内部 publish 一个 intent artifact,
 *   等待 Blackboard 全部就绪后返回 BlackboardShape
 */

import { nanoid } from "nanoid";
import type {
  BlackboardArtifact,
  BlackboardShape,
  CallbackReason,
} from "../../../shared/types/blackboard.js";
import type {
  ArtifactCreatedEvent,
  ArtifactStatusChangedEvent,
  ExecutorCallbackEvent,
  ExecutorResumeEvent,
} from "../../../shared/types/bus.js";
import { artifactBus, makeArtifact } from "../bus/index.js";
import {
  upsertArtifact,
  updateArtifactStatus,
  listArtifacts,
  getArtifact,
} from "../storage/index.js";
import type { Storage } from "../storage/index.js";
import { Planner, type PlannerOptions } from "./planner.js";
import { Executor, type ExecutorOptions } from "./executor.js";

/* ────────────────────────────────────────────────────────── *
 * Public types
 * ────────────────────────────────────────────────────────── */

export type ProgressEvent =
  | { type: "intent_received"; intent: BlackboardArtifact }
  | { type: "todos_planned"; todos: BlackboardArtifact[] }
  | { type: "todo_started"; todo: BlackboardArtifact }
  | { type: "todo_resolved"; todo: BlackboardArtifact }
  | { type: "todo_failed"; todo: BlackboardArtifact; reason: string }
  | { type: "callback_routed"; callback: ExecutorCallbackEvent }
  | { type: "callback_escalated"; todo: BlackboardArtifact; waitedMs: number }
  | { type: "decision_received"; todo: BlackboardArtifact; decision: BlackboardArtifact }
  | { type: "completed"; intent: BlackboardArtifact };

export type ProgressSink = (event: ProgressEvent) => void;

/**
 * Callback 路由函数。默认行为:仅通过 bus `executor_callback` 让其他订阅者(Communicator)处理。
 * 测试可注入自定义路由(同步记录,无需真 Communicator)。
 */
export type CallbackRouter = (
  cb: ExecutorCallbackEvent,
  context: {
    executorSessionId: string;
    todo: BlackboardArtifact;
    hypothesis: BlackboardArtifact;
  },
) => void | Promise<void>;

export interface OrchestratorOptions {
  storage: Storage;
  dataDir: string;
  agentDir: string;
  /** 测试可覆盖:Planner factory */
  plannerFactory?: (opts: PlannerOptions) => Planner;
  /** 测试可覆盖:Executor factory */
  executorFactory?: (opts: ExecutorOptions) => Executor;
  /** 注入 bus(默认全局 artifactBus);测试可注入 mock */
  bus?: typeof artifactBus;
  /** callback 路由 — 默认仅 publish bus event */
  routeCallback?: CallbackRouter;
  /** Watchdog 阈值(ms)。默认 5min escalation / 1hr fail。 */
  escalationMs?: number;
  failMs?: number;
  /** callback depth 上限(同一 executorSessionId 累计)。默认 3。 */
  maxCallbackDepth?: number;
  /** run() 的最大等待时长(ms);默认 30min。 */
  maxRunMs?: number;
}

/* ────────────────────────────────────────────────────────── *
 * Orchestrator class
 * ────────────────────────────────────────────────────────── */

interface WaitingEntry {
  todoId: string;
  hypothesisId: string;
  startedAt: number;
  escalationTimer: ReturnType<typeof setTimeout>;
  failTimer: ReturnType<typeof setTimeout>;
}

export class Orchestrator {
  private readonly storage: Storage;
  private readonly dataDir: string;
  private readonly agentDir: string;
  private readonly bus: typeof artifactBus;
  private readonly plannerFactory: (opts: PlannerOptions) => Planner;
  private readonly executorFactory: (opts: ExecutorOptions) => Executor;
  private readonly routeCallback: CallbackRouter;
  private readonly escalationMs: number;
  private readonly failMs: number;
  private readonly maxCallbackDepth: number;
  private readonly maxRunMs: number;

  private sink: ProgressSink | null = null;
  private intentByPlanner = new Map<string, string>(); // plannerSessionId → intentId (1:1, but tracked)
  private activeExecutors = new Map<string, Executor>(); // todoId → Executor
  private todoByExecutorSession = new Map<string, string>(); // executorSessionId → todoId
  private waiting = new Map<string, WaitingEntry>(); // executorSessionId → waiting state
  private depthBySession = new Map<string, number>(); // executorSessionId → callback depth

  private unsubs: Array<() => void> = [];
  private runPromise: Promise<BlackboardShape> | null = null;
  private runResolve: ((s: BlackboardShape) => void) | null = null;
  private runReject: ((e: Error) => void) | null = null;
  private runTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: OrchestratorOptions) {
    this.storage = opts.storage;
    this.dataDir = opts.dataDir;
    this.agentDir = opts.agentDir;
    this.bus = opts.bus ?? artifactBus;
    this.plannerFactory =
      opts.plannerFactory ?? ((p) => new Planner(p));
    this.executorFactory =
      opts.executorFactory ?? ((e) => new Executor(e));
    this.routeCallback = opts.routeCallback ?? defaultRouteCallback;
    this.escalationMs = opts.escalationMs ?? 5 * 60 * 1000;
    this.failMs = opts.failMs ?? 60 * 60 * 1000;
    this.maxCallbackDepth = opts.maxCallbackDepth ?? 3;
    this.maxRunMs = opts.maxRunMs ?? 30 * 60 * 1000;
  }

  /**
   * 订阅 bus(Orchestrator 启动时调用一次)。幂等:重复调用不会重复订阅。
   */
  init(): void {
    if (this.unsubs.length > 0) return;
    this.unsubs.push(
      this.bus.subscribe("artifact_created", (e) => {
        void this.onArtifactCreated(e);
      }),
      this.bus.subscribe("artifact_status_changed", (e) => {
        void this.onArtifactStatusChanged(e);
      }),
      this.bus.subscribe("executor_callback", (e) => {
        void this.onExecutorCallback(e);
      }),
      this.bus.subscribe("executor_resume", (e) => {
        void this.onExecutorResume(e);
      }),
    );
  }

  /**
   * 取消所有订阅,清 timers。
   */
  shutdown(): void {
    for (const u of this.unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    this.unsubs = [];
    for (const w of this.waiting.values()) {
      clearTimeout(w.escalationTimer);
      clearTimeout(w.failTimer);
    }
    this.waiting.clear();
    if (this.runTimer) {
      clearTimeout(this.runTimer);
      this.runTimer = null;
    }
    for (const e of this.activeExecutors.values()) {
      try {
        e.abort();
      } catch {
        /* ignore */
      }
    }
    this.activeExecutors.clear();
  }

  /**
   * 向后兼容 ws.ts 的入口:创建 intent,publish 到 bus,等待 Blackboard 完成。
   * 返回 BlackboardShape(包含 conversationId + artifacts[])。
   */
  async run(
    convId: string,
    goal: string,
    sink?: ProgressSink,
  ): Promise<BlackboardShape> {
    if (sink) this.sink = sink;
    this.init();

    // 1. 构造 intent artifact 并 publish
    const intent = makeArtifact({
      kind: "intent",
      title: goal.slice(0, 200),
      body: goal,
      scope: "conversation",
      conversationId: convId,
      author: "communicator",
      status: "open",
    });
    upsertArtifact(this.storage.db, intent);
    this.bus.publish({ type: "artifact_created", artifact: intent });

    // 2. 等 Blackboard 完成(intent resolved / failed,或超时)
    return new Promise<BlackboardShape>((resolve, reject) => {
      this.runResolve = resolve;
      this.runReject = reject;
      this.runTimer = setTimeout(() => {
        if (this.runReject) {
          const err = new Error(
            `Orchestrator.run timeout after ${this.maxRunMs}ms for intent ${intent.id}`,
          );
          this.runReject(err);
          this.runResolve = null;
          this.runReject = null;
        }
      }, this.maxRunMs);
    });
  }

  /**
   * 取消当前 run(若有)。
   */
  abort(): void {
    if (this.runTimer) {
      clearTimeout(this.runTimer);
      this.runTimer = null;
    }
    for (const w of this.waiting.values()) {
      clearTimeout(w.escalationTimer);
      clearTimeout(w.failTimer);
    }
    this.waiting.clear();
    for (const e of this.activeExecutors.values()) {
      try {
        e.abort();
      } catch {
        /* ignore */
      }
    }
    this.activeExecutors.clear();
    if (this.runReject) {
      this.runReject(new Error("Orchestrator aborted"));
      this.runResolve = null;
      this.runReject = null;
    }
  }

  /* ── Bus event handlers ─────────────────────────────────── */

  private async onArtifactCreated(e: ArtifactCreatedEvent): Promise<void> {
    const a = e.artifact;
    if (a.kind === "intent" && a.status === "open") {
      this.sink?.({ type: "intent_received", intent: a });
      await this.spawnPlanner(a);
    }
  }

  private async onArtifactStatusChanged(e: ArtifactStatusChangedEvent): Promise<void> {
    // 1. intent resolved / failed → run() 收尾
    if (this.runResolve && (e.newStatus === "resolved" || e.newStatus === "failed")) {
      const intent = getArtifact(this.storage.db, e.artifactId);
      if (intent && intent.kind === "intent") {
        this.completeRun(intent);
        return;
      }
    }

    // 2. dependency 解决 → 看是否有 waiting todo 可启动
    if (e.newStatus === "resolved" || e.newStatus === "failed") {
      this.tryUnblockDependents(e.artifactId);
    }

    // 3. todo resolved / failed → 上报
    if (e.artifactId && (e.newStatus === "resolved" || e.newStatus === "failed")) {
      const a = getArtifact(this.storage.db, e.artifactId);
      if (a && a.kind === "todo") {
        if (e.newStatus === "resolved") {
          this.sink?.({ type: "todo_resolved", todo: a });
        } else if (e.newStatus === "failed") {
          this.sink?.({
            type: "todo_failed",
            todo: a,
            reason: a.metadata?.errorReason ?? "executor reported failure",
          });
        }
      }
    }
  }

  private async onExecutorCallback(e: ExecutorCallbackEvent): Promise<void> {
    const todoId = this.todoByExecutorSession.get(e.executorSessionId);
    if (!todoId) return;
    const todo = getArtifact(this.storage.db, todoId);
    const hypothesis = getArtifact(this.storage.db, e.hypothesisId);
    if (!todo || !hypothesis) return;

    // 1. depth tracking
    const currentDepth = (this.depthBySession.get(e.executorSessionId) ?? 0) + 1;
    this.depthBySession.set(e.executorSessionId, currentDepth);
    if (currentDepth > this.maxCallbackDepth) {
      // 死循环防御:直接 mark todo failed + 写 note
      this.failTodoDueToDepth(todo, hypothesis, currentDepth);
      return;
    }

    // 2. 设置 watchdog timers
    const startedAt = Date.now();
    const escalationTimer = setTimeout(() => {
      this.escalateWaitingCallback(e.executorSessionId);
    }, this.escalationMs);
    const failTimer = setTimeout(() => {
      this.failWaitingCallback(e.executorSessionId);
    }, this.failMs);

    this.waiting.set(e.executorSessionId, {
      todoId,
      hypothesisId: e.hypothesisId,
      startedAt,
      escalationTimer,
      failTimer,
    });

    // 3. 路由给 Communicator(通过注入的 router;默认仅 publish bus event)
    this.sink?.({ type: "callback_routed", callback: e });
    try {
      await this.routeCallback(e, {
        executorSessionId: e.executorSessionId,
        todo,
        hypothesis,
      });
    } catch (err) {
      // 路由失败不影响 Orchestrator 状态 — watchdog 会兜底
      // 但取消 timers,避免悬挂
      this.clearWaiting(e.executorSessionId);
    }
  }

  private async onExecutorResume(e: ExecutorResumeEvent): Promise<void> {
    // 1. 清 timers
    this.clearWaiting(e.executorSessionId);

    // 2. 找到 todo + decision,通知 sink
    const todoId = this.todoByExecutorSession.get(e.executorSessionId);
    if (!todoId) return;
    const todo = getArtifact(this.storage.db, todoId);
    const decision = getArtifact(this.storage.db, e.decisionArtifactId);
    if (!todo || !decision) return;
    this.sink?.({ type: "decision_received", todo, decision });

    // 3. 触发 Executor 重新执行(todo 从 waiting_for_decision → in_progress)
    //    Executor 端拿到 decision 后,在新的 execute() 轮次里结合 context 用
    await this.resumeExecutor(todo);
  }

  /* ── Private orchestration logic ───────────────────────── */

  private async spawnPlanner(intent: BlackboardArtifact): Promise<void> {
    const planner = this.plannerFactory({ storage: this.storage });
    try {
      const result = await planner.plan(intent);
      this.sink?.({ type: "todos_planned", todos: result.todos });
      // 启动所有 ready todos(无依赖 / 依赖已 resolved)
      for (const todo of result.todos) {
        await this.spawnExecutorIfReady(todo);
      }
    } catch (err) {
      // Planner 整体失败 → mark intent failed
      this.failIntent(intent, err);
    }
  }

  private async spawnExecutorIfReady(todo: BlackboardArtifact): Promise<void> {
    if (!this.areDepsResolved(todo)) return;
    if (this.activeExecutors.has(todo.id)) return;
    await this.spawnExecutor(todo);
  }

  private areDepsResolved(todo: BlackboardArtifact): boolean {
    if (!todo.dependsOn || todo.dependsOn.length === 0) return true;
    for (const depId of todo.dependsOn) {
      const dep = getArtifact(this.storage.db, depId);
      if (!dep || dep.status !== "resolved") return false;
    }
    return true;
  }

  private tryUnblockDependents(resolvedArtifactId: string): void {
    // 找到所有 dependsOn 包含此 artifactId 的 todo,若现已就绪则 spawn
    const candidates = this.findTodosDependingOn(resolvedArtifactId);
    for (const todoId of candidates) {
      if (this.activeExecutors.has(todoId)) continue;
      const todo = getArtifact(this.storage.db, todoId);
      if (!todo) continue;
      if (todo.status !== "open") continue;
      if (this.areDepsResolved(todo)) {
        void this.spawnExecutor(todo);
      }
    }
  }

  private findTodosDependingOn(artifactId: string): string[] {
    // 简化:扫同 conversation 全局 bb 的 todos
    // 对于 global scope 不限制 conversationId
    const out: string[] = [];
    for (const scope of ["global", "conversation"] as const) {
      const opts =
        scope === "global"
          ? { scope: "global" as const, limit: 200 }
          : { scope: "conversation" as const, conversationId: "*", limit: 200 };
      const all = listArtifacts(this.storage.db, opts);
      for (const a of all) {
        if (a.kind !== "todo") continue;
        if (a.dependsOn && a.dependsOn.includes(artifactId)) out.push(a.id);
      }
    }
    return out;
  }

  private async spawnExecutor(todo: BlackboardArtifact): Promise<void> {
    if (this.activeExecutors.has(todo.id)) return;
    const executor = this.executorFactory({ storage: this.storage });
    this.activeExecutors.set(todo.id, executor);
    this.todoByExecutorSession.set(executor.sessionId, todo.id);
    this.sink?.({ type: "todo_started", todo });

    try {
      await executor.execute(todo);
      // execute 完成时:executor 内部已 publish artifact + 更新 todo status
      // Orchestrator 不需要额外动作;bus event 会触发后续流程
    } catch (err) {
      // Executor 抛错(罕见,大部分错误在内部处理)→ mark todo failed
      this.failTodo(todo, err);
    } finally {
      this.activeExecutors.delete(todo.id);
    }
  }

  private async resumeExecutor(todo: BlackboardArtifact): Promise<void> {
    // Resume:在原 Executor 上重新 execute();它会再次跑 llmCall + 这次 context 包含 decision
    // 这里不复用原 Executor(它已 dispose) — 新建一个
    // 注意:depth 已经在 onExecutorCallback 里累计,这里清掉 waiting 不重置 depth
    // (深度限制针对 callback chain,不是 resume)
    if (this.activeExecutors.has(todo.id)) return;
    if (this.areDepsResolved(todo)) {
      await this.spawnExecutor(todo);
    } else {
      // 还有依赖未 ready(罕见)— 等下一次 tryUnblockDependents
    }
  }

  private escalateWaitingCallback(executorSessionId: string): void {
    const w = this.waiting.get(executorSessionId);
    if (!w) return;
    const todo = getArtifact(this.storage.db, w.todoId);
    if (!todo) return;
    const waitedMs = Date.now() - w.startedAt;

    // 1. 写 escalation note
    const note = makeArtifact({
      kind: "note",
      title: `Escalation: ${todo.title.slice(0, 60)}`,
      body: `Executor for todo ${todo.id} has been waiting for a decision for ${Math.round(waitedMs / 1000)}s (hypothesis=${w.hypothesisId}). User input requested.`,
      author: "executor",
      scope: todo.scope,
      conversationId: todo.conversationId,
      status: "resolved",
      parentIntent: todo.parentIntent,
      metadata: {
        relatedArtifacts: [todo.id, w.hypothesisId],
        callbackReason: "judgment" as CallbackReason,
      },
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    this.sink?.({ type: "callback_escalated", todo, waitedMs });
  }

  private failWaitingCallback(executorSessionId: string): void {
    const w = this.waiting.get(executorSessionId);
    if (!w) return;
    const todo = getArtifact(this.storage.db, w.todoId);
    if (!todo) return;
    const waitedMs = Date.now() - w.startedAt;
    this.clearWaiting(executorSessionId);

    this.failTodo(todo, new Error(
      `callback not resolved within ${Math.round(waitedMs / 1000)}s (hypothesis=${w.hypothesisId})`,
    ));
  }

  private failTodoDueToDepth(
    todo: BlackboardArtifact,
    hypothesis: BlackboardArtifact,
    depth: number,
  ): void {
    const note = makeArtifact({
      kind: "note",
      title: `Todo failed: max callback depth (${this.maxCallbackDepth})`,
      body: `Todo ${todo.id} exceeded max callback depth (${depth} > ${this.maxCallbackDepth}) on hypothesis ${hypothesis.id}. Marking failed to prevent loops.`,
      author: "executor",
      scope: todo.scope,
      conversationId: todo.conversationId,
      status: "resolved",
      parentIntent: todo.parentIntent,
      metadata: {
        relatedArtifacts: [todo.id, hypothesis.id],
      },
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    this.failTodo(todo, new Error(`max callback depth exceeded: ${depth}`));
  }

  private failTodo(todo: BlackboardArtifact, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    updateArtifactStatus(this.storage.db, todo.id, "failed");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: todo.id,
      oldStatus: todo.status ?? "in_progress",
      newStatus: "failed",
      actor: "executor",
    });
    const failed = getArtifact(this.storage.db, todo.id);
    if (failed) {
      this.sink?.({ type: "todo_failed", todo: failed, reason });
    }
  }

  private failIntent(intent: BlackboardArtifact, err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    const note = makeArtifact({
      kind: "note",
      title: `Intent failed: planner error`,
      body: `Planner failed for intent ${intent.id}: ${reason}`,
      author: "planner",
      scope: intent.scope ?? "global",
      conversationId: intent.conversationId,
      status: "resolved",
      parentIntent: intent.id,
      metadata: { relatedArtifacts: [intent.id] },
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    updateArtifactStatus(this.storage.db, intent.id, "failed");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: intent.id,
      oldStatus: "open",
      newStatus: "failed",
      actor: "planner",
    });
  }

  private clearWaiting(executorSessionId: string): void {
    const w = this.waiting.get(executorSessionId);
    if (!w) return;
    clearTimeout(w.escalationTimer);
    clearTimeout(w.failTimer);
    this.waiting.delete(executorSessionId);
  }

  private completeRun(intent: BlackboardArtifact): void {
    if (!this.runResolve) return;
    if (this.runTimer) {
      clearTimeout(this.runTimer);
      this.runTimer = null;
    }
    const resolve = this.runResolve;
    this.runResolve = null;
    this.runReject = null;
    const artifacts = listArtifacts(this.storage.db, {
      scope: intent.scope === "global" ? "global" : "conversation",
      conversationId: intent.conversationId ?? "*",
      limit: 500,
    });
    const shape: BlackboardShape = {
      conversationId: intent.conversationId ?? "*",
      artifacts,
      scope: intent.scope ?? "global",
    };
    this.sink?.({ type: "completed", intent });
    resolve(shape);
  }
}

/* ────────────────────────────────────────────────────────── *
 * Default callback router
 * ────────────────────────────────────────────────────────── */

const defaultRouteCallback: CallbackRouter = (cb, ctx) => {
  // 默认行为:仅通过 artifactBus 的 executor_callback event 通知外部订阅者
  // (Communicator 已在 B2 阶段被设计成 bus 订阅者)
  // 这里啥都不做 — event 已经被 Orchestrator 处理过(触发 watchdog + depth tracking)
  void ctx;
  void cb;
};

/* ────────────────────────────────────────────────────────── *
 * Helper:read prompt file(Boot 时从 .md 加载)
 * ────────────────────────────────────────────────────────── */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadPlannerPrompt(sharedDir: string): string {
  try {
    return readFileSync(join(sharedDir, "prompts", "planner.md"), "utf-8");
  } catch {
    return DEFAULT_PLANNER_PROMPT_PLACEHOLDER;
  }
}

export function loadExecutorPrompt(sharedDir: string): string {
  try {
    return readFileSync(join(sharedDir, "prompts", "executor.md"), "utf-8");
  } catch {
    return DEFAULT_EXECUTOR_PROMPT_PLACEHOLDER;
  }
}

const DEFAULT_PLANNER_PROMPT_PLACEHOLDER =
  "Planner · read shared/prompts/planner.md for full prompt";
const DEFAULT_EXECUTOR_PROMPT_PLACEHOLDER =
  "Executor · read shared/prompts/executor.md for full prompt";

/* Re-export nanoid for boot scripts that want session ids */
export { nanoid };
