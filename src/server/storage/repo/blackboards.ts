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