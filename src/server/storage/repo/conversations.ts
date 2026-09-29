import type Database from "better-sqlite3";

export interface ConversationSummary {
  id: string;
  title: string | null;
  lastActiveAt: number;
  preview: string;
  messageCount: number;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  cwd: string | null;
  modelId: string | null;
  provider: string | null;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export function upsertConversation(
  db: Database.Database,
  c: { id: string; title?: string | null; cwd?: string | null; modelId?: string | null; provider?: string | null },
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO conversations (id, title, cwd, model_id, provider, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = COALESCE(excluded.title, conversations.title),
       cwd = COALESCE(excluded.cwd, conversations.cwd),
       model_id = COALESCE(excluded.model_id, conversations.model_id),
       provider = COALESCE(excluded.provider, conversations.provider),
       last_active_at = excluded.last_active_at`,
  ).run(c.id, c.title ?? null, c.cwd ?? null, c.modelId ?? null, c.provider ?? null, now, now);
}

export function recordMessageUsage(
  db: Database.Database,
  convId: string,
  input: number,
  output: number,
  costUsd: number,
): void {
  db.prepare(
    `UPDATE conversations SET
       message_count = message_count + 1,
       total_input_tokens = total_input_tokens + ?,
       total_output_tokens = total_output_tokens + ?,
       total_cost_usd = total_cost_usd + ?,
       last_active_at = ?
     WHERE id = ?`,
  ).run(input, output, costUsd, Date.now(), convId);
}

export function setConversationTitle(db: Database.Database, id: string, title: string): void {
  db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, id);
}

export function getConversation(db: Database.Database, id: string): ConversationRow | null {
  const r = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return rowToConversation(r);
}

export function listConversations(db: Database.Database, limit: number): ConversationSummary[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.title, c.last_active_at, c.message_count,
              (SELECT content FROM messages WHERE conversation_id = c.id AND role = 'user' ORDER BY created_at LIMIT 1) as preview
       FROM conversations c
       ORDER BY c.last_active_at DESC
       LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    title: (r.title as string | null) ?? null,
    lastActiveAt: r.last_active_at as number,
    messageCount: r.message_count as number,
    preview: ((r.preview as string | null) ?? "").slice(0, 60),
  }));
}

function rowToConversation(r: Record<string, unknown>): ConversationRow {
  return {
    id: r.id as string,
    title: (r.title as string | null) ?? null,
    cwd: (r.cwd as string | null) ?? null,
    modelId: (r.model_id as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    createdAt: r.created_at as number,
    lastActiveAt: r.last_active_at as number,
    messageCount: r.message_count as number,
    totalInputTokens: r.total_input_tokens as number,
    totalOutputTokens: r.total_output_tokens as number,
    totalCostUsd: r.total_cost_usd as number,
  };
}