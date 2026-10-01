/**
 * Sansheng · Executor · M3+ B3
 *
 * 角色:执行一个 `todo` artifact,产出 `evidence`(成功) / `hypothesis`(阻塞) / `note`(失败)。
 * 由 Orchestrator 在 todo 被 dispatch 时调用一次。
 *
 * 设计点:
 * - **DAG-aware**:执行前检查 dependsOn[] 全部 resolved;若有 unresolved → 标 todo `waiting_for_dependency`
 *   并等待 Orchestrator 在 `artifact_status_changed` 事件中唤醒
 * - **JSON-only 输出**:同 Planner;失败 → 写 note + mark todo failed
 * - **callback 触发**:写 hypothesis 后 emit `executor_callback` event,Orchestrator 端 watchdog + depth limit 接管
 * - **executorSessionId**:唯一标识一次执行,用于 callback 路由
 *
 * 不做的事:
 * - 不调 MessageBus —— Executor 只关心 BlackboardArtifact bus
 * - 不做并行 —— Executor 一次性跑完
 * - 不直接 call Communicator —— 通过 bus `executor_callback` 让 Orchestrator 路由
 */

import { nanoid } from "nanoid";
import type { BlackboardArtifact, ArtifactStatus, CallbackReason } from "../../../shared/types/blackboard.js";
import { artifactBus, makeArtifact } from "../bus/index.js";
import {
  upsertArtifact,
  updateArtifactStatus,
  getArtifact,
} from "../storage/index.js";
import type { Storage } from "../storage/index.js";

/* ────────────────────────────────────────────────────────── *
 * 注入接口(测试可替换)
 * ────────────────────────────────────────────────────────── */

export interface ExecutorLlmCall {
  (input: { systemPrompt: string; userPrompt: string }): Promise<string>;
}

export interface ExecutorOptions {
  storage: Storage;
  bus?: typeof artifactBus;
  llmCall?: ExecutorLlmCall;
  systemPrompt?: string;
  now?: () => number;
  /**
   * A4(docs/CODE-REVIEW-2026-10-01.md §A4):resume 重跑时注入的用户/Communicator
   * decision(decision artifact 的 title+body)。用户回答全文在 body 里 —
   * 不注入时 LLM 只能在 siblings 上下文里看到一行标题(`[decision/open] User
   * decision for q-exec-x`),大概率重复产同一 hypothesis → 无界提问循环。
   */
  pendingDecision?: { title: string; body: string };
}

export type ExecutorOutcome =
  | { outcome: "evidence"; evidence: PlannedEvidence; nextStatus: "resolved" }
  | {
      outcome: "hypothesis";
      hypothesis: PlannedHypothesis;
      nextStatus: "waiting_for_decision";
    }
  | { outcome: "failed"; note: PlannedNote; nextStatus: "failed" };

export interface PlannedEvidence {
  title: string;
  body: string;
  metadata?: BlackboardArtifact["metadata"];
}

export interface PlannedHypothesis {
  title: string;
  body: string;
  callbackReason: CallbackReason;
  metadata?: BlackboardArtifact["metadata"];
}

export interface PlannedNote {
  title: string;
  body: string;
  metadata?: BlackboardArtifact["metadata"];
}

export interface ExecutorResult {
  todoId: string;
  executorSessionId: string;
  outcome: ExecutorOutcome["outcome"];
  artifactIds: string[]; // ids of artifacts produced (evidence/hypothesis/note)
}

/* ────────────────────────────────────────────────────────── *
 * Executor class
 * ────────────────────────────────────────────────────────── */

export class Executor {
  private readonly storage: Storage;
  private readonly bus: typeof artifactBus;
  private readonly llmCall: ExecutorLlmCall;
  private readonly systemPrompt: string;
  private readonly now: () => number;
  /** A4:resume 重跑时携带的用户/Communicator decision(首次执行为 undefined)。 */
  private readonly pendingDecision: { title: string; body: string } | undefined;
  /** 暴露给 Orchestrator 的 session id(由 ctor 时生成,稳定到本 Executor 生命周期)。 */
  readonly sessionId: string;
  private aborted = false;

  constructor(opts: ExecutorOptions) {
    this.storage = opts.storage;
    this.bus = opts.bus ?? artifactBus;
    this.llmCall = opts.llmCall ?? defaultExecutorLlmCall;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_EXECUTOR_PROMPT;
    this.now = opts.now ?? Date.now;
    this.pendingDecision = opts.pendingDecision;
    this.sessionId = `exec-${nanoid(10)}`;
  }

  /**
   * 主入口:接 todo → 产 outcome artifact(s) + 状态变更。
   *
   * 返回时,storage 已 upsert,bus 已 publish;Orchestrator 端只需订阅即可。
   * dependsOn 未满足时:标记 todo 为 `waiting_for_dependency`,return 即可(不产 artifact)。
   */
  async execute(todo: BlackboardArtifact): Promise<ExecutorResult> {
    if (this.aborted) {
      return { todoId: todo.id, executorSessionId: this.sessionId, outcome: "failed", artifactIds: [] };
    }
    if (todo.kind !== "todo") {
      throw new Error(`Executor.execute: expected kind='todo', got '${todo.kind}'`);
    }

    // 1. dependsOn 检查
    if (todo.dependsOn && todo.dependsOn.length > 0) {
      const unresolved = todo.dependsOn.filter((depId) => {
        const dep = getArtifact(this.storage.db, depId);
        return !dep || dep.status !== "resolved";
      });
      if (unresolved.length > 0) {
        // 阻塞:保持 todo.status='open',等 Orchestrator 在上游 artifact 状态变更时
        // 通过 tryUnblockDependents() 重新触发 spawnExecutorIfReady。不引入额外的
        // "waiting_for_dependency" 状态(超出 ArtifactStatus 语义),也避免让
        // onArtifactStatusChanged 把这个 todo 当作 failed 处理。
        return {
          todoId: todo.id,
          executorSessionId: this.sessionId,
          outcome: "failed", // 当前 run 中算 pending,不是真的失败
          artifactIds: [],
        };
      }
    }

    // 2. mark in_progress(让 UI 看到 Executor 正在干)
    updateArtifactStatus(this.storage.db, todo.id, "in_progress");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: todo.id,
      oldStatus: "open",
      newStatus: "in_progress",
      actor: "executor",
    });

    // 3. 收集 context(siblings artifacts)
    const context = await this.gatherContext(todo);

    // 4. 调 LLM
    const userPrompt = this.buildUserPrompt(todo, context);
    let raw: string;
    try {
      raw = await this.llmCall({ systemPrompt: this.systemPrompt, userPrompt });
    } catch (err) {
      // LLM 失败 → 写 failure note + mark todo failed
      await this.handleLlmFailure(todo, err);
      return {
        todoId: todo.id,
        executorSessionId: this.sessionId,
        outcome: "failed",
        artifactIds: [],
      };
    }

    // 5. Parse JSON
    const parsed = this.parseOutcome(raw);
    if (parsed === null) {
      await this.handleParseFailure(todo, raw);
      return {
        todoId: todo.id,
        executorSessionId: this.sessionId,
        outcome: "failed",
        artifactIds: [],
      };
    }

    // 6. 落 artifact + 更新 todo status
    return await this.persistOutcome(todo, parsed);
  }

  abort(): void {
    this.aborted = true;
  }

  /* ── private helpers ────────────────────────────────────── */

  private async gatherContext(todo: BlackboardArtifact): Promise<BlackboardArtifact[]> {
    const { listArtifacts } = await import("../storage/index.js");
    if (!todo.conversationId) return [];
    return listArtifacts(this.storage.db, {
      scope: "conversation",
      conversationId: todo.conversationId,
      limit: 50,
    });
  }

  private buildUserPrompt(todo: BlackboardArtifact, siblings: BlackboardArtifact[]): string {
    const parts: string[] = [];
    parts.push(`# Todo`);
    parts.push(`id: ${todo.id}`);
    parts.push(`title: ${todo.title}`);
    parts.push(`body: ${todo.body}`);
    if (todo.parentIntent) parts.push(`parentIntent: ${todo.parentIntent}`);
    if (todo.dependsOn && todo.dependsOn.length > 0) {
      parts.push(`dependsOn (all resolved): ${todo.dependsOn.join(", ")}`);
    }
    // A4(docs/CODE-REVIEW-2026-10-01.md §A4):resume 重跑时逐字注入用户/Communicator
    // 的 decision(回答全文在 decision.body)。放在 siblings 之前 — 这是本次重跑
    // 最关键的上下文;不注入时 LLM 只能在 siblings 里看到一行 decision 标题。
    if (this.pendingDecision) {
      parts.push("");
      parts.push(`# Decision(来自用户/Communicator)`);
      parts.push(`title: ${this.pendingDecision.title}`);
      parts.push(this.pendingDecision.body);
    }
    if (siblings.length > 0) {
      parts.push("");
      parts.push(`# Sibling Blackboard Artifacts (${siblings.length})`);
      for (const a of siblings) {
        const prefix = a.id === todo.id ? "→ " : "  ";
        parts.push(`${prefix}[${a.kind}/${a.status}] ${a.title} (id=${a.id})`);
      }
    }
    parts.push("");
    parts.push(`# Task`);
    parts.push(
      `Produce JSON describing the outcome. Output JSON only, no markdown fence.`,
    );
    return parts.join("\n");
  }

  private parseOutcome(raw: string): ExecutorOutcome | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let jsonText = trimmed;
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence && fence[1]) jsonText = fence[1].trim();
    else {
      const brace = jsonText.indexOf("{");
      if (brace >= 0) jsonText = jsonText.slice(brace);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    if (obj.outcome === "evidence") {
      const ev = obj.evidence as Record<string, unknown> | undefined;
      if (!ev || typeof ev.title !== "string") return null;
      return {
        outcome: "evidence",
        nextStatus: "resolved",
        evidence: {
          title: ev.title.slice(0, 200),
          body: typeof ev.body === "string" ? ev.body : "",
          metadata: (ev.metadata as BlackboardArtifact["metadata"]) ?? undefined,
        },
      };
    }

    if (obj.outcome === "hypothesis") {
      const hyp = obj.hypothesis as Record<string, unknown> | undefined;
      if (!hyp || typeof hyp.title !== "string") return null;
      const reason = hyp.callbackReason === "harness_proposal" ? "harness_proposal" : "judgment";
      const meta = (hyp.metadata as BlackboardArtifact["metadata"]) ?? {};
      return {
        outcome: "hypothesis",
        nextStatus: "waiting_for_decision",
        hypothesis: {
          title: hyp.title.slice(0, 200),
          body: typeof hyp.body === "string" ? hyp.body : "",
          callbackReason: reason,
          metadata: { ...meta, callbackReason: reason },
        },
      };
    }

    if (obj.outcome === "failed") {
      const note = obj.note as Record<string, unknown> | undefined;
      if (!note || typeof note.title !== "string") return null;
      return {
        outcome: "failed",
        nextStatus: "failed",
        note: {
          title: note.title.slice(0, 200),
          body: typeof note.body === "string" ? note.body : "",
          metadata: (note.metadata as BlackboardArtifact["metadata"]) ?? undefined,
        },
      };
    }
    return null;
  }

  private async persistOutcome(
    todo: BlackboardArtifact,
    parsed: ExecutorOutcome,
  ): Promise<ExecutorResult> {
    const ts = this.now();
    const artifactIds: string[] = [];

    if (parsed.outcome === "evidence") {
      const evidenceId = `ev-${nanoid(10)}`;
      const evidence = makeArtifact({
        id: evidenceId,
        scope: todo.scope,
        conversationId: todo.conversationId,
        kind: "evidence",
        title: parsed.evidence.title,
        body: parsed.evidence.body,
        author: "executor",
        status: "resolved",
        parentIntent: todo.parentIntent,
        metadata: {
          relatedArtifacts: [todo.id, ...((parsed.evidence.metadata?.relatedArtifacts as string[] | undefined) ?? [])],
          ...parsed.evidence.metadata,
        },
        createdAt: ts,
        updatedAt: ts,
      });
      upsertArtifact(this.storage.db, evidence);
      this.bus.publish({ type: "artifact_created", artifact: evidence });
      artifactIds.push(evidenceId);
      updateArtifactStatus(this.storage.db, todo.id, "resolved");
      this.bus.publish({
        type: "artifact_status_changed",
        artifactId: todo.id,
        oldStatus: "in_progress",
        newStatus: "resolved",
        actor: "executor",
      });
    } else if (parsed.outcome === "hypothesis") {
      const hypothesisId = `hyp-${nanoid(10)}`;
      const hypothesis = makeArtifact({
        id: hypothesisId,
        scope: todo.scope,
        conversationId: todo.conversationId,
        kind: "hypothesis",
        title: parsed.hypothesis.title,
        body: parsed.hypothesis.body,
        author: "executor",
        status: "open",
        parentIntent: todo.parentIntent,
        metadata: {
          relatedArtifacts: [todo.id],
          callbackReason: parsed.hypothesis.callbackReason,
          ...parsed.hypothesis.metadata,
        },
        createdAt: ts,
        updatedAt: ts,
      });
      upsertArtifact(this.storage.db, hypothesis);
      this.bus.publish({ type: "artifact_created", artifact: hypothesis });
      artifactIds.push(hypothesisId);

      // mark todo as waiting_for_decision(用户 / Communicator 决策时再 resume)
      updateArtifactStatus(this.storage.db, todo.id, "waiting_for_decision");
      this.bus.publish({
        type: "artifact_status_changed",
        artifactId: todo.id,
        oldStatus: "in_progress",
        newStatus: "waiting_for_decision",
        actor: "executor",
      });

      // emit executor_callback event — Orchestrator 端路由到 Communicator
      this.bus.publish({
        type: "executor_callback",
        executorSessionId: this.sessionId,
        hypothesisId,
        reason: parsed.hypothesis.callbackReason,
      });
    } else {
      // failed
      const noteId = `exec-err-${nanoid(8)}`;
      const note = makeArtifact({
        id: noteId,
        scope: todo.scope,
        conversationId: todo.conversationId,
        kind: "note",
        title: parsed.note.title,
        body: parsed.note.body,
        author: "executor",
        status: "resolved",
        parentIntent: todo.parentIntent,
        metadata: {
          relatedArtifacts: [todo.id],
          ...parsed.note.metadata,
        },
        createdAt: ts,
        updatedAt: ts,
      });
      upsertArtifact(this.storage.db, note);
      this.bus.publish({ type: "artifact_created", artifact: note });
      artifactIds.push(noteId);

      // todo status 已在 parsed.nextStatus = "failed",显式 publish status change
      updateArtifactStatus(this.storage.db, todo.id, "failed");
      this.bus.publish({
        type: "artifact_status_changed",
        artifactId: todo.id,
        oldStatus: "in_progress",
        newStatus: "failed",
        actor: "executor",
      });
    }

    return {
      todoId: todo.id,
      executorSessionId: this.sessionId,
      outcome: parsed.outcome,
      artifactIds,
    };
  }

  private async handleParseFailure(todo: BlackboardArtifact, raw: string): Promise<void> {
    const ts = this.now();
    const noteId = `exec-err-${nanoid(8)}`;
    const note = makeArtifact({
      id: noteId,
      scope: todo.scope,
      conversationId: todo.conversationId,
      kind: "note",
      title: `Executor · parse failed for ${todo.id.slice(0, 8)}`,
      body: `Executor LLM output not valid JSON outcome.\n\nRaw (first 500 chars):\n${raw.slice(0, 500)}`,
      author: "executor",
      status: "resolved",
      parentIntent: todo.parentIntent,
      metadata: { relatedArtifacts: [todo.id] },
      createdAt: ts,
      updatedAt: ts,
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    updateArtifactStatus(this.storage.db, todo.id, "failed");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: todo.id,
      oldStatus: "in_progress",
      newStatus: "failed",
      actor: "executor",
    });
  }

  private async handleLlmFailure(todo: BlackboardArtifact, err: unknown): Promise<void> {
    const ts = this.now();
    const msg = err instanceof Error ? err.message : String(err);
    const noteId = `exec-err-${nanoid(8)}`;
    const note = makeArtifact({
      id: noteId,
      scope: todo.scope,
      conversationId: todo.conversationId,
      kind: "note",
      title: `Executor · LLM failed for ${todo.id.slice(0, 8)}`,
      body: `LLM call threw: ${msg}`,
      author: "executor",
      status: "resolved",
      parentIntent: todo.parentIntent,
      metadata: { relatedArtifacts: [todo.id] },
      createdAt: ts,
      updatedAt: ts,
    });
    upsertArtifact(this.storage.db, note);
    this.bus.publish({ type: "artifact_created", artifact: note });

    updateArtifactStatus(this.storage.db, todo.id, "failed");
    this.bus.publish({
      type: "artifact_status_changed",
      artifactId: todo.id,
      oldStatus: "in_progress",
      newStatus: "failed",
      actor: "executor",
    });
  }
}

/* ────────────────────────────────────────────────────────── *
 * Default LLM call + prompt
 * ────────────────────────────────────────────────────────── */

const defaultExecutorLlmCall: ExecutorLlmCall = async () => {
  throw new Error(
    "Executor.llmCall not injected. Orchestrator boot must provide a real LLM call.",
  );
};

export const DEFAULT_EXECUTOR_PROMPT = `# Sansheng · Executor

执行一个 todo,产 outcome JSON:
- outcome=evidence → {evidence:{title,body,metadata?}, nextStatus:"resolved"}
- outcome=hypothesis → {hypothesis:{title,body,callbackReason,metadata?}, nextStatus:"waiting_for_decision"}
- outcome=failed → {note:{title,body}, nextStatus:"failed"}

不要解释,不要 markdown fence。
`;

/* ────────────────────────────────────────────────────────── *
 * Re-exports
 * ────────────────────────────────────────────────────────── */

export type { BlackboardArtifact, ArtifactStatus };
