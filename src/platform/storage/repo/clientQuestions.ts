/**
 * 向甲方提问的台账:一次提问 = 一行(020 的 `client_questions` 表)。
 *
 * ── 它存在的唯一理由是「消费标记」 ─────────────────────────────────
 *
 * 提问与答复的事实**早就记下来了** —— `client_question` 工件 + `artifact_links`
 * 的 `answers` 边。缺的是:业务经理**已经看过并处置了**这个答复,这个事实
 * 记在哪。
 *
 * 没有它,后果不是「慢」,是**永远不动**:
 * `resume_client` 规则(见 `runtime/dispatcher.ts`)若只能从工件表推出待办,
 * 那条待办每个 tick 都成立 —— 「答复过」这件事是**过去式**,不会自己消失。
 * 只能靠尝试预算兜住,而 AGENTS.md 的定性是「预算不是判据,是限流」:
 * 拿它兜一条每 10 秒成立的规则,等于让流水线静默停在一个「看起来跑过很多次」
 * 的地方(设计 1 §2.11.4 末)。
 *
 * ⇒ 所以 `consumed_at` 必须是**库里的一个列**,不是内存里的一个 Set。
 * 与 `dispatch_events.consumed_at` 完全同形。
 *
 * ── 纪律 ────────────────────────────────────────────────────────
 *
 * 本模块只做读写,不做判定。「谁此刻该动」的判定在 `runtime/dispatcher.ts`
 * 的 `collectTodos` —— 那里是唯一一处,而且它只读库、不读任何进程内状态。
 */
import type Database from "better-sqlite3";

export interface ClientQuestionRow {
  questionArtifactId: string;
  projectId: string;
  askedBy: string;
  askedAt: number;
  answerArtifactId: string | null;
  answeredAt: number | null;
  consumedAt: number | null;
  consumedBy: string | null;
}

interface RawClientQuestion {
  question_artifact_id: string;
  project_id: string;
  asked_by: string;
  asked_at: number;
  answer_artifact_id: string | null;
  answered_at: number | null;
  consumed_at: number | null;
  consumed_by: string | null;
}

function rowToQuestion(raw: RawClientQuestion): ClientQuestionRow {
  return {
    questionArtifactId: raw.question_artifact_id,
    projectId: raw.project_id,
    askedBy: raw.asked_by,
    askedAt: raw.asked_at,
    answerArtifactId: raw.answer_artifact_id,
    answeredAt: raw.answered_at,
    consumedAt: raw.consumed_at,
    consumedBy: raw.consumed_by,
  };
}

/**
 * 登记一次提问。**由 `ask_client` 在落 `client_question` 工件的同一次写里调用。**
 *
 * 为什么不从工件表反查:那样每次判定都要扫 `artifacts(kind='client_question')`,
 * 而更糟的是**存量提问**(020 之前就落库的)会没有 `consumed_at` 这一列的起点 ——
 * 那种行在「答复了但没消费」与「从没问过」之间无法区分,规则只能对它们永久沉默。
 * 显式建行的代价是 020 之前的提问不参与 `resume_client`;这是可接受的
 * (它们本来就是事故现场,人已经在处理了),而**反查**的代价是判据永远说不清。
 */
export function recordClientQuestion(
  db: Database.Database,
  row: {
    questionArtifactId: string;
    projectId: string;
    askedBy: string;
    askedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO client_questions
       (question_artifact_id, project_id, asked_by, asked_at,
        answer_artifact_id, answered_at, consumed_at, consumed_by)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)
     ON CONFLICT(question_artifact_id) DO NOTHING`,
  ).run(row.questionArtifactId, row.projectId, row.askedBy, row.askedAt);
}

/**
 * 回填「甲方答复了」。
 *
 * ⚠️ **与 decision 工件共用一次写**(`tools/client.ts` 的 `resolveClientQuestion`
 * 里同一个 try 块):7-L 纪律 ——「落 decision + 恢复执行者必须共用一条路径,
 * 否则审计面上会出现『拿到了指令但没有对应的 decision 工件』」。这里反过来:
 * 有了 decision 工件却没回填本表,就是真机那个形态(答复记下了、没人捡)。
 *
 * `ON CONFLICT DO UPDATE`:重复答复(重放)不该报冲突 —— at-least-once 的
 * 重放必须是安全的。已消费过的那次**不覆盖** `consumed_at`,否则一次重放就能
 * 让一条已处置的答复重新变成待办。
 */
export function markClientQuestionAnswered(
  db: Database.Database,
  questionArtifactId: string,
  answerArtifactId: string,
  at: number,
): void {
  db.prepare(
    `UPDATE client_questions
     SET answer_artifact_id = ?, answered_at = ?
     WHERE question_artifact_id = ?`,
  ).run(answerArtifactId, at, questionArtifactId);
}

/**
 * **答复到了、还没被业务经理处置**的行 —— `resume_client` 规则的唯一判据。
 *
 * 升序(先问的先处置),与 `listPendingDispatchEvents` 同形。
 */
export function listUnconsumedClientAnswers(
  db: Database.Database,
  projectId: string,
): ClientQuestionRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM client_questions
       WHERE project_id = ? AND answered_at IS NOT NULL AND consumed_at IS NULL
       ORDER BY answered_at, question_artifact_id`,
    )
    .all(projectId) as RawClientQuestion[];
  return rows.map(rowToQuestion);
}

/**
 * 按提问工件 id 取台账行(渲染现场用)。
 *
 * **为什么不用「扫工件表 + `metadataJson.includes(id)` 反查答复」**:那是子串匹配,
 * 一条 decision 的 metadata 里恰好提到另一个 `q_*` 的 id 就会误命中 —— 而
 * 「审查/检查自己静默出错」是本项目记过三次的形态(AGENTS.md「三类静默失败」③)。
 * 台账行有**精确的** `answer_artifact_id` 列,不需要猜。
 */
export function getClientQuestions(
  db: Database.Database,
  questionArtifactIds: readonly string[],
): Map<string, ClientQuestionRow> {
  const out = new Map<string, ClientQuestionRow>();
  if (questionArtifactIds.length === 0) return out;
  const holes = questionArtifactIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM client_questions WHERE question_artifact_id IN (${holes})`)
    .all(...questionArtifactIds) as RawClientQuestion[];
  for (const raw of rows) out.set(raw.question_artifact_id, rowToQuestion(raw));
  return out;
}

/**
 * 处置完一次答复(`resume_client` 回合**成功结束后**由平台写)。
 *
 * 回合失败/被中断就不调用它 —— 答复留着重来。这是 at-least-once:
 * 宁可多看一次,不能静默漏掉甲方的答复。
 *
 * `consumed_at IS NULL` 是幂等的那一半:重复消费不会把 `consumed_at` 往后推,
 * 而 `pruneAttempts` 靠待办消失来重置预算,时间戳抖动会让预算判断失准。
 */
export function consumeClientAnswers(
  db: Database.Database,
  projectId: string,
  consumedBy: string,
  at: number,
): number {
  return db
    .prepare(
      `UPDATE client_questions SET consumed_at = ?, consumed_by = ?
       WHERE project_id = ? AND answered_at IS NOT NULL AND consumed_at IS NULL`,
    )
    .run(at, consumedBy, projectId).changes;
}
