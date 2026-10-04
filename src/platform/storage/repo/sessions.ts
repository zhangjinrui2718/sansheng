/**
 * BC2 Collaboration · project_sessions / session_messages 仓储
 *
 * 对话是**项目的会话**,不是项目的边界 —— 这是本次升级最关键的一处作用域变更
 * 的落点:工件、工作项、阻塞、变更全部按 `project_id` 归属,对话只是它们的
 * 来源线索之一。
 *
 * 所以 `artifacts.conversation_id` **刻意不加外键**:工件必须比对话活得久。
 */
import type Database from "better-sqlite3";

export type SessionMessageKind = "user" | "assistant" | "thinking" | "tool" | "system";

export const MESSAGE_KINDS: readonly SessionMessageKind[] = [
  "user",
  "assistant",
  "thinking",
  "tool",
  "system",
];

export function isSessionMessageKind(v: unknown): v is SessionMessageKind {
  return typeof v === "string" && (MESSAGE_KINDS as readonly string[]).includes(v);
}

export interface SessionRow {
  id: string;
  /**
   * `null` = **接待会话**(第一个项目之前,见 `migrations/012_intake_session.sql`)。
   * 全局只有一条 —— 由迁移里的部分唯一索引机械保证。
   */
  projectId: string | null;
  createdAt: number;
}

export interface SessionMessageRow {
  id: string;
  sessionId: string;
  /** NULL = 甲方(用户)说的话。用户不是 agents 表里的角色。 */
  agentId: string | null;
  kind: SessionMessageKind;
  content: string;
  createdAt: number;
}

interface RawConversation {
  id: string;
  project_id: string | null;
  created_at: number;
}

interface RawMessage {
  id: string;
  session_id: string;
  agent_id: string | null;
  kind: string;
  content: string;
  created_at: number;
}

export function insertSession(
  db: Database.Database,
  row: { id: string; projectId: string | null; createdAt: number },
): void {
  db.prepare(
    `INSERT INTO project_sessions (id, project_id, created_at) VALUES (?, ?, ?)`,
  ).run(row.id, row.projectId, row.createdAt);
}

export function getSession(db: Database.Database, id: string): SessionRow | null {
  const raw = db.prepare(`SELECT * FROM project_sessions WHERE id = ?`).get(id) as
    | RawConversation
    | undefined;
  return raw
    ? { id: raw.id, projectId: raw.project_id, createdAt: raw.created_at }
    : null;
}

/**
 * 某个项目(或接待会话)的全部会话,新的在前。
 *
 * `projectId === null` 要写成 `IS NULL` —— SQL 里 `project_id = NULL` 恒为
 * unknown,一条也查不出来。这不是风格问题:写成 `= ?` 的话接待会话的历史会
 * **静默变成空列表**,而「空列表」和「这段对话真的没有消息」在接口上长得一样。
 */
export function listSessions(db: Database.Database, projectId: string | null): SessionRow[] {
  const rows = (
    projectId === null
      ? db
          .prepare(`SELECT * FROM project_sessions WHERE project_id IS NULL ORDER BY created_at DESC`)
          .all()
      : db
          .prepare(`SELECT * FROM project_sessions WHERE project_id = ? ORDER BY created_at DESC`)
          .all(projectId)
  ) as RawConversation[];
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, createdAt: r.created_at }));
}

export function appendSessionMessage(
  db: Database.Database,
  row: {
    id: string;
    sessionId: string;
    agentId: string | null;
    kind: SessionMessageKind;
    content: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO session_messages (id, session_id, agent_id, kind, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.sessionId, row.agentId, row.kind, row.content, row.createdAt);
}

export function listSessionMessages(
  db: Database.Database,
  sessionId: string,
  limit = 200,
): SessionMessageRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at LIMIT ?`,
    )
    .all(sessionId, Math.min(Math.max(limit, 1), 2000)) as RawMessage[];
  return rows.map((r) => {
    if (!isSessionMessageKind(r.kind)) {
      throw new Error(`session_messages 表里出现未定义 kind「${r.kind}」(id=${r.id})`);
    }
    return {
      id: r.id,
      sessionId: r.session_id,
      agentId: r.agent_id,
      kind: r.kind,
      content: r.content,
      createdAt: r.created_at,
    };
  });
}
