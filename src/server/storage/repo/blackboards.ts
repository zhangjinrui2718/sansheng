/**
 * Sansheng blackboards repo · M3b
 *
 * 每个 conversation 一行 Blackboard 快照;新 run 创建新行,旧 run 保留为历史。
 * Orchestrator 在 run 结束后调用 upsertBlackboard 写入。
 */
import type Database from "better-sqlite3";
import type { Blackboard } from "@shared/types/agents";

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