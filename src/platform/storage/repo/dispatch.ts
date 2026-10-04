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
 *
 * **例外且只有一条**:`insertDispatchEvent` 会判「这个 kind 当前 schema 允不允许」
 * (见 `InsertDispatchEventResult`)。那不是「谁该动」的判定,而是「这句话现在
 * 落不落得下去」—— 落不下去时必须**如实说**,不能静默丢。
 */
import type Database from "better-sqlite3";

// ── ① 下游事件 ──────────────────────────────────────────────────
//
// ⚠️ **这个 outbox 不是「事件流水」,是「待交代队列」。** 一行 = 一件业务经理
// 该主动向甲方交代的事。写入侧的**可打扰判据**在 `repo/works.ts` 的
// `updateWorkStatus`(判据是库里的一个事实:这条工作项在工作分解树里的位置),
// 不在判定侧收窄 —— 消费是**全量**的(`consumePendingDispatchEvents` 无差别标记
// 全部未消费行),一次可打扰事件会把一串不可打扰事件一起标记为已交代,
// 于是 `consumed_at` 开始撒谎。理由与代价见 `works.ts` 里那段长注释。

/**
 * 事件种类。
 *
 * `work_cancelled` 是**写入侧新增**的(设计 §12 #10):取消此前不写任何事件,
 * 于是「这条工作项被取消了」业务经理与质检都不知道 —— 而它正是下游依赖悬空的
 * 来源(真机事故的起点)。
 *
 * ⚠️ `migrations/013` 给 `dispatch_events.kind` 的 CHECK 闭集**只有前 4 个取值**,
 * 而 CHECK 只能靠**重建表**放宽(SQLite 的 `ADD CONSTRAINT` 只能收紧)。那笔迁移
 * 是 015(见 `DISPATCH_EVENT_KIND_MIGRATION`)。在那之前写 `work_cancelled`
 * 会被 SQL 拒绝 —— 见下面 `insertDispatchEvent` 的**显式降级**:拒绝要能被看见,
 * 但不许把工具调用打崩。
 */
export type DispatchEventKind =
  | "work_done"
  | "work_failed"
  | "work_blocked"
  | "blocker_opened"
  | "work_cancelled";

export const DISPATCH_EVENT_KINDS: readonly DispatchEventKind[] = [
  "work_done",
  "work_failed",
  "work_blocked",
  "blocker_opened",
  "work_cancelled",
];

/**
 * 哪些 kind 需要一笔**还没落地**的迁移才能写进库。
 *
 * 这张表是「代码可以先走、schema 随后放宽」的**唯一**落点:015 落地之后
 * 这里清空即可(或者留着也无害 —— 写成功了就不会走到那个分支)。
 */
export const DISPATCH_EVENT_KIND_MIGRATION: Readonly<
  Partial<Record<DispatchEventKind, string>>
> = {
  work_cancelled: "015_dispatch_event_kinds",
};

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

/**
 * 写一条下游事件的结果。
 *
 * **`ok: false` 不是「库里出错了」,而是「这句实话当前 schema 记不下来」** ——
 * 它必须能被调用方看见并如实上报。这一条的由来:
 *
 * `dispatch_events.kind` 的 CHECK 是闭集,而 013 只放了 4 个取值。写入侧新增
 * `work_cancelled`(任务 4 / 设计 §12 #10)之后,在 015 落地之前**每一条取消
 * 根工作项的调用都会撞 CHECK**。写口在工具调用路径上(`work_update` / `report`),
 * 抛出去就是「一次合法的取消把整轮对话打崩」—— 那比不写事件坏得多。
 *
 * 所以这里**只吞掉那一个已知的、可预期的失败**(窄匹配 `kind IN` 那条 CHECK),
 * 其余任何错误一律原样抛出:把别的原因也吞掉,就成了本项目反复栽过的
 * 「检查本身静默出错」。
 */
export type InsertDispatchEventResult =
  | { readonly ok: true; readonly written: true }
  | {
      /**
       * **刻意不写**,不是出错:这条事件判进了「不值得打扰甲方」那一类。
       * (用户抱怨的那一长串就是这么消掉的 —— 但它必须在**进门**时判,
       * 不能在读取端过滤,理由见 `repo/works.ts` 那段长注释。)
       */
      readonly ok: false;
      readonly written: false;
      readonly reason: "not_worth_interrupting";
      readonly kind: DispatchEventKind;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly written: false;
      readonly reason: "kind_not_enabled_by_schema";
      readonly kind: DispatchEventKind;
      /** 放宽 CHECK 需要的那笔迁移(015 落地后这里不会再出现) */
      readonly needsMigration: string;
      readonly detail: string;
    };

/**
 * 阻塞严重度里**值得打断**的那两档。`low` / `medium` 是项目内的日常噪音 ——
 * 业务经理不需要为它们去占用甲方的注意力(它们照样在 `blocker_list` 里查得到,
 * 只是不写 outbox、不把业务经理叫醒)。
 */
const INTERRUPTING_BLOCKER_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);

/**
 * 「这条事件值得打断吗」——**只对需要额外事实才能判的那些 kind**。
 *
 * 今天只有 `blocker_opened`:它的可打扰性取决于 `blockers.severity`,而 severity
 * 不在事件行里。工作项的判据(根 / 里程碑)在 `repo/works.ts` —— 那里才有
 * 工作分解树的知识,不把它搬到这里。
 *
 * **为什么判在门上而不是各个调用方**:outbox 只有这一个写口
 * (`insertDispatchEvent`),可打扰判据就该长在门上 —— 散到调用方去,
 * 迟早有一条路漏掉,而漏掉的表现是静默的(与 `updateWorkStatus` 是
 * `works.status` 唯一写口同一条纪律)。
 *
 * 查不到阻塞行时**放行**(宁可多写一条,不能静默少写一条):这是 at-least-once
 * 的方向,与 `consumePendingDispatchEvents` 的取舍一致。
 */
function worthInterrupting(
  db: Database.Database,
  row: { kind: DispatchEventKind; subjectId: string },
): { readonly ok: true } | { readonly ok: false; readonly severity: string; readonly detail: string } {
  if (row.kind !== "blocker_opened") return { ok: true };
  const found = db
    .prepare(`SELECT severity FROM blockers WHERE id = ?`)
    .get(row.subjectId) as { severity: string } | undefined;
  if (found === undefined) return { ok: true };
  if (INTERRUPTING_BLOCKER_SEVERITIES.has(found.severity)) return { ok: true };
  return {
    ok: false,
    severity: found.severity,
    detail:
      `阻塞 ${row.subjectId} 的 severity 是「${found.severity}」—— ` +
      `只有 high / critical 值得打扰甲方(它照样在 blocker_list 里查得到)`,
  };
}

/**
 * 只认那一条 CHECK:`dispatch_events.kind` 的闭集。
 *
 * 判据是 `code` + 错误原文里的 `kind IN`(实测原文:
 * `CHECK constraint failed: kind IN (\n 'work_done', ...)`)。**故意写窄** ——
 * 将来这张表上多一条 CHECK(或别的表 CHECK 失败)时,这里判不出来、原样抛出,
 * 不会被当成「schema 落后」悄悄咽掉。
 */
function isDispatchKindCheckFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  return (
    e.code === "SQLITE_CONSTRAINT_CHECK" &&
    typeof e.message === "string" &&
    e.message.includes("kind IN")
  );
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
): InsertDispatchEventResult {
  const worth = worthInterrupting(db, row);
  if (!worth.ok) {
    return {
      ok: false, written: false, reason: "not_worth_interrupting",
      kind: row.kind, detail: worth.detail,
    };
  }
  try {
    db.prepare(
      `INSERT INTO dispatch_events (project_id, kind, subject_id, summary, created_at,
                                    consumed_at, consumed_by)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(row.projectId, row.kind, row.subjectId, row.summary, row.createdAt);
    return { ok: true, written: true };
  } catch (err) {
    if (!isDispatchKindCheckFailure(err)) throw err;
    const needs = DISPATCH_EVENT_KIND_MIGRATION[row.kind] ?? "(未登记的迁移)";
    return {
      ok: false,
      written: false,
      reason: "kind_not_enabled_by_schema",
      kind: row.kind,
      needsMigration: needs,
      detail:
        `dispatch_events.kind 的 CHECK 还不允许「${row.kind}」` +
        `(migrations/013 的闭集只有 work_done / work_failed / work_blocked / blocker_opened;` +
        `放宽只能靠重建表 = ${needs})。事件**没有落库**。`,
    };
  }
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
