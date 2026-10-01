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
 * - **Depth limit**(默认 3):同一 todo 多次 callback(跨 executor session 累计,A4)循环防御
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
import type { ArtifactStatus } from "../../../shared/types/blackboard.js";
import type {
  ArtifactCreatedEvent,
  ArtifactStatusChangedEvent,
  ExecutorCallbackEvent,
  ExecutorResumeEvent,
} from "../../../shared/types/bus.js";
import { artifactBus, makeArtifact } from "../bus/index.js";
import { log } from "../../shared/log.js";
import {
  upsertArtifact,
  updateArtifactStatus,
  listArtifacts,
  getArtifact,
} from "../storage/index.js";
import type { Storage } from "../storage/index.js";
import { Planner, type PlannerOptions, type PlannerLlmCall } from "./planner.js";
import { Executor, type ExecutorOptions, type ExecutorLlmCall } from "./executor.js";

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
export type CallbackRouter = (arg: {
  todoId: string;
  reason: CallbackReason;
  hypothesisId: string;
  executorSessionId: string;
}) => void | Promise<void>;

export interface OrchestratorOptions {
  storage: Storage;
  dataDir: string;
  agentDir: string;
  /** Planner LLM call(real impl 由 boot 注入)。若提供,会写入 Planner.llmCall(覆盖 factory 默认 throw)。 */
  plannerLlmCall?: PlannerLlmCall;
  /** Executor LLM call(real impl 由 boot 注入)。若提供,会写入 Executor.llmCall。 */
  executorLlmCall?: ExecutorLlmCall;
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
  /** callback depth 上限(A4:同一 todoId 跨 executor session 累计)。默认 3。 */
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
  private readonly plannerLlmCall: PlannerLlmCall | undefined;
  private readonly executorLlmCall: ExecutorLlmCall | undefined;
  private readonly routeCallback: CallbackRouter;
  private readonly escalationMs: number;
  private readonly failMs: number;
  private readonly maxCallbackDepth: number;
  private readonly maxRunMs: number;

  private sink: ProgressSink | null = null;
  /** A2 ownership:本次 run() 创建的 intent id — bus handler 只处理它及其派生 todos。 */
  private myIntentId: string | null = null;
  /** A2/A3:本次 run() 的 conversationId(DAG 解锁查询需要真实值,不能用 "*" 通配)。 */
  private runConversationId: string | null = null;
  private intentByPlanner = new Map<string, string>(); // plannerSessionId → intentId (1:1, but tracked)
  private activeExecutors = new Map<string, Executor>(); // todoId → Executor
  private todoByExecutorSession = new Map<string, string>(); // executorSessionId → todoId
  private waiting = new Map<string, WaitingEntry>(); // executorSessionId → waiting state
  // A4:todoId → 跨 executor session 累计的 callback depth(旧实现按
  // executorSessionId 计,resume 每次换新 session → 计数恒 1 → depth limit 死代码)
  private depthByTodo = new Map<string, number>();

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
    this.plannerLlmCall = opts.plannerLlmCall;
    this.executorLlmCall = opts.executorLlmCall;
    // 注入 llmCall 的策略:wrapper factory 在 Planner/Executor 构造前修改 opts.llmCall,
    // 这样测试 factory 也能受益(若 factory 没显式设置 llmCall,默认会拿到 orchestrator 注入的值)。
    // 这避免了「factory 设置了一个会 throw 的 llmCall」的边界陷阱。
    this.plannerFactory =
      opts.plannerFactory ??
      ((p) => {
        if (this.plannerLlmCall && !p.llmCall) p.llmCall = this.plannerLlmCall;
        return new Planner(p);
      });
    this.executorFactory =
      opts.executorFactory ??
      ((e) => {
        if (this.executorLlmCall && !e.llmCall) e.llmCall = this.executorLlmCall;
        return new Executor(e);
      });
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
   * A2④:若 run() 尚未 settle,兜底 reject — 调用方(如 runPlan 的 finally)
   * 关闭实例时绝不让 await 永久挂起。幂等,可重复调用。
   */
  shutdown(): void {
    this.dispose();
    this.settlePendingRun(new Error("Orchestrator shutdown before run completed"));
  }

  /**
   * 取消当前 run(若有)。
   * A2③:abort 同步退订 bus(与 shutdown 共用 dispose)— 旧实现不退订,
   * abort 后的实例仍是全局 bus 订阅者(僵尸),会继续消费后续 run 的事件。
   * reject 语义保持:Error("Orchestrator aborted")。
   */
  abort(): void {
    this.dispose();
    this.settlePendingRun(new Error("Orchestrator aborted"));
  }

  /** shutdown/abort 共用清理:退订 bus + 清 watchdog/run timers + abort 在飞 executor。 */
  private dispose(): void {
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

  /** run() 未 settle 时以 err 兜底 reject(已 settle 则 no-op)。 */
  private settlePendingRun(err: Error): void {
    if (!this.runReject) return;
    const reject = this.runReject;
    this.runResolve = null;
    this.runReject = null;
    reject(err);
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
    // A2 ownership:先记录本 run 的 intentId + conversationId,再 publish —
    // bus handler 靠它们过滤「别人的 artifact」(僵尸实例/并行 run 的事件一律忽略)。
    this.myIntentId = intent.id;
    this.runConversationId = convId;
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

  /* ── Bus event handlers ─────────────────────────────────── */

  private async onArtifactCreated(e: ArtifactCreatedEvent): Promise<void> {
    const a = e.artifact;
    // A2 ownership:只响应本实例 run() 创建的 intent — 僵尸实例/别的 run 的
    // intent 一律忽略(旧实现无校验,导致每个新 intent 被所有历史实例重复
    // spawnPlanner + spawnExecutor,实证 planner=2 executor=2)。
    if (a.kind === "intent" && a.status === "open" && a.id === this.myIntentId) {
      this.sink?.({ type: "intent_received", intent: a });
      await this.spawnPlanner(a);
    }
  }

  private async onArtifactStatusChanged(e: ArtifactStatusChangedEvent): Promise<void> {
    // 1. intent resolved / failed → run() 收尾
    //    A2 ownership:只认本实例 run() 创建的 intent(旧实现对任何 intent 的
    //    终态都 completeRun,僵尸的旧 intent 收尾会用旧 blackboard resolve 新 run)。
    if (
      this.runResolve &&
      e.artifactId === this.myIntentId &&
      (e.newStatus === "resolved" || e.newStatus === "failed")
    ) {
      const intent = getArtifact(this.storage.db, e.artifactId);
      if (intent && intent.kind === "intent") {
        this.completeRun(intent);
        return;
      }
    }

    if (e.newStatus !== "resolved" && e.newStatus !== "failed") return;
    // A2 ownership:2/3 只处理本 run intent 派生的 todo,别人的 artifact 一律忽略。
    const a = e.artifactId ? getArtifact(this.storage.db, e.artifactId) : null;
    if (!a || a.kind !== "todo" || a.parentIntent !== this.myIntentId) return;

    // 2. dependency 终态 → 看是否有 waiting 下游 todo 可启动
    this.tryUnblockDependents(e.artifactId);

    // 3. todo resolved / failed → 上报
    if (e.newStatus === "resolved") {
      this.sink?.({ type: "todo_resolved", todo: a });
      // 上报后检查:本 todo 所属 intent 的所有 sibling todos 是否已终结
      this.maybeResolveIntent(a);
    } else {
      this.sink?.({
        type: "todo_failed",
        todo: a,
        reason: typeof a.metadata?.errorReason === "string" ? a.metadata.errorReason : "executor reported failure",
      });
      // A3-followup:上游 failed → 级联 fail 永远无法满足的 open 下游(否则 intent
      // 不终态,run 只能等满 maxRunMs 超时)。放在 maybeResolveIntent 之前:级联后
      // 全部 todo 已终态,本次调用即可立即收敛 intent → run 同步 settle。
      this.cascadeFailDependents(a.id, new Set<string>());
      this.maybeResolveIntent(a);
    }
  }

  /**
   * todo 终结后检查其 parent intent:若 intent 仍 open 且所有关联 todos 已 resolved/failed,
   * 则把 intent 标记 resolved(fail-fast:有任一 failed → failed,否则 resolved)。
   * 后续 onArtifactStatusChanged 会 → completeRun() → run() resolve。
   */
  private maybeResolveIntent(todo: BlackboardArtifact): void {
    const intentId = todo.parentIntent;
    if (!intentId) return;
    // A2 ownership(防御:调用方已过滤,这里兜底)
    if (intentId !== this.myIntentId) return;
    const intent = getArtifact(this.storage.db, intentId);
    if (!intent || intent.kind !== "intent") return;
    if (intent.status !== "open") return; // 已有 resolution
    // A3:废除 "*" 魔法值(listArtifacts 当字面量处理 → 恒空)。
    // intent 由 run() 创建时必带 conversationId;兜底取本 run 的记录值。
    const convId = intent.conversationId ?? this.runConversationId;
    if (!convId) return;
    const todos = listArtifacts(this.storage.db, {
      scope: "conversation",
      conversationId: convId,
    }).filter((a) => a.kind === "todo" && a.parentIntent === intentId);
    if (todos.length === 0) return;
    const pending = todos.filter((t) => t.status === "open" || t.status === "in_progress" || t.status === "waiting_for_decision");
    if (pending.length > 0) return;
    const anyFailed = todos.some((t) => t.status === "failed");
    const newStatus: ArtifactStatus = anyFailed ? "failed" : "resolved";
    updateArtifactStatus(this.storage.db, intentId, newStatus);
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: intentId,
      oldStatus: "open",
      newStatus,
      actor: "planner", // actor must be ArtifactAuthor; orchestrator isn't a registered author
    });
  }

  private async onExecutorCallback(e: ExecutorCallbackEvent): Promise<void> {
    const todoId = this.todoByExecutorSession.get(e.executorSessionId);
    if (!todoId) return;
    const todo = getArtifact(this.storage.db, todoId);
    const hypothesis = getArtifact(this.storage.db, e.hypothesisId);
    if (!todo || !hypothesis) return;

    // 1. depth tracking
    //    A4 修复(docs/CODE-REVIEW-2026-10-01.md §A4):按 todoId 跨 session 累计 —
    //    旧实现按 executorSessionId 计,而每次 resume 都新建 Executor(新 sessionId),
    //    计数恒从 1 起 → failTodoDueToDepth 生产不可达 → 无界提问循环没有防线。
    const currentDepth = (this.depthByTodo.get(todoId) ?? 0) + 1;
    this.depthByTodo.set(todoId, currentDepth);
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
      await this.routeCallback({
        todoId,
        reason: hypothesis.metadata?.callbackReason ?? "judgment",
        hypothesisId: e.hypothesisId,
        executorSessionId: e.executorSessionId,
      });
      // A2 语义(移除旧 maybeResolveRunOnBlocked 的提前 settle):
      // todo 进入 waiting_for_decision 后 run() 保持 pending,跨越
      // 「提问 → 用户 decision → executor_resume → 重跑」完整周期,intent 终态
      // (或 abort/shutdown/maxRunMs 超时)才收尾。理由:
      //  - ws.ts runPlan 的 finally 在 run() 返回后立即 shutdown()(退订 bus);
      //    若阻塞时提前 settle,之后的 executor_resume 无人消费,用户回答永远
      //    无法恢复 executor(集成测试场景④ / 审查报告 §A4 回路)。
      //  - plan_done 在问题还挂起时发出(summary "完成 0/1")对用户是错误信号。
      //  - 挂起有界:escalation(5min)/fail(1hr)watchdog + maxRunMs(默认 30min)。
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
    //    A4:decision 的 title+body 随 resume 注入重跑 prompt(此前只喂了 sink,
    //    Executor 端拿不到用户回答全文 → 大概率重复提问)
    await this.resumeExecutor(todo, decision);
  }

  /* ── Private orchestration logic ───────────────────────── */

  private async spawnPlanner(intent: BlackboardArtifact): Promise<void> {
    const planner = this.plannerFactory({ storage: this.storage });
    try {
      const result = await planner.plan(intent);
      // intent 在 plan() 期间可能已被标为 failed(parse-fail / 0 valid todos)。
      // 此时不应再发 todos_planned(也不应启动 executor)。
      const currentIntent = getArtifact(this.storage.db, intent.id);
      if (currentIntent?.status !== "open") {
        return;
      }
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
      // A2 ownership:只解锁本 run intent 派生的 todo(同 conversation 里
      // 其他 run 的 todo 一律不碰,避免跨实例重复执行)
      if (todo.parentIntent !== this.myIntentId) continue;
      if (todo.status !== "open") continue;
      if (this.areDepsResolved(todo)) {
        void this.spawnExecutor(todo);
      }
    }
  }

  private findTodosDependingOn(artifactId: string): string[] {
    // A3 修复(docs/CODE-REVIEW-2026-10-01.md §A3):旧实现在 conversation scope 传
    // conversationId:"*",而 storage/repo/blackboards.ts listArtifacts 把它当**字面量**
    // SQL 参数(无通配语义)→ 恒返回 0 条 → tryUnblockDependents 永远找不到下游 →
    // 任何带 dependsOn 的计划上游 resolve 后下游永不 spawn → 挂到 maxRunMs 超时。
    // 现在传本 run 的真实 conversationId(Planner 落库的 todos 全部继承 intent 的
    // conversationId);global scope 扫描保留(不限 conversationId)。
    const out: string[] = [];
    const collect = (all: BlackboardArtifact[]) => {
      for (const a of all) {
        if (a.kind !== "todo") continue;
        if (a.dependsOn && a.dependsOn.includes(artifactId)) out.push(a.id);
      }
    };
    collect(listArtifacts(this.storage.db, { scope: "global", limit: 200 }));
    const convId = this.runConversationId;
    if (convId) {
      collect(
        listArtifacts(this.storage.db, {
          scope: "conversation",
          conversationId: convId,
          limit: 200,
        }),
      );
    }
    return out;
  }

  /**
   * A3-followup(审查报告 §A3 open question #2 → 批次 1 追加任务):dep-failed 级联。
   *
   * areDepsResolved 要求全部 deps resolved —— 上游 todo failed 后,下游永远 open、
   * intent 不终态,run 只能等满 maxRunMs(默认 30min)超时收尾。现在:上游进入
   * failed 终态即递归级联 fail 仍 open(阻塞在依赖上)的下游 todo,随后走既有
   * maybeResolveIntent 终态路径 → run 立即 settle,不等超时。
   *
   * 语义边界:
   * - 只对 status === "open" 级联(仍阻塞在依赖上、从未成功 spawn)。
   *   in_progress / waiting_for_decision 有自己的生命周期与 watchdog,不动;
   *   resolved / superseded / failed 已终态,自然跳过。
   * - 防环/幂等:visited 集合去重(planner 侧有 dropCycles,但 storage 可能存在
   *   历史脏 dependsOn,不能无限递归);failTodo 的 publish 会重入 case3 →
   *   本方法(新 visited),但已级联 failed 的 todo 被 status 过滤跳过,两条路径
   *   互为幂等。
   * - 级联 reason 写入 metadata.errorReason(持久化 + case3 sink 同源读取),
   *   文案注明上游 id:`cascade from <upstreamId>`。
   * - ownership(A2):只级联本 run intent 派生的 todo。
   */
  private cascadeFailDependents(upstreamTodoId: string, visited: Set<string>): void {
    if (visited.has(upstreamTodoId)) return;
    visited.add(upstreamTodoId);
    for (const depId of this.findTodosDependingOn(upstreamTodoId)) {
      if (visited.has(depId)) continue;
      visited.add(depId);
      const dep = getArtifact(this.storage.db, depId);
      if (!dep) continue;
      if (dep.parentIntent !== this.myIntentId) continue;
      if (dep.status !== "open") continue;
      const reason = `cascade from ${upstreamTodoId}: upstream dependency failed`;
      dep.metadata = { ...(dep.metadata ?? {}), errorReason: reason };
      upsertArtifact(this.storage.db, dep);
      // failTodo → publish status_changed → 重入 case3(sink todo_failed 携带
      // cascade reason + 对更深层级联)+ maybeResolveIntent;随后的显式递归
      // 兜底覆盖剩余分支(status 过滤保证幂等)
      this.failTodo(dep, new Error(reason));
      this.cascadeFailDependents(depId, visited);
    }
  }

  private async spawnExecutor(
    todo: BlackboardArtifact,
    pendingDecision?: { title: string; body: string },
  ): Promise<void> {
    if (this.activeExecutors.has(todo.id)) return;
    // A4:resume 重跑时把 decision 传给 Executor → buildUserPrompt 输出
    // 「# Decision(来自用户/Communicator)」段落(用户回答全文在 body,逐字注入)
    const executor = this.executorFactory({ storage: this.storage, pendingDecision });
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

  private async resumeExecutor(
    todo: BlackboardArtifact,
    decision?: BlackboardArtifact,
  ): Promise<void> {
    // Resume:新建 Executor 重新 execute()(原实例已结束生命周期,不复用)。
    // A4:decision artifact 的 title+body 经 pendingDecision 注入重跑 userPrompt。
    // 注意:depth 在 onExecutorCallback 按 todoId 跨 session 累计,这里不重置
    // (深度限制针对整条 callback chain,不是单个 session)。
    if (this.activeExecutors.has(todo.id)) return;
    if (this.areDepsResolved(todo)) {
      await this.spawnExecutor(
        todo,
        decision ? { title: decision.title, body: decision.body } : undefined,
      );
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

  // A2 注:旧 maybeResolveRunOnBlocked(阻塞回调时提前 settle run())已移除 —
  // 见 onExecutorCallback 内的语义说明。run() 的 settle 路径收敛为:
  // intent 终态(completeRun)/ abort / shutdown / maxRunMs 超时,四者必居其一。

  private completeRun(intent: BlackboardArtifact): void {
    if (!this.runResolve) return;
    if (this.runTimer) {
      clearTimeout(this.runTimer);
      this.runTimer = null;
    }
    const resolve = this.runResolve;
    this.runResolve = null;
    this.runReject = null;
    // A3:废除 "*" 魔法值 — conversation scope 必须用真实 conversationId,
    // 否则 listArtifacts 按字面量 "*" 查询恒空,plan_done 的 artifacts/summary 全丢。
    const convId = intent.conversationId ?? this.runConversationId ?? "";
    const artifacts = listArtifacts(this.storage.db, {
      scope: intent.scope === "global" ? "global" : "conversation",
      conversationId: convId,
      limit: 500,
    });
    const shape: BlackboardShape = {
      conversationId: convId,
      artifacts,
      scope: intent.scope ?? "global",
    };
    // A1 修复(docs/CODE-REVIEW-2026-10-01.md §A1):先 settle promise,再调 sink。
    // 旧实现先 sink 后 resolve:ws.ts 的 sink 在 completed 分支抛错(TDZ)时
    // resolve 不可达,且 runResolve/runReject 已置 null → runTimer 变 no-op →
    // run() 永久挂起;sink 异常还会沿 bus 的 void handler 逃逸成 unhandled rejection。
    // 现在:resolve 先行保证 run() 必然 settle;sink 异常就地捕获记录,不再外逃。
    resolve(shape);
    try {
      this.sink?.({ type: "completed", intent });
    } catch (err) {
      log.warn("completeRun: progress sink threw (run already settled):", err);
    }
  }
}

/* ────────────────────────────────────────────────────────── *
 * Default callback router
 * ────────────────────────────────────────────────────────── */

const defaultRouteCallback: CallbackRouter = (_arg) => {
  // 默认行为:仅通过 artifactBus 的 executor_callback event 通知外部订阅者
  // (Communicator 已在 B2 阶段被设计成 bus 订阅者)
  // 这里啥都不做 — event 已经被 Orchestrator 处理过(触发 watchdog + depth tracking)
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
