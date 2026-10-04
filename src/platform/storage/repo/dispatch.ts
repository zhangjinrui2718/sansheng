/**
 * 排空器的两块持久状态:下游事件(outbox)+ 待办尝试预算。
 *
 * ── 为什么这两样在库里,而不是在内存里 ───────────────────────────
 *
 * 批次 20 的驱动者循环把「下游刚发生了什么」与「这条待办已经叫过几次」放在
 * 进程内的 Map 里,代价是真机跑出来的三个洞:
 *
 *   1. 撞上 `maxRounds` 时那一路攒的「工作项做完了」随调用消失
 *      → **工作项做完了永远没人向甲方汇报**(日志里只有一句「已达上限」)
 *   2. 重启之后什么都不记得 → 该补跑的审查不补跑
 *   3. 「同一个待办每 60 秒被重叫一次」只能靠内存记忆挡住,而重启即忘
 *
 * 搬进库里之后:
 *   - 业务经理的待办 = 「这个项目还有没被交代的下游事件吗」(一条查询)
 *   - 尝试预算 = 每条待办一行计数,到界就不再叫醒,并**如实广播**(不静默)
 *
 * ── 纪律 ────────────────────────────────────────────────────────
 *
 * 本模块只做读写,不做判定。「谁此刻该动」的判定在 `runtime/dispatcher.ts`
 * 的 `collectTodos` —— 那里是唯一一处,而且它只读库、不读任何进程内状态。
 */
import type Database from "better-sqlite3";

// ── ① 下游事件 ──────────────────────────────────────────────────

export type DispatchEventKind = "work_done" | "work_failed" | "work_blocked" | "blocker_opened";

export const DISPATCH_EVENT_KINDS: readonly DispatchEventKind[] = [
  "work_done",
  "work_failed",
  "work_blocked",
  "blocker_opened",
];

export function isDispatchEventKind(v: unknown): v is DispatchEventKind {
  return typeof v === "string" && (DISPATCH_EVENT_KINDS as readonly string[]).includes(v);
}

export interface DispatchEventRow {
  /** 单调自增序号。它同时是「这批事件的版本号」(见 runtime/dispatcher.ts) */
  seq: number;
  projectId: string;
  kind: DispatchEventKind;
  subjectId: string;
  summary: string;
  createdAt: number;
  consumedAt: number | null;
  consumedBy: string | null;
}

interface RawDispatchEvent {
  seq: number;
  project_id: string;
  kind: string;
  subject_id: string;
  summary: string;
  created_at: number;
  consumed_at: number | null;
  consumed_by: string | null;
}

function rowToEvent(raw: RawDispatchEvent): DispatchEventRow {
  if (!isDispatchEventKind(raw.kind)) {
    throw new Error(`dispatch_events 表里出现未定义 kind「${raw.kind}」(seq=${raw.seq})`);
  }
  return {
    seq: raw.seq,
    projectId: raw.project_id,
    kind: raw.kind,
    subjectId: raw.subject_id,
    summary: raw.summary,
    createdAt: raw.created_at,
    consumedAt: raw.consumed_at,
    consumedBy: raw.consumed_by,
  };
}

export function insertDispatchEvent(
  db: Database.Database,
  row: {
    projectId: string;
    kind: DispatchEventKind;
    subjectId: string;
    summary: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO dispatch_events (project_id, kind, subject_id, summary, created_at,
                                  consumed_at, consumed_by)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(row.projectId, row.kind, row.subjectId, row.summary, row.createdAt);
}

/** 还没被交代出去的事件,**按时间升序**(先发生的先汇报)。 */
export function listPendingDispatchEvents(
  db: Database.Database,
  projectId: string,
): DispatchEventRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM dispatch_events WHERE project_id = ? AND consumed_at IS NULL
       ORDER BY created_at, seq`,
    )
    .all(projectId) as RawDispatchEvent[];
  return rows.map(rowToEvent);
}

/**
 * 消费掉这个项目**当前全部**未交代的事件(业务经理那个回合成功结束后由平台写)。
 *
 * 回合失败/被中断就不调用它 —— 事件留着重来。这是 at-least-once:
 * 宁可多汇报一次,不能静默漏掉。
 */
export function consumePendingDispatchEvents(
  db: Database.Database,
  projectId: string,
  consumedBy: string,
  at: number,
): number {
  return db
    .prepare(
      `UPDATE dispatch_events SET consumed_at = ?, consumed_by = ?
       WHERE project_id = ? AND consumed_at IS NULL`,
    )
    .run(at, consumedBy, projectId).changes;
}

// ── ② 待办尝试预算 ──────────────────────────────────────────────

export interface AttemptRow {
  projectId: string;
  todoKey: string;
  attempts: number;
  /** 上一次尝试时目标行的 `updated_at`(没有目标行的待办为 null) */
  targetState: number | null;
  firstAttemptAt: number;
  lastAttemptAt: number;
  /** 到界放弃时是否已经广播过 —— 只广播一次,避免每 10 秒刷一条 system 消息 */
  notifiedAt: number | null;
}

interface RawAttempt {
  project_id: string;
  todo_key: string;
  attempts: number;
  target_state: number | null;
  first_attempt_at: number;
  last_attempt_at: number;
  notified_at: number | null;
}

function rowToAttempt(raw: RawAttempt): AttemptRow {
  return {
    projectId: raw.project_id,
    todoKey: raw.todo_key,
    attempts: raw.attempts,
    targetState: raw.target_state,
    firstAttemptAt: raw.first_attempt_at,
    lastAttemptAt: raw.last_attempt_at,
    notifiedAt: raw.notified_at,
  };
}

/** 这个项目的尝试账本。键是 `todo_key` —— 待办的标识由它自身的内容决定。 */
export function listAttempts(
  db: Database.Database,
  projectId: string,
): Map<string, AttemptRow> {
  const rows = db
    .prepare(`SELECT * FROM dispatch_attempts WHERE project_id = ?`)
    .all(projectId) as RawAttempt[];
  return new Map(rows.map((r) => [r.todo_key, rowToAttempt(r)]));
}

/**
 * 记一次尝试,返回累计次数。
 *
 * **目标真的动了就清零**:`target_state` 是目标行的 `updated_at`,它与上次不同
 * 说明这件事在推进,不该被预算掐死。只有「目标一动不动」才消耗预算。
 */
export function bumpAttempt(
  db: Database.Database,
  opts: { projectId: string; todoKey: string; targetState: number | null; at: number },
): number {
  const cur = listAttempts(db, opts.projectId).get(opts.todoKey);
  if (cur === undefined) {
    db.prepare(
      `INSERT INTO dispatch_attempts
         (project_id, todo_key, attempts, target_state, first_attempt_at, last_attempt_at, notified_at)
       VALUES (?, ?, 1, ?, ?, ?, NULL)`,
    ).run(opts.projectId, opts.todoKey, opts.targetState, opts.at, opts.at);
    return 1;
  }
  const moved =
    opts.targetState !== null && cur.targetState !== null && opts.targetState !== cur.targetState;
  const attempts = moved ? 1 : cur.attempts + 1;
  db.prepare(
    `UPDATE dispatch_attempts
     SET attempts = ?, target_state = ?, last_attempt_at = ?, notified_at = ?
     WHERE project_id = ? AND todo_key = ?`,
  ).run(attempts, opts.targetState, opts.at, moved ? null : cur.notifiedAt, opts.projectId, opts.todoKey);
  return attempts;
}

export function markAttemptNotified(
  db: Database.Database,
  projectId: string,
  todoKey: string,
  at: number,
): void {
  db.prepare(
    `UPDATE dispatch_attempts SET notified_at = ? WHERE project_id = ? AND todo_key = ?`,
  ).run(at, projectId, todoKey);
}

/**
 * 清掉**已经不存在**的待办的账本行。
 *
 * 这是「预算重置」的全部机制:待办消失(工作项做完了、提问被答了)→ 行被删
 * → 同一件事将来再次出现时拿到新预算。不需要任何额外规则。
 */
export function pruneAttempts(
  db: Database.Database,
  projectId: string,
  keepKeys: readonly string[],
): number {
  const keep = new Set(keepKeys);
  const rows = db
    .prepare(`SELECT todo_key FROM dispatch_attempts WHERE project_id = ?`)
    .all(projectId) as Array<{ todo_key: string }>;
  const stmt = db.prepare(`DELETE FROM dispatch_attempts WHERE project_id = ? AND todo_key = ?`);
  let n = 0;
  for (const r of rows) {
    if (keep.has(r.todo_key)) continue;
    n += stmt.run(projectId, r.todo_key).changes;
  }
  return n;
}
