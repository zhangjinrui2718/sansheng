/**
 * Sansheng blackboards repo · M3b + M3+ B1
 *
 * M3b:每个 conversation 一行 Blackboard 快照;新 run 创建新行,旧 run 保留为历史。
 *     Orchestrator 在 run 结束后调用 upsertBlackboard 写入。
 *
 * M3+ B1: artifact CRUD(upsertArtifact / getArtifact / listArtifacts / updateArtifactStatus)
 *     + migrateBlackboardArtifacts(row) — 旧 `produced_artifacts_json` + `decisions_json`
 *     升级为 `artifacts_json`(best-effort,additive)。
 */
import type Database from "better-sqlite3";
import type { Blackboard } from "@shared/types/agents";
import {
  ARTIFACT_KINDS,
  ARTIFACT_STATUSES,
  CALLBACK_REASONS,
  isArtifactKind,
  isArtifactStatus,
  type BlackboardArtifact,
  type BlackboardScope,
  type ArtifactStatus,
} from "../../../../shared/types/blackboard.js";

// ───────────────────────────── Legacy Blackboard (M3b, unchanged) ─────────────────────────────

export function upsertBlackboard(db: Database.Database, bb: Blackboard): number {
  const stmt = db.prepare(`INSERT INTO blackboards
    (conversation_id, goal, plan_json, todos_json, evidence_json, critique_json,
     retrieved_memories_json, decisions_json, produced_artifacts_json, ts, version,
     iteration, status, created_at, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const r = stmt.run(
    bb.conversationId,
    bb.goal,
    JSON.stringify(bb.plan),
    JSON.stringify(bb.todos),
    JSON.stringify(bb.evidence),
    JSON.stringify(bb.critique),
    JSON.stringify(bb.retrievedMemories),
    JSON.stringify(bb.decisions),
    JSON.stringify(bb.producedArtifacts),
    bb.ts,
    bb.version,
    bb.iteration,
    bb.status,
    bb.createdAt,
  );
  return Number(r.lastInsertRowid);
}

export function getBlackboard(db: Database.Database, id: number): Blackboard | null {
  const row = db
    .prepare(`SELECT * FROM blackboards WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToBlackboard(row) : null;
}

export function getActiveBlackboard(
  db: Database.Database,
  conversationId: string,
): Blackboard | null {
  const row = db
    .prepare(
      `SELECT * FROM blackboards WHERE conversation_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(conversationId) as Record<string, unknown> | undefined;
  return row ? rowToBlackboard(row) : null;
}

export function listBlackboards(
  db: Database.Database,
  conversationId: string,
  limit: number = 50,
): Blackboard[] {
  const rows = db
    .prepare(
      `SELECT * FROM blackboards WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(conversationId, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToBlackboard);
}

export function markBlackboardStatus(
  db: Database.Database,
  id: number,
  status: Blackboard["status"],
): void {
  db.prepare(`UPDATE blackboards SET status = ? WHERE id = ?`).run(status, id);
}

function rowToBlackboard(row: Record<string, unknown>): Blackboard {
  return {
    id: row.id as number,
    conversationId: row.conversation_id as string,
    goal: (row.goal as string | null) ?? "",
    plan: JSON.parse((row.plan_json as string | null) ?? "[]"),
    todos: JSON.parse((row.todos_json as string | null) ?? "[]"),
    evidence: JSON.parse((row.evidence_json as string | null) ?? "[]"),
    critique: JSON.parse((row.critique_json as string | null) ?? "[]"),
    retrievedMemories: JSON.parse((row.retrieved_memories_json as string | null) ?? "[]"),
    decisions: JSON.parse((row.decisions_json as string | null) ?? "[]"),
    producedArtifacts: JSON.parse((row.produced_artifacts_json as string | null) ?? "[]"),
    ts: row.ts as number,
    version: row.version as number,
    iteration: row.iteration as number,
    status: row.status as Blackboard["status"],
    createdAt: row.created_at as number,
  };
}

// ───────────────────────────── M3+ B1: BlackboardArtifact v3 CRUD ─────────────────────────────

/**
 * Validate a BlackboardArtifact's whitelisted enums. Throws on invalid input.
 * (HTTP layer catches and returns 400.)
 */
export function validateArtifact(artifact: BlackboardArtifact): void {
  if (!artifact || typeof artifact !== "object") {
    throw new Error("artifact required");
  }
  if (!artifact.id || typeof artifact.id !== "string") {
    throw new Error("artifact.id required (string)");
  }
  if (!isArtifactKind(artifact.kind)) {
    throw new Error(
      `artifact.kind invalid: ${String(artifact.kind)} (allowed: ${ARTIFACT_KINDS.join(", ")})`,
    );
  }
  if (!isArtifactStatus(artifact.status)) {
    throw new Error(
      `artifact.status invalid: ${String(artifact.status)} (allowed: ${ARTIFACT_STATUSES.join(", ")})`,
    );
  }
  if (
    artifact.metadata?.callbackReason !== undefined &&
    !(CALLBACK_REASONS as ReadonlyArray<string>).includes(artifact.metadata.callbackReason)
  ) {
    throw new Error(
      `metadata.callbackReason invalid: ${String(artifact.metadata.callbackReason)} (allowed: ${CALLBACK_REASONS.join(", ")})`,
    );
  }
  if (artifact.scope !== "global" && artifact.scope !== "conversation") {
    throw new Error(
      `artifact.scope invalid: ${String(artifact.scope)} (allowed: global, conversation)`,
    );
  }
  if (artifact.scope === "conversation" && !artifact.conversationId) {
    throw new Error("artifact.conversationId required when scope='conversation'");
  }
  if (typeof artifact.title !== "string") {
    throw new Error("artifact.title required (string)");
  }
  if (typeof artifact.body !== "string") {
    throw new Error("artifact.body required (string)");
  }
  if (typeof artifact.createdAt !== "number" || typeof artifact.updatedAt !== "number") {
    throw new Error("artifact.createdAt / updatedAt required (number)");
  }
}

/** Global blackboard conversationId sentinel(D1: 双 scope). */
export const GLOBAL_BLACKBOARD_ID = "__global__";

/**
 * Get-or-create the active Blackboard row that hosts artifacts for a given scope.
 * Returns the row id.
 */
function ensureArtifactBlackboard(
  db: Database.Database,
  scope: BlackboardScope,
  conversationId: string | undefined,
): number {
  const cid = scope === "global" ? GLOBAL_BLACKBOARD_ID : (conversationId ?? "");
  if (!cid) {
    throw new Error("conversationId required for scope='conversation'");
  }
  const existing = db
    .prepare(
      `SELECT id FROM blackboards WHERE conversation_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(cid) as { id: number } | undefined;
  if (existing) return existing.id;

  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO blackboards
        (conversation_id, goal, plan_json, todos_json, evidence_json, critique_json,
         retrieved_memories_json, decisions_json, produced_artifacts_json,
         artifacts_json, ts, version, iteration, status, created_at, schema_version)
       VALUES (?, '', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', ?, 1, 0, 'active', ?, 5)`,
    )
    .run(cid, now, now);
  return Number(r.lastInsertRowid);
}

function readArtifactsJson(db: Database.Database, blackboardId: number): string {
  const row = db
    .prepare(`SELECT artifacts_json FROM blackboards WHERE id = ?`)
    .get(blackboardId) as { artifacts_json: string | null } | undefined;
  return row?.artifacts_json ?? "[]";
}

function writeArtifactsJson(
  db: Database.Database,
  blackboardId: number,
  artifacts: BlackboardArtifact[],
): void {
  db.prepare(`UPDATE blackboards SET artifacts_json = ? WHERE id = ?`).run(
    JSON.stringify(artifacts),
    blackboardId,
  );
}

/**
 * Insert or update a single BlackboardArtifact.
 * Throws on validation failure. Use try/catch in HTTP layer to return 400.
 */
export function upsertArtifact(db: Database.Database, artifact: BlackboardArtifact): void {
  validateArtifact(artifact);
  // Normalize: global scope always has conversationId='__global__'.
  const scope = artifact.scope;
  const conversationId =
    scope === "global" ? GLOBAL_BLACKBOARD_ID : artifact.conversationId;

  const txn = db.transaction(() => {
    const blackboardId = ensureArtifactBlackboard(db, scope, conversationId);
    const raw = readArtifactsJson(db, blackboardId);
    let arr: BlackboardArtifact[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed as BlackboardArtifact[];
    } catch {
      arr = [];
    }
    // Stamp scope + conversationId on the stored artifact for consistency.
    const normalized: BlackboardArtifact = {
      ...artifact,
      scope,
      conversationId,
    };
    const idx = arr.findIndex((a) => a.id === artifact.id);
    if (idx >= 0) {
      arr[idx] = normalized;
    } else {
      arr.push(normalized);
    }
    writeArtifactsJson(db, blackboardId, arr);
  });
  txn();
}

/**
 * Find a BlackboardArtifact by id across all Blackboard rows.
 * Returns null if not found.
 */
export function getArtifact(db: Database.Database, id: string): BlackboardArtifact | null {
  if (!id) return null;
  // SQLite json_each handles invalid JSON gracefully — but be defensive.
  const rows = db
    .prepare(
      `SELECT id, conversation_id, artifacts_json
       FROM blackboards
       WHERE artifacts_json IS NOT NULL AND artifacts_json != '[]'`,
    )
    .all() as Array<{ id: number; conversation_id: string; artifacts_json: string }>;
  for (const row of rows) {
    let arr: unknown;
    try {
      arr = JSON.parse(row.artifacts_json);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const a of arr) {
      if (a && typeof a === "object" && (a as { id?: unknown }).id === id) {
        return a as BlackboardArtifact;
      }
    }
  }
  return null;
}

export interface ListArtifactsOptions {
  scope?: BlackboardScope;
  kind?: string;
  status?: string;
  limit?: number;
  /** When scope='conversation' (default), filter by this conversationId. */
  conversationId?: string;
}

/**
 * List BlackboardArtifacts with optional filters.
 * Defaults: scope='conversation' (require conversationId), no kind/status filter.
 */
export function listArtifacts(
  db: Database.Database,
  opts: ListArtifactsOptions = {},
): BlackboardArtifact[] {
  const scope: BlackboardScope = opts.scope ?? "conversation";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);

  // Build conversation_id filter.
  let conversationIds: string[];
  if (scope === "global") {
    conversationIds = [GLOBAL_BLACKBOARD_ID];
  } else {
    if (!opts.conversationId) {
      return [];
    }
    conversationIds = [opts.conversationId];
  }

  const placeholders = conversationIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT artifacts_json FROM blackboards
       WHERE conversation_id IN (${placeholders})
         AND artifacts_json IS NOT NULL
         AND artifacts_json != '[]'
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...conversationIds, limit * 4) as Array<{ artifacts_json: string }>;

  const results: BlackboardArtifact[] = [];
  for (const row of rows) {
    let arr: unknown;
    try {
      arr = JSON.parse(row.artifacts_json);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const a of arr) {
      if (!a || typeof a !== "object") continue;
      const art = a as BlackboardArtifact;
      if (opts.kind && art.kind !== opts.kind) continue;
      if (opts.status && art.status !== opts.status) continue;
      results.push(art);
      if (results.length >= limit) return results;
    }
  }
  return results;
}

/**
 * Update an artifact's status. Returns the old status if found, null otherwise.
 * Throws on invalid status (validation guard for caller).
 */
export function updateArtifactStatus(
  db: Database.Database,
  id: string,
  newStatus: ArtifactStatus,
): ArtifactStatus | null {
  if (!isArtifactStatus(newStatus)) {
    throw new Error(
      `artifact.status invalid: ${newStatus} (allowed: ${ARTIFACT_STATUSES.join(", ")})`,
    );
  }
  if (!id) return null;

  const rows = db
    .prepare(
      `SELECT id, artifacts_json FROM blackboards
       WHERE artifacts_json IS NOT NULL AND artifacts_json != '[]'`,
    )
    .all() as Array<{ id: number; artifacts_json: string }>;

  for (const row of rows) {
    let arr: BlackboardArtifact[];
    try {
      const parsed = JSON.parse(row.artifacts_json);
      if (!Array.isArray(parsed)) continue;
      arr = parsed as BlackboardArtifact[];
    } catch {
      continue;
    }
    let changed = false;
    let oldStatus: ArtifactStatus | null = null;
    for (const a of arr) {
      if (a.id === id) {
        oldStatus = a.status;
        a.status = newStatus;
        a.updatedAt = Date.now();
        changed = true;
        break;
      }
    }
    if (changed) {
      const txn = db.transaction(() => {
        writeArtifactsJson(db, row.id, arr);
      });
      txn();
      return oldStatus;
    }
  }
  return null;
}

// ───────────────────────────── Migration helper (legacy → v3) ─────────────────────────────

/**
 * Migrate a legacy Blackboard row's `produced_artifacts_json` + `decisions_json`
 * into v3 `artifacts_json` (best-effort).
 *
 * Strategy:
 *   - Decisions → `kind: 'decision'`, author='communicator' (M3b 时期决策默认从 Communicator 出)
 *   - ProducedArtifacts → `kind: 'evidence'`, author='executor' (M3b 时期 Executor 产出)
 *   - Existing artifacts (if any) are preserved; new ones are appended with new ids.
 *
 * Called lazily by `rowToBlackboard` (returns BlackboardShape-compatible object)
 * or directly by tests to verify migration logic. Pure function — no DB writes.
 *
 * NOTE: This is a **pure helper** that produces a BlackboardArtifact[] from the
 * legacy columns. The caller decides whether to persist via writeArtifactsJson.
 */
export function migrateBlackboardArtifacts(row: Record<string, unknown>): BlackboardArtifact[] {
  const out: BlackboardArtifact[] = [];

  // Existing v3 artifacts preserved (if migration already ran).
  const rawArtifacts = row.artifacts_json;
  let hasExistingArtifacts = false;
  if (typeof rawArtifacts === "string" && rawArtifacts !== "[]") {
    try {
      const parsed = JSON.parse(rawArtifacts);
      if (Array.isArray(parsed) && parsed.length > 0) {
        hasExistingArtifacts = true;
        for (const a of parsed) {
          if (a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string") {
            out.push(a as BlackboardArtifact);
          }
        }
      }
    } catch {
      // ignore corrupt JSON
    }
  }

  // Idempotency: skip legacy import if v3 artifacts already exist.
  if (hasExistingArtifacts) return out;

  // Legacy decisions → decision artifacts.
  const rawDecisions = row.decisions_json;
  if (typeof rawDecisions === "string" && rawDecisions !== "[]") {
    try {
      const decisions = JSON.parse(rawDecisions) as Array<{
        iteration?: number;
        by?: string;
        decision?: string;
        ts?: number;
      }>;
      if (Array.isArray(decisions)) {
        const convId = (row.conversation_id as string | undefined) ?? "__legacy__";
        const bbId = (row.id as number | undefined) ?? 0;
        for (const d of decisions) {
          out.push({
            id: `legacy-decision-${bbId}-${out.length}`,
            scope: "conversation",
            conversationId: convId,
            kind: "decision",
            title: `Decision #${out.length} (legacy)`,
            body: typeof d.decision === "string" ? d.decision : "",
            author: "communicator",
            status: "resolved",
            metadata: { legacyBy: d.by, legacyIteration: d.iteration },
            createdAt: typeof d.ts === "number" ? d.ts : Date.now(),
            updatedAt: typeof d.ts === "number" ? d.ts : Date.now(),
          });
        }
      }
    } catch {
      // ignore
    }
  }

  // Legacy producedArtifacts → evidence artifacts.
  const rawProduced = row.produced_artifacts_json;
  if (typeof rawProduced === "string" && rawProduced !== "[]") {
    try {
      const produced = JSON.parse(rawProduced) as Array<{
        id?: string;
        path?: string;
        summary?: string;
      }>;
      if (Array.isArray(produced)) {
        const convId = (row.conversation_id as string | undefined) ?? "__legacy__";
        const bbId = (row.id as number | undefined) ?? 0;
        for (const p of produced) {
          out.push({
            id: `legacy-evidence-${bbId}-${out.length}`,
            scope: "conversation",
            conversationId: convId,
            kind: "evidence",
            title: p.summary ?? `Evidence ${p.id ?? out.length}`,
            body: p.summary ?? "",
            author: "executor",
            status: "resolved",
            refs: p.path ? [p.path] : undefined,
            metadata: { legacyArtifactId: p.id, legacyPath: p.path },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      }
    } catch {
      // ignore
    }
  }

  return out;
}

/**
 * Apply migrateBlackboardArtifacts to a legacy row and persist the result.
 * Idempotent — existing v3 artifacts are preserved.
 */
export function applyLegacyMigration(db: Database.Database, blackboardId: number): number {
  const row = db
    .prepare(`SELECT * FROM blackboards WHERE id = ?`)
    .get(blackboardId) as Record<string, unknown> | undefined;
  if (!row) return 0;
  const migrated = migrateBlackboardArtifacts(row);
  if (migrated.length === 0) return 0;
  const txn = db.transaction(() => {
    writeArtifactsJson(db, blackboardId, migrated);
  });
  txn();
  return migrated.length;
}

/* ───────────────────────────── B8: boot 对账(批次 4a) ───────────────────────────── */

/**
 * B8(docs/CODE-REVIEW-2026-10-01.md §B8):boot 对账的 errorReason 文案。
 * 与批次 1 cascadeFailDependents 的「cascade from <id>: upstream dependency failed」
 * 同形态(`<原因前缀>: <说明>`)—— ws sink 的 todo_failed reason、plan summary、
 * 前端展示读的都是 metadata.errorReason 同一字段,形态一致即零改动兼容。
 */
export const BOOT_RECONCILE_REASON = "reconciled on boot: orphaned by server restart";

/** todo 的非终态集合(与 orchestrator cascade/tryUnblockDependents 的口径一致)。 */
const NON_TERMINAL_TODO_STATUSES: ReadonlyArray<ArtifactStatus> = [
  "open",
  "in_progress",
  "waiting_for_decision",
];

/** intent 的非终态集合(run() 建 open;防御性含 in_progress)。 */
const NON_TERMINAL_INTENT_STATUSES: ReadonlyArray<ArtifactStatus> = ["open", "in_progress"];

export interface BootReconcileResult {
  failedTodos: number;
  failedIntents: number;
  todoIds: string[];
  intentIds: string[];
}

/**
 * B8(审查 §B8「重启/失败无对账:非终态 todo 永久悬挂」):
 * 把所有**无主**的非终态 todo(open/in_progress/waiting_for_decision)与
 * 非终态 intent 终态化为 failed,metadata.errorReason = BOOT_RECONCILE_REASON。
 *
 * 「无主」判据(防误杀论证):
 *  - Orchestrator 的运行态(activeExecutors/waiting/todoByExecutorSession/
 *    run promise)纯内存,进程重启全丢 → **新进程启动瞬间必然零 active run**;
 *  - 生产调用点 = Storage 构造器(文件路径分支,migrations 之后),早于
 *    HTTP listen / WS accept / kernel 接线(index.ts boot 顺序)→ 执行时刻
 *    库中任何非终态 todo/intent 的属主 run 只可能来自已死进程 → 全部无主;
 *  - 一次性、同步执行,无定时器/轮询 → boot 之后同进程新建 run 的 todo
 *    永远不会被触碰(「活 run 不误杀」,tests/storage/boot-reconcile.test.ts);
 *  - 不需要时间窗:时间窗(只杀 N 分钟前的)反而漏掉重启前一刻刚创建的真孤儿;
 *    「进程边界」本身就是精确的归属判据,零参数零误杀。
 *  - 已知边界:第二个进程对同一 DB 文件再构造 Storage 会终态化第一个进程活 run
 *    的 todo —— 生产由 pid 文件 + 端口占用约束单实例(daemon 健康检查/
 *    EADDRINUSE),该形态属误用(B5 /api/reset 重构时同理受保护:reset 发生在
 *    服务进程内部,不会重新构造 Storage——4b 范围)。
 *
 * 幂等:已终态(resolved/failed/superseded)一律不动;既有 failed 的 errorReason
 * (如批次 1 cascade 文案)不被覆盖。整体单事务:要么全部对账,要么(异常)
 * 保持原状,由调用方 try/catch 兜底(对账失败不阻塞 boot)。
 */
export function reconcileOrphanedRunArtifacts(db: Database.Database): BootReconcileResult {
  const result: BootReconcileResult = { failedTodos: 0, failedIntents: 0, todoIds: [], intentIds: [] };

  // 防御:表/列缺失(极旧库或迁移半途)→ 无可对账,返回零结果不 throw
  const hasTable = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='blackboards'`).all() as Array<{
      name: string;
    }>
  ).length > 0;
  if (!hasTable) return result;
  const hasColumn = (
    db.prepare(`PRAGMA table_info(blackboards)`).all() as Array<{ name: string }>
  ).some((c) => c.name === "artifacts_json");
  if (!hasColumn) return result;

  const rows = db
    .prepare(
      `SELECT id, artifacts_json FROM blackboards
        WHERE artifacts_json IS NOT NULL AND artifacts_json != '[]'`,
    )
    .all() as Array<{ id: number; artifacts_json: string }>;

  const now = Date.now();
  const txn = db.transaction(() => {
    for (const row of rows) {
      let arr: BlackboardArtifact[];
      try {
        const parsed: unknown = JSON.parse(row.artifacts_json);
        if (!Array.isArray(parsed)) continue;
        arr = parsed as BlackboardArtifact[];
      } catch {
        continue; // 坏行跳过(best-effort,与 readBlackboardShape 同语义)
      }
      let changed = false;
      for (const a of arr) {
        if (!a || typeof a !== "object") continue;
        if (a.kind === "todo" && NON_TERMINAL_TODO_STATUSES.includes(a.status)) {
          a.status = "failed";
          a.metadata = { ...(a.metadata ?? {}), errorReason: BOOT_RECONCILE_REASON };
          a.updatedAt = now;
          changed = true;
          result.failedTodos++;
          result.todoIds.push(a.id);
        } else if (a.kind === "intent" && NON_TERMINAL_INTENT_STATUSES.includes(a.status)) {
          // intent 同步终态化:属主 run 已死,maybeResolveIntent 永不会再触发
          a.status = "failed";
          a.metadata = { ...(a.metadata ?? {}), errorReason: BOOT_RECONCILE_REASON };
          a.updatedAt = now;
          changed = true;
          result.failedIntents++;
          result.intentIds.push(a.id);
        }
      }
      if (changed) writeArtifactsJson(db, row.id, arr);
    }
  });
  txn();
  return result;
}