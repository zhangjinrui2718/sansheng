import type Database from "better-sqlite3";

export interface MessageRow {
  id: string;
  conversationId: string;
  turnIndex: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolCalls: string | null;
  thinking: string | null;
  usageInput: number;
  usageOutput: number;
  costUsd: number;
  createdAt: number;
}

export function insertMessage(db: Database.Database, m: Omit<MessageRow, never>): void {
  db.prepare(
    `INSERT INTO messages
       (id, conversation_id, turn_index, role, content, tool_calls, thinking, usage_input, usage_output, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       tool_calls = excluded.tool_calls,
       thinking = excluded.thinking,
       usage_input = excluded.usage_input,
       usage_output = excluded.usage_output,
       cost_usd = excluded.cost_usd`,
  ).run(
    m.id,
    m.conversationId,
    m.turnIndex,
    m.role,
    m.content,
    m.toolCalls,
    m.thinking,
    m.usageInput,
    m.usageOutput,
    m.costUsd,
    m.createdAt,
  );
}

export function listMessagesByConversation(db: Database.Database, conversationId: string): MessageRow[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY turn_index ASC, created_at ASC`)
    .all(conversationId) as Array<Record<string, unknown>>;
  return rows.map(rowToMessage);
}

export function getMessage(db: Database.Database, id: string): MessageRow | null {
  const r = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToMessage(r) : null;
}

function rowToMessage(r: Record<string, unknown>): MessageRow {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    turnIndex: r.turn_index as number,
    role: r.role as MessageRow["role"],
    content: r.content as string,
    toolCalls: (r.tool_calls as string | null) ?? null,
    thinking: (r.thinking as string | null) ?? null,
    usageInput: r.usage_input as number,
    usageOutput: r.usage_output as number,
    costUsd: r.cost_usd as number,
    createdAt: r.created_at as number,
  };
}