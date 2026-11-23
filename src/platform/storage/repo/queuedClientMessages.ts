/**
 * 忙时排队仓储(`queued_client_messages`,migration 036)
 *
 * ── 它记的是什么 ────────────────────────────────────────────────
 *
 * 甲方在业务经理正跑回合时说的话:**消息正文**落在 `session_messages`(它
 * 本来就是一条会话消息,对话页要显示),本表只记「哪一条还没被带上」——
 * `consumed_at IS NULL` 就是排空器 `answer_client_message` 待办的判据。
 *
 * ── 三条纪律(照抄 `repo/clientQuestions.ts` / `repo/usage.ts`)────
 *
 *   ① 消费是 **at-least-once**:回合成功结束才写 `consumed_at`,失败/被中断
 *      就下次重来 —— 宁可多说一次,不能静默丢甲方一句话;
 *   ② **规则的事实只带 id 与时间戳**:`dispatcher.ts` 的 `RuleFacts` 不读正文
 *      (§2.11.3);正文只在 `renderTask` 渲染任务时按 id 取;
 *   ③ 不在这里拼给人看的名字。
 */
import type Database from "better-sqlite3";

/** `queued_client_messages` 的一行(账,不含正文)。 */
export interface QueuedClientMessageRow {
  id: string;
  projectId: string;
  /** 排队的那句话落在哪条线上(回合将跑在这条线)。 */
  sessionId: string;
  /** 那条 user 消息(`session_messages.id`);正文在那里。 */
  messageId: string;
  createdAt: number;
  /** null = 还没被业务经理看到。 */
  consumedAt: number | null;
}

interface RawQueued {
  id: string;
  project_id: string;
  session_id: string;
  message_id: string;
  created_at: number;
  consumed_at: number | null;
}

function toRow(raw: RawQueued): QueuedClientMessageRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    sessionId: raw.session_id,
    messageId: raw.message_id,
    createdAt: raw.created_at,
    consumedAt: raw.consumed_at,
  };
}

/** 落一条账(消息正文已由调用方写进 `session_messages`)。 */
export function insertQueuedClientMessage(
  db: Database.Database,
  row: QueuedClientMessageRow,
): void {
  db.prepare(
    `INSERT INTO queued_client_messages (id, project_id, session_id, message_id, created_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.projectId, row.sessionId, row.messageId, row.createdAt, row.consumedAt);
}

/**
 * 按 id 取一条排队账(`null` = 没有)。`renderTask` 用它把账行 id 解析成
 * `messageId` 再取正文 —— **refs 里存的是账行 id**(消费用它),正文要两跳。
 */
export function getQueuedClientMessage(
  db: Database.Database,
  id: string,
): QueuedClientMessageRow | null {
  const raw = db
    .prepare(`SELECT * FROM queued_client_messages WHERE id = ?`)
    .get(id) as RawQueued | undefined;
  return raw === undefined ? null : toRow(raw);
}

/**
 * 项目里还没被带上的排队消息(按创建先后)。**只读账上的列,不读正文。**
 */
export function pendingQueuedClientMessages(
  db: Database.Database,
  projectId: string,
): QueuedClientMessageRow[] {
  const raw = db
    .prepare(
      `SELECT * FROM queued_client_messages
       WHERE project_id = ? AND consumed_at IS NULL
       ORDER BY created_at ASC, id ASC`,
    )
    .all(projectId) as RawQueued[];
  return raw.map(toRow);
}

/**
 * 标记「这些话已经在某一轮带上了」。
 *
 * 与 `consumeClientAnswers` 同一条纪律:只在回合**成功结束**后调
 * (`dispatcher.ts` 的消费点),at-least-once。已消费的行再消费一次是幂等的
 * (`consumed_at` 只在第一次写入时生效)。
 */
export function consumeQueuedClientMessages(
  db: Database.Database,
  ids: readonly string[],
  at: number,
): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare(
    `UPDATE queued_client_messages SET consumed_at = ?
     WHERE id = ? AND consumed_at IS NULL`,
  );
  let n = 0;
  db.transaction(() => {
    for (const id of ids) n += stmt.run(at, id).changes;
  })();
  return n;
}
