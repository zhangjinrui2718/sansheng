/**
 * BC2 Collaboration · meetings 仓储(多边对焦)
 *
 * 会议是**异步**的:不阻塞任何 agent 的当前回合(设计 1 §5.4)。参会方在自己的
 * 下个回合被提示有未表态会议,也可以用 meeting_read 主动查。
 *
 * 两个不变量由 schema 与这一层共同保证:
 *   - **反对必须写理由**(session CHECK):没有理由的反对,主持人无法据此调整方案
 *   - **只有主持人能收尾**(调用方的授权判定):否则「会议结论」没有责任人
 */
import type Database from "better-sqlite3";

export type MeetingStatus = "convened" | "in_progress" | "concluded" | "cancelled";
export type Stance = "support" | "oppose" | "undecided";

export const MEETING_STATUSES: readonly MeetingStatus[] = [
  "convened",
  "in_progress",
  "concluded",
  "cancelled",
];

export const STANCES: readonly Stance[] = ["support", "oppose", "undecided"];

export function isMeetingStatus(v: unknown): v is MeetingStatus {
  return typeof v === "string" && (MEETING_STATUSES as readonly string[]).includes(v);
}

export function isStance(v: unknown): v is Stance {
  return typeof v === "string" && (STANCES as readonly string[]).includes(v);
}

export interface MeetingRow {
  id: string;
  projectId: string;
  topic: string;
  agendaJson: string | null;
  status: MeetingStatus;
  conveningAgentId: string;
  createdAt: number;
  concludedAt: number | null;
  summary: string | null;
}

export interface ParticipantRow {
  meetingId: string;
  agentId: string;
  stance: Stance | null;
  comment: string | null;
  respondedAt: number | null;
}

interface RawMeeting {
  id: string;
  project_id: string;
  topic: string;
  agenda_json: string | null;
  status: string;
  convening_agent_id: string;
  created_at: number;
  concluded_at: number | null;
  summary: string | null;
}

interface RawParticipant {
  meeting_id: string;
  agent_id: string;
  stance: string | null;
  comment: string | null;
  responded_at: number | null;
}

function rowToMeeting(raw: RawMeeting): MeetingRow {
  if (!isMeetingStatus(raw.status)) {
    throw new Error(`meetings 表里出现未定义状态「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    topic: raw.topic,
    agendaJson: raw.agenda_json,
    status: raw.status,
    conveningAgentId: raw.convening_agent_id,
    createdAt: raw.created_at,
    concludedAt: raw.concluded_at,
    summary: raw.summary,
  };
}

function rowToParticipant(raw: RawParticipant): ParticipantRow {
  let stance: Stance | null = null;
  if (raw.stance !== null) {
    if (!isStance(raw.stance)) {
      throw new Error(`meeting_participants 里出现未定义立场「${raw.stance}」`);
    }
    stance = raw.stance;
  }
  return {
    meetingId: raw.meeting_id,
    agentId: raw.agent_id,
    stance,
    comment: raw.comment,
    respondedAt: raw.responded_at,
  };
}

// ── 写入 ────────────────────────────────────────────────────────

export function insertMeeting(
  db: Database.Database,
  m: {
    id: string;
    projectId: string;
    topic: string;
    agendaJson?: string | null;
    conveningAgentId: string;
    createdAt: number;
    participants: readonly string[];
  },
): void {
  if (m.participants.length === 0) {
    throw new Error("会议至少要有一个参会方 —— 开一场没人参加的对焦毫无意义");
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meetings (id, project_id, topic, agenda_json, status,
                             convening_agent_id, created_at, concluded_at, summary)
       VALUES (?, ?, ?, ?, 'convened', ?, ?, NULL, NULL)`,
    ).run(m.id, m.projectId, m.topic, m.agendaJson ?? null, m.conveningAgentId, m.createdAt);

    // 为每个参会方建一条「待表态」记录(stance / responded_at 为空)
    const stmt = db.prepare(
      `INSERT INTO meeting_participants (meeting_id, agent_id, stance, comment, responded_at)
       VALUES (?, ?, NULL, NULL, NULL)
       ON CONFLICT(meeting_id, agent_id) DO NOTHING`,
    );
    for (const a of m.participants) stmt.run(m.id, a);
  })();
}

export function getMeeting(db: Database.Database, id: string): MeetingRow | null {
  const raw = db.prepare(`SELECT * FROM meetings WHERE id = ?`).get(id) as RawMeeting | undefined;
  return raw ? rowToMeeting(raw) : null;
}

export function listMeetings(
  db: Database.Database,
  projectId: string,
  filter: { status?: MeetingStatus; conveningAgentId?: string; limit?: number } = {},
): MeetingRow[] {
  const where = ["project_id = ?"];
  const vals: unknown[] = [projectId];
  if (filter.status !== undefined) { where.push("status = ?"); vals.push(filter.status); }
  if (filter.conveningAgentId !== undefined) {
    where.push("convening_agent_id = ?");
    vals.push(filter.conveningAgentId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  vals.push(limit);
  const rows = db
    .prepare(`SELECT * FROM meetings WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...vals) as RawMeeting[];
  return rows.map(rowToMeeting);
}

export function listParticipants(db: Database.Database, meetingId: string): ParticipantRow[] {
  const rows = db
    .prepare(`SELECT * FROM meeting_participants WHERE meeting_id = ? ORDER BY agent_id`)
    .all(meetingId) as RawParticipant[];
  return rows.map(rowToParticipant);
}

// ── 表态 ────────────────────────────────────────────────────────

export type RespondResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_participant" | "meeting_closed" | "oppose_needs_reason" };

/**
 * 参会方表态。**反对必须写理由** —— schema 也拦,这里给出更可读的失败。
 *
 * 首次表态会把会议从 `convened` 推到 `in_progress`:这让「会议开起来了但没人理」
 * 与「会议真的在进行」在数据上可区分。
 */
export function respondToMeeting(
  db: Database.Database,
  meetingId: string,
  agentId: string,
  stance: Stance,
  at: number,
  comment?: string,
): RespondResult {
  const m = getMeeting(db, meetingId);
  if (!m) return { ok: false, reason: "not_found" };
  if (m.status === "concluded" || m.status === "cancelled") {
    return { ok: false, reason: "meeting_closed" };
  }
  const part = listParticipants(db, meetingId).find((p) => p.agentId === agentId);
  if (part === undefined) return { ok: false, reason: "not_participant" };
  if (stance === "oppose" && (comment === undefined || comment.trim() === "")) {
    return { ok: false, reason: "oppose_needs_reason" };
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE meeting_participants SET stance = ?, comment = ?, responded_at = ?
       WHERE meeting_id = ? AND agent_id = ?`,
    ).run(stance, comment ?? null, at, meetingId, agentId);
    if (m.status === "convened") {
      db.prepare(`UPDATE meetings SET status = 'in_progress' WHERE id = ?`).run(meetingId);
    }
  })();
  return { ok: true };
}

export type ConcludeResult =
  | { ok: true; pending: string[] }
  | { ok: false; reason: "not_found" | "already_closed" | "not_convener" | "no_summary" };

/**
 * 主持人收尾。**只有发起人能收**(设计 1 §5.4)—— 否则「会议结论」没有责任人。
 *
 * **不强制所有人表态完**:真实会议里总有人弃权。未表态者会在返回值里如实列出,
 * 纪要里应带上他们 —— 静默忽略会让「谁没表态」这个信息永久丢失。
 */
export function concludeMeeting(
  db: Database.Database,
  meetingId: string,
  agentId: string,
  summary: string,
  at: number,
): ConcludeResult {
  const m = getMeeting(db, meetingId);
  if (!m) return { ok: false, reason: "not_found" };
  if (m.status === "concluded" || m.status === "cancelled") {
    return { ok: false, reason: "already_closed" };
  }
  if (m.conveningAgentId !== agentId) return { ok: false, reason: "not_convener" };
  if (summary.trim() === "") return { ok: false, reason: "no_summary" };

  const pending = listParticipants(db, meetingId)
    .filter((p) => p.respondedAt === null)
    .map((p) => p.agentId);

  db.prepare(
    `UPDATE meetings SET status = 'concluded', concluded_at = ?, summary = ? WHERE id = ?`,
  ).run(at, summary, meetingId);
  return { ok: true, pending };
}

export function cancelMeeting(db: Database.Database, meetingId: string): void {
  db.prepare(
    `UPDATE meetings SET status = 'cancelled', concluded_at = NULL WHERE id = ? AND status IN ('convened','in_progress')`,
  ).run(meetingId);
}

// ── 巡检:谁还没表态 ─────────────────────────────────────────────

/**
 * 一个 agent 当前**待表态**的会议(未收尾且它还没表态)。
 *
 * 这是「平台把未表态会议注入 agent 下个回合」的查询入口 ——
 * 没有它,参会方只能靠自己想起来去查,而异步会议里没人会提醒它。
 */
export function pendingMeetingsFor(db: Database.Database, agentId: string): MeetingRow[] {
  const rows = db
    .prepare(
      `SELECT m.* FROM meetings m
       JOIN meeting_participants p ON p.meeting_id = m.id
       WHERE p.agent_id = ? AND p.responded_at IS NULL
         AND m.status IN ('convened', 'in_progress')
       ORDER BY m.created_at`,
    )
    .all(agentId) as RawMeeting[];
  return rows.map(rowToMeeting);
}

/** 某场会议的立场分布,给纪要渲染用。 */
export function stanceTally(
  db: Database.Database,
  meetingId: string,
): { support: number; oppose: number; undecided: number; silent: number } {
  const parts = listParticipants(db, meetingId);
  return {
    support: parts.filter((p) => p.stance === "support").length,
    oppose: parts.filter((p) => p.stance === "oppose").length,
    undecided: parts.filter((p) => p.stance === "undecided").length,
    silent: parts.filter((p) => p.respondedAt === null).length,
  };
}
