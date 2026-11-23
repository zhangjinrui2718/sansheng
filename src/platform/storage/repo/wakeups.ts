/**
 * 结构化唤醒仓储(`wakeups`,migration 038)
 *
 * ── 判据铁律 ────────────────────────────────────────────────────
 *
 * 到期是**纯函数**(`dueWakeups`),消费是**库里的终止判据**(`markWakeupFired`,
 * 回合成功结束才写)。规则(`dispatcher.ts` 的 `wakeup_due`)只读本表 + 账本,
 * 不携带任何跨排空状态 —— 与批次 21 同一条纪律。
 */
import type Database from "better-sqlite3";

/** 唤醒的形状。闭集(将来加 cron 不动 schema,038 不建 CHECK)。 */
export const WAKEUP_KINDS = ["at", "every"] as const;
export type WakeupKind = (typeof WAKEUP_KINDS)[number];

export const WAKEUP_STATUSES = ["pending", "done", "cancelled"] as const;
export type WakeupStatus = (typeof WAKEUP_STATUSES)[number];

export function isWakeupKind(v: unknown): v is WakeupKind {
  return typeof v === "string" && (WAKEUP_KINDS as readonly string[]).includes(v);
}
export function isWakeupStatus(v: unknown): v is WakeupStatus {
  return typeof v === "string" && (WAKEUP_STATUSES as readonly string[]).includes(v);
}

export interface WakeupRow {
  id: string;
  projectId: string;
  createdByAgentId: string;
  note: string;
  kind: WakeupKind;
  /** `kind='at'` 的到点;every 时为 null。 */
  at: number | null;
  /** `kind='every'` 的周期(毫秒);at 时为 null。 */
  intervalMs: number | null;
  status: WakeupStatus;
  lastFiredAt: number | null;
  firedCount: number;
  createdAt: number;
}

interface RawWakeup {
  id: string;
  project_id: string;
  created_by_agent_id: string;
  note: string;
  kind: string;
  at: number | null;
  interval_ms: number | null;
  status: string;
  last_fired_at: number | null;
  fired_count: number;
  created_at: number;
}

function toRow(raw: RawWakeup): WakeupRow {
  if (!isWakeupKind(raw.kind)) {
    throw new Error(`wakeups 表里出现未定义 kind「${raw.kind}」(id=${raw.id})`);
  }
  if (!isWakeupStatus(raw.status)) {
    throw new Error(`wakeups 表里出现未定义 status「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    createdByAgentId: raw.created_by_agent_id,
    note: raw.note,
    kind: raw.kind,
    at: raw.at,
    intervalMs: raw.interval_ms,
    status: raw.status,
    lastFiredAt: raw.last_fired_at,
    firedCount: raw.fired_count,
    createdAt: raw.created_at,
  };
}

// ── 写 ──────────────────────────────────────────────────────────

export function insertWakeup(db: Database.Database, row: WakeupRow): void {
  db.prepare(
    `INSERT INTO wakeups (id, project_id, created_by_agent_id, note, kind, at, interval_ms,
                          status, last_fired_at, fired_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id, row.projectId, row.createdByAgentId, row.note, row.kind, row.at, row.intervalMs,
    row.status, row.lastFiredAt, row.firedCount, row.createdAt,
  );
}

// ── 读 ──────────────────────────────────────────────────────────

export function getWakeup(db: Database.Database, id: string): WakeupRow | null {
  const raw = db.prepare(`SELECT * FROM wakeups WHERE id = ?`).get(id) as RawWakeup | undefined;
  return raw === undefined ? null : toRow(raw);
}

export function listWakeups(db: Database.Database, projectId: string): WakeupRow[] {
  const raw = db
    .prepare(`SELECT * FROM wakeups WHERE project_id = ? ORDER BY created_at DESC`)
    .all(projectId) as RawWakeup[];
  return raw.map(toRow);
}

/**
 * **到期谓词(纯函数)**:项目里此刻该被叫醒的唤醒。
 *
 *   · `at`:`at <= now` 且仍 pending;
 *   · `every`:`(last_fired_at ?? created_at) + interval <= now` 且仍 pending。
 *
 * ⚠️ **错过折叠**(⑤):`every` 错过 N 个周期也只在这张表里出现**一行** ⇒
 * 待办天然只有一条(multica 的「只补最新一次」同款)。
 */
export function dueWakeups(db: Database.Database, projectId: string, now: number): WakeupRow[] {
  const raw = db
    .prepare(`SELECT * FROM wakeups WHERE project_id = ? AND status = 'pending'`)
    .all(projectId) as RawWakeup[];
  return raw
    .map(toRow)
    .filter((w) => {
      if (w.kind === "at") return w.at !== null && w.at <= now;
      const anchor = w.lastFiredAt ?? w.createdAt;
      return w.intervalMs !== null && w.intervalMs > 0 && now - anchor >= w.intervalMs;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ── 消费与熔断 ──────────────────────────────────────────────────

/**
 * **点火之后的记账**(消费,at-least-once):回合成功结束才调。
 *
 *   · `at` ⇒ `status='done'`(一次性,点完即终态);
 *   · `every` ⇒ `last_fired_at = now`(**续期锚** —— 它同时是错过折叠与
 *     尝试预算的 `targetState`:点火成功 ⇒ 预算清零,那 3 次是给「叫不醒」用的)。
 */
export function markWakeupFired(db: Database.Database, id: string, now: number): void {
  const w = getWakeup(db, id);
  if (w === null) return; // 幂等:行没了(项目被删)就无事可记
  if (w.kind === "at") {
    db.prepare(`UPDATE wakeups SET status = 'done', last_fired_at = ?, fired_count = fired_count + 1
                WHERE id = ?`).run(now, id);
  } else {
    db.prepare(`UPDATE wakeups SET last_fired_at = ?, fired_count = fired_count + 1
                WHERE id = ?`).run(now, id);
  }
}

/** 显式取消(工具面用;`cancelled` 是终态,不再点火)。 */
export function cancelWakeup(db: Database.Database, id: string): boolean {
  const r = db
    .prepare(`UPDATE wakeups SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
    .run(id);
  return r.changes > 0;
}

/**
 * **熔断(⑤)**:预算烧穿的 pending 唤醒不许变僵尸 —— 自动 `cancelled`。
 *
 * 判据读的是既有账本(`dispatch_attempts`):待办 key `wakeup_due:<id>` 的
 * `notified_at` 非空 = 平台已经「叫醒到顶并播报过」(与 `escalate_stalled_work`
 * 同一行)。返回被熔断的行(调用方负责播报);没有则空数组。
 *
 * ⚠️ **放在宿主排空前的扫描里**(`serve.ts`),不在规则的 `if` 里 ——
 * 规则是纯查询,不许写库(§11.3 的结构保证)。
 */
export function cancelExhaustedWakeups(
  db: Database.Database,
  projectId: string,
): WakeupRow[] {
  const pending = db
    .prepare(`SELECT * FROM wakeups WHERE project_id = ? AND status = 'pending'`)
    .all(projectId) as RawWakeup[];
  const ledger = db
    .prepare(`SELECT todo_key, attempts, notified_at FROM dispatch_attempts WHERE project_id = ?`)
    .all(projectId) as Array<{ todo_key: string; attempts: number; notified_at: number | null }>;
  const exhaustedKeys = new Set(
    ledger
      .filter((r) => r.notified_at !== null)
      .map((r) => r.todo_key),
  );
  const cancelled: WakeupRow[] = [];
  for (const raw of pending) {
    const w = toRow(raw);
    if (!exhaustedKeys.has(`wakeup_due:${w.id}`)) continue;
    db.prepare(`UPDATE wakeups SET status = 'cancelled' WHERE id = ?`).run(w.id);
    cancelled.push({ ...w, status: "cancelled" });
  }
  return cancelled;
}
