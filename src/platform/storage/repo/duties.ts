/**
 * 职责仓储(`duties` / `duty_runs`,migration 039)
 *
 * ── 判据铁律 ────────────────────────────────────────────────────
 *
 * 「该不该开工」是纯查询:规则(`dispatcher.ts` 的 `duty_due`)每次 tick 读
 * `status` / `next_due_at` 与有没有未收工的一轮,不携带任何跨排空状态。
 * 时间怎么算在 `runtime/duty.ts`(纯函数);本文件只管把行读写对。
 *
 * ⚠️ **repos 不造 id、不读时钟**:id 与时刻都由调用方传进来(与其余仓储同一条规矩)。
 */
import type Database from "better-sqlite3";

// ── 闭集(不建 CHECK,将来加取值不动 schema)──────────────────────

export const DUTY_CADENCE_KINDS = ["daily", "weekly", "hourly"] as const;
export type DutyCadenceKind = (typeof DUTY_CADENCE_KINDS)[number];

export const DUTY_STATUSES = ["active", "paused"] as const;
export type DutyStatus = (typeof DUTY_STATUSES)[number];

export const DUTY_RUN_STATUSES = ["open", "done"] as const;
export type DutyRunStatus = (typeof DUTY_RUN_STATUSES)[number];

export function isDutyCadenceKind(v: unknown): v is DutyCadenceKind {
  return typeof v === "string" && (DUTY_CADENCE_KINDS as readonly string[]).includes(v);
}
export function isDutyStatus(v: unknown): v is DutyStatus {
  return typeof v === "string" && (DUTY_STATUSES as readonly string[]).includes(v);
}
export function isDutyRunStatus(v: unknown): v is DutyRunStatus {
  return typeof v === "string" && (DUTY_RUN_STATUSES as readonly string[]).includes(v);
}

/**
 * 节奏。三选一,其余两格为 `null`:
 *   · `daily`  —— 每天 `at`("HH:MM",本地时刻);
 *   · `weekly` —— 每周 `weekday` 的 `at`(0 = 周日 … 6 = 周六,与 JS 的 `getDay` 同一套);
 *   · `hourly` —— 每隔 `hours` 小时(>= 1)。
 */
export interface DutyCadence {
  kind: DutyCadenceKind;
  at: string | null;
  weekday: number | null;
  hours: number | null;
}

export interface DutyRow {
  id: string;
  /** 这条职责的工作间(长期保持 active 的项目;与职责一对一)。 */
  projectId: string;
  name: string;
  goal: string;
  /** 必须先问甲方的事(原样带给每一轮的任务正文)。 */
  boundaries: string;
  cadence: DutyCadence;
  /** `false` = 例行产出(日报);`true` = 正式交付物(要走验收)。 */
  formal: boolean;
  status: DutyStatus;
  /** 下一次该开工的时刻;`null` = 不排(paused)。 */
  nextDueAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 功课里的一步。`done` 为 `null` = 还没交代(开课时就是这个值)。 */
export interface DutyRunStep {
  title: string;
  /** 可检验的标准:做到什么算这一步成了。 */
  criterion: string;
  done: boolean | null;
  note: string | null;
}

/** 这一轮窗口内平台查到的一条失败。`kind` 的取值见 `runtime/duty.ts` 的 `failuresSince`。 */
export interface DutyFailure {
  kind: string;
  id: string;
  title: string;
}

export interface DutyRunRow {
  id: string;
  dutyId: string;
  /** 这一轮服务的是哪个排定点(晚开工时与 `startedAt` 不同)。 */
  scheduledFor: number;
  startedAt: number;
  finishedAt: number | null;
  status: DutyRunStatus;
  steps: DutyRunStep[];
  doneSummary: string | null;
  notDone: string | null;
  cause: string | null;
  nextChange: string | null;
  gaps: string | null;
  learned: string | null;
  failures: readonly DutyFailure[];
}

interface RawDuty {
  id: string;
  project_id: string;
  name: string;
  goal: string;
  boundaries: string;
  cadence_kind: string;
  cadence_at: string | null;
  cadence_weekday: number | null;
  cadence_hours: number | null;
  formal: number;
  status: string;
  next_due_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RawDutyRun {
  id: string;
  duty_id: string;
  scheduled_for: number;
  started_at: number;
  finished_at: number | null;
  status: string;
  steps: string;
  done_summary: string | null;
  not_done: string | null;
  cause: string | null;
  next_change: string | null;
  gaps: string | null;
  learned: string | null;
  failures: string;
}

function toDutyRow(raw: RawDuty): DutyRow {
  if (!isDutyCadenceKind(raw.cadence_kind)) {
    throw new Error(`duties 表里出现未定义 cadence_kind「${raw.cadence_kind}」(id=${raw.id})`);
  }
  if (!isDutyStatus(raw.status)) {
    throw new Error(`duties 表里出现未定义 status「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: raw.name,
    goal: raw.goal,
    boundaries: raw.boundaries,
    cadence: {
      kind: raw.cadence_kind,
      at: raw.cadence_at,
      weekday: raw.cadence_weekday,
      hours: raw.cadence_hours,
    },
    formal: raw.formal !== 0,
    status: raw.status,
    nextDueAt: raw.next_due_at,
    lastRunAt: raw.last_run_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toDutyRunRow(raw: RawDutyRun): DutyRunRow {
  if (!isDutyRunStatus(raw.status)) {
    throw new Error(`duty_runs 表里出现未定义 status「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    dutyId: raw.duty_id,
    scheduledFor: raw.scheduled_for,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
    status: raw.status,
    steps: parseSteps(raw.steps, raw.id),
    doneSummary: raw.done_summary,
    notDone: raw.not_done,
    cause: raw.cause,
    nextChange: raw.next_change,
    gaps: raw.gaps,
    learned: raw.learned,
    failures: parseFailures(raw.failures, raw.id),
  };
}

/**
 * ⚠️ **这里的 JSON 解析失败要响亮地抛**,不像 `acceptance_criteria` 那样退成空数组:
 * `steps` 只有平台写,而「每一步都交代了」这条收工校验在空数组上会**空转通过**——
 * 把坏数据读成「没有功课」正好绕过校验。坏行就该在这里被看见。
 */
function parseSteps(json: string, id: string): DutyRunStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`duty_runs.steps 不是合法 JSON(duty_run id=${id})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`duty_runs.steps 不是数组(duty_run id=${id})`);
  }
  return parsed.map((s: unknown) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return {
      title: typeof o["title"] === "string" ? o["title"] : "",
      criterion: typeof o["criterion"] === "string" ? o["criterion"] : "",
      done: typeof o["done"] === "boolean" ? o["done"] : null,
      note: typeof o["note"] === "string" ? o["note"] : null,
    };
  });
}

function parseFailures(json: string, id: string): DutyFailure[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`duty_runs.failures 不是合法 JSON(duty_run id=${id})`);
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((f: unknown) => {
    const o = (f ?? {}) as Record<string, unknown>;
    return typeof o["kind"] === "string" && typeof o["id"] === "string" && typeof o["title"] === "string"
      ? [{ kind: o["kind"], id: o["id"], title: o["title"] }]
      : [];
  });
}

// ── duties:写 ──────────────────────────────────────────────────

export function insertDuty(db: Database.Database, row: DutyRow): void {
  db.prepare(
    `INSERT INTO duties (id, project_id, name, goal, boundaries, cadence_kind, cadence_at, cadence_weekday,
                          cadence_hours, formal, status, next_due_at, last_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.projectId, row.name, row.goal, row.boundaries,
    row.cadence.kind, row.cadence.at, row.cadence.weekday, row.cadence.hours,
    row.formal ? 1 : 0, row.status, row.nextDueAt, row.lastRunAt, row.createdAt, row.updatedAt,
  );
}

export interface DutyUpdate {
  name?: string;
  goal?: string;
  boundaries?: string;
  cadence?: DutyCadence;
  formal?: boolean;
  status?: DutyStatus;
  /** `null` 是一个合法的写入值(paused 时清空排定)⇒ 调用方要清空时显式传 `{ nextDueAt: null }`。 */
  nextDueAt?: number | null;
  lastRunAt?: number | null;
}

/** 局部更新。`now` 由调用方传(更新 `updated_at`)。 */
export function updateDuty(db: Database.Database, id: string, fields: DutyUpdate, now: number): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    vals.push(value);
  };
  if (fields.name !== undefined) push("name", fields.name);
  if (fields.goal !== undefined) push("goal", fields.goal);
  if (fields.boundaries !== undefined) push("boundaries", fields.boundaries);
  if (fields.cadence !== undefined) {
    push("cadence_kind", fields.cadence.kind);
    push("cadence_at", fields.cadence.at);
    push("cadence_weekday", fields.cadence.weekday);
    push("cadence_hours", fields.cadence.hours);
  }
  if (fields.formal !== undefined) push("formal", fields.formal ? 1 : 0);
  if (fields.status !== undefined) push("status", fields.status);
  // ⚠️ `nextDueAt: null` 是「清空排定」这个**有意的写法**,不能用 `!== undefined` 以外的判法吞掉它。
  if (fields.nextDueAt !== undefined) push("next_due_at", fields.nextDueAt);
  if (fields.lastRunAt !== undefined) push("last_run_at", fields.lastRunAt);
  if (sets.length === 0) return;
  push("updated_at", now);
  db.prepare(`UPDATE duties SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

// ── duties:读 ──────────────────────────────────────────────────

export function getDuty(db: Database.Database, id: string): DutyRow | null {
  const raw = db.prepare(`SELECT * FROM duties WHERE id = ?`).get(id) as RawDuty | undefined;
  return raw === undefined ? null : toDutyRow(raw);
}

/** 这个项目是不是某条职责的工作间;是就返回那条职责。**「职责项目」的判据只有这一处。** */
export function dutyOfProject(db: Database.Database, projectId: string): DutyRow | null {
  const raw = db
    .prepare(`SELECT * FROM duties WHERE project_id = ?`)
    .get(projectId) as RawDuty | undefined;
  return raw === undefined ? null : toDutyRow(raw);
}

/** 全部职责,启用的在前,组内按创建先后。 */
export function listDuties(db: Database.Database): DutyRow[] {
  const raw = db
    .prepare(`SELECT * FROM duties ORDER BY (status = 'active') DESC, created_at ASC`)
    .all() as RawDuty[];
  return raw.map(toDutyRow);
}

// ── duty_runs:写 ───────────────────────────────────────────────

export function insertDutyRun(db: Database.Database, row: DutyRunRow): void {
  db.prepare(
    `INSERT INTO duty_runs (id, duty_id, scheduled_for, started_at, finished_at, status, steps,
                            done_summary, not_done, cause, next_change, gaps, learned, failures)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.dutyId, row.scheduledFor, row.startedAt, row.finishedAt, row.status,
    JSON.stringify(row.steps),
    row.doneSummary, row.notDone, row.cause, row.nextChange, row.gaps, row.learned,
    JSON.stringify(row.failures),
  );
}

export interface DutyRunUpdate {
  steps?: readonly DutyRunStep[];
  status?: DutyRunStatus;
  finishedAt?: number | null;
  doneSummary?: string | null;
  notDone?: string | null;
  cause?: string | null;
  nextChange?: string | null;
  gaps?: string | null;
  learned?: string | null;
  failures?: readonly DutyFailure[];
}

export function updateDutyRun(db: Database.Database, id: string, fields: DutyRunUpdate): void {
  const current = getDutyRun(db, id);
  if (current === null) return; // 行没了(项目被删)就无事可记 —— 幂等
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    vals.push(value);
  };
  if (fields.steps !== undefined) push("steps", JSON.stringify(fields.steps));
  if (fields.status !== undefined) push("status", fields.status);
  if (fields.finishedAt !== undefined) push("finished_at", fields.finishedAt);
  if (fields.doneSummary !== undefined) push("done_summary", fields.doneSummary);
  if (fields.notDone !== undefined) push("not_done", fields.notDone);
  if (fields.cause !== undefined) push("cause", fields.cause);
  if (fields.nextChange !== undefined) push("next_change", fields.nextChange);
  if (fields.gaps !== undefined) push("gaps", fields.gaps);
  if (fields.learned !== undefined) push("learned", fields.learned);
  if (fields.failures !== undefined) push("failures", JSON.stringify(fields.failures));
  if (sets.length === 0) return;
  db.prepare(`UPDATE duty_runs SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

// ── duty_runs:读 ───────────────────────────────────────────────

export function getDutyRun(db: Database.Database, id: string): DutyRunRow | null {
  const raw = db.prepare(`SELECT * FROM duty_runs WHERE id = ?`).get(id) as RawDutyRun | undefined;
  return raw === undefined ? null : toDutyRunRow(raw);
}

/**
 * 这条职责**未收工**的那一轮;没有就 `null`。
 * 「同一职责同时只有一轮未收工」由开课工具保证(已有未收工的一轮就拒收),这里不假设唯一。
 */
export function openDutyRunOf(db: Database.Database, dutyId: string): DutyRunRow | null {
  const raw = db
    .prepare(`SELECT * FROM duty_runs WHERE duty_id = ? AND status = 'open' ORDER BY started_at ASC LIMIT 1`)
    .get(dutyId) as RawDutyRun | undefined;
  return raw === undefined ? null : toDutyRunRow(raw);
}

/** 最近的一轮(不论收没收工);从没开过工就 `null`。 */
export function lastDutyRunOf(db: Database.Database, dutyId: string): DutyRunRow | null {
  const raw = db
    .prepare(`SELECT * FROM duty_runs WHERE duty_id = ? ORDER BY started_at DESC LIMIT 1`)
    .get(dutyId) as RawDutyRun | undefined;
  return raw === undefined ? null : toDutyRunRow(raw);
}

/** 某个时刻之后开过几轮(「每天最多开几轮」读它;调用方算好本地日的起点传进来)。 */
export function countDutyRunsStartedSince(db: Database.Database, since: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM duty_runs WHERE started_at >= ?`)
    .get(since) as { n: number };
  return row.n;
}
