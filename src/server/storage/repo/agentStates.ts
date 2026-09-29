/**
 * Sansheng agent_states repo · M3a
 *
 * 每个 conversation 对应一行 Pi agent session 的轻量 metadata;
 * 真正的上下文靠 messages 重放 + Pi session 重建来恢复。
 */
import type Database from "better-sqlite3";

export interface AgentStateRow {
  conversationId: string;
  cwd: string | null;
  modelId: string | null;
  provider: string | null;
  stateJson: string | null;
  lastActiveAt: number | null;
}

export function upsertAgentState(db: Database.Database, row: AgentStateRow): void {
  db.prepare(
    `INSERT INTO agent_states (conversation_id, cwd, model_id, provider, state_json, last_active_at, schema_version)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(conversation_id) DO UPDATE SET
       cwd = excluded.cwd,
       model_id = excluded.model_id,
       provider = excluded.provider,
       state_json = excluded.state_json,
       last_active_at = excluded.last_active_at`,
  ).run(row.conversationId, row.cwd, row.modelId, row.provider, row.stateJson, row.lastActiveAt);
}

export function getAgentState(db: Database.Database, conversationId: string): AgentStateRow | null {
  const row = db
    .prepare(`SELECT * FROM agent_states WHERE conversation_id = ?`)
    .get(conversationId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    conversationId: row.conversation_id as string,
    cwd: (row.cwd as string | null) ?? null,
    modelId: (row.model_id as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    stateJson: (row.state_json as string | null) ?? null,
    lastActiveAt: (row.last_active_at as number | null) ?? null,
  };
}

export function deleteAgentState(db: Database.Database, conversationId: string): void {
  db.prepare(`DELETE FROM agent_states WHERE conversation_id = ?`).run(conversationId);
}