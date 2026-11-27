/**
 * 职责的时间与判据(migration 039,2026-11-27)—— **纯函数**(只有 `dutyStartCapReached`
 * 是一条只读查询,读 `duty_runs` 数今天开了几轮)
 *
 * ── 它回答什么 ──────────────────────────────────────────────────
 *
 * 一条职责「下一次该几点开工」「晚开工时错过了几轮」「今天开过几轮了」。
 * 这些数都只依赖节奏与时刻,所以能穷举测试;算出来的 `nextDueAt` 由调用方存进
 * `duties.next_due_at`,排空器每次 tick 只读库、不重算(判定读库里的结构化事实)。
 *
 * ── 为什么按排定点累加,不按实际收工时间 ────────────────────────
 *
 * 「每天 9:00」的职责如果每一轮都从「上一轮收工的时刻」往后推 24 小时,开工点会
 * 一天天往后漂(9:00 → 9:40 → 10:20 …)。所以下一轮的时刻永远从**上一个排定点**
 * 往后推,晚开工只体现在「这一轮比排定晚了多久」这个如实的事实上。
 *
 * ── 夜里不开工 ──────────────────────────────────────────────────
 *
 * 按小时的节奏落在 22:00–08:00 的排定点顺延到当天 08:00。每天 / 每周的节奏**不套**
 * 这条:那个时刻是甲方亲手填的,他填 23:30 就是 23:30。
 */
import type { DutyCadence } from "../storage/repo/duties.js";
import { countDutyRunsStartedSince } from "../storage/repo/duties.js";
import type Database from "better-sqlite3";

const HOUR_MS = 3_600_000;

/** 一轮功课最多几步(「一轮只推进一步」;多于这个数说明还没想清这一轮做什么)。 */
export const DUTY_MAX_STEPS = 3;
/** 全系统每个本地日最多开几轮工(量上的止损;到顶之后当天不再开新工,次日恢复)。 */
export const DUTY_DAILY_START_CAP = 12;
/** 按小时的职责不开新工的时段:[22:00, 08:00)。 */
export const DUTY_QUIET_FROM_HOUR = 22;
export const DUTY_QUIET_TO_HOUR = 8;

/** 这个钟点在不在这段静默时段里(0–23 的整数钟点;纯函数,测试不必造时间戳)。 */
export function isQuietHour(hour: number): boolean {
  return hour >= DUTY_QUIET_FROM_HOUR || hour < DUTY_QUIET_TO_HOUR;
}

export function inQuietHours(t: number): boolean {
  return isQuietHour(new Date(t).getHours());
}

export type ClockParse = { readonly ok: true; readonly hour: number; readonly minute: number }
  | { readonly ok: false };

/** 解析 "HH:MM"(本地时刻)。只认 00:00–23:59。 */
export function parseClock(at: string): ClockParse {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  if (m === null) return { ok: false };
  return { ok: true, hour: Number(m[1]), minute: Number(m[2]) };
}

export type CadenceCheck =
  | { readonly ok: true; readonly cadence: DutyCadence }
  | { readonly ok: false; readonly message: string };

/**
 * 外部输入(界面表单)→ 节奏。**形状不对就拒收**,不静默补默认值:
 * 节奏错了的后果是「排了一个永远不会响的闹钟」或者「一夜跑了二十轮」。
 */
export function validateCadence(input: unknown): CadenceCheck {
  const o = (input ?? {}) as Record<string, unknown>;
  const kind = o["kind"];
  if (kind === "daily" || kind === "weekly") {
    const at = typeof o["at"] === "string" ? o["at"] : "";
    const clock = parseClock(at);
    if (!clock.ok) {
      return { ok: false, message: "节奏的时刻要写成 HH:MM(00:00–23:59)" };
    }
    if (kind === "daily") {
      return { ok: true, cadence: { kind, at, weekday: null, hours: null } };
    }
    const weekday = o["weekday"];
    if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, message: "每周的节奏要选星期几(0 = 周日 … 6 = 周六)" };
    }
    return { ok: true, cadence: { kind, at, weekday, hours: null } };
  }
  if (kind === "hourly") {
    const hours = o["hours"];
    if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 168) {
      return { ok: false, message: "按小时的节奏:间隔要是 1–168 的整数小时" };
    }
    return { ok: true, cadence: { kind, at: null, weekday: null, hours } };
  }
  return { ok: false, message: "节奏只能是每天、每周或按小时" };
}

/** `after` 那一天的本地 `hh:mm`(再往后加 `addDays` 天)。用本地日历构造,跨夏令时不偏。 */
function localSlot(after: number, hour: number, minute: number, addDays: number): number {
  const d = new Date(after);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays, hour, minute, 0, 0).getTime();
}

/**
 * 这个节奏在 `after` **之后**的第一个排定点(严格大于 `after`)。
 *
 *   · `daily`  —— 今天的 HH:MM;已经过了就是明天的;
 *   · `weekly` —— 本周星期 W 的 HH:MM;已经过了就是下周的;
 *   · `hourly` —— `after + N 小时`;落在静默时段就顺延到紧接着的 08:00。
 *
 * 从「上一个排定点」调用它 ⇒ 一串不漂的开工点;从「此刻」调用它 ⇒ 建职责时的第一轮。
 */
export function nextDueAt(cadence: DutyCadence, after: number): number {
  if (cadence.kind === "hourly") {
    const t = after + Math.max(1, cadence.hours ?? 1) * HOUR_MS;
    if (!inQuietHours(t)) return t;
    const hour = new Date(t).getHours();
    // 午夜之后(0 点到 8 点)顺延到**当天** 08:00;22 点之后顺延到**次日** 08:00。
    return localSlot(t, DUTY_QUIET_TO_HOUR, 0, hour < DUTY_QUIET_TO_HOUR ? 0 : 1);
  }
  const clock = parseClock(cadence.at ?? "");
  const hour = clock.ok ? clock.hour : 0;
  const minute = clock.ok ? clock.minute : 0;
  if (cadence.kind === "daily") {
    const today = localSlot(after, hour, minute, 0);
    return today > after ? today : localSlot(after, hour, minute, 1);
  }
  const today = new Date(after).getDay();
  const offset = ((cadence.weekday ?? today) - today + 7) % 7;
  const thisWeek = localSlot(after, hour, minute, offset);
  return thisWeek > after ? thisWeek : localSlot(after, hour, minute, offset + 7);
}

/**
 * 以排定点 `slot` 为起点往后数,到 `now` 为止的结果:
 *   · `missed`   —— `slot` 之后、`now` 之前(含)又过去了几个排定点(**不含**正在补做的这一轮);
 *   · `nextDueAt` —— `now` 之后的第一个排定点(下一次该开工的时刻)。
 *
 * 一轮开工时两件事同时要:日报如实写「错过了几轮」,而职责的 `next_due_at` 要推进到
 * 一个**还在未来**的排定点 —— 只往后推一格的话,补做一轮时它可能已经又过去了。
 * 上限 10,000 是防御(坏数据不该让这里转不完)。
 */
export function slotsAfter(
  cadence: DutyCadence,
  slot: number,
  now: number,
): { readonly missed: number; readonly nextDueAt: number } {
  let t = slot;
  let missed = 0;
  while (missed < 10_000) {
    const next = nextDueAt(cadence, t);
    if (next > now) return { missed, nextDueAt: next };
    t = next;
    missed += 1;
  }
  return { missed, nextDueAt: t };
}

/** 排定点 `dueAt` 到 `now` 之间**错过了几轮**(进程当时不在时会大于 0;日报如实写它)。 */
export function missedSlots(cadence: DutyCadence, dueAt: number, now: number): number {
  return slotsAfter(cadence, dueAt, now).missed;
}

/** 这一轮服务完 `slot` 之后,下一次该开工的时刻:`now` 之后的第一个排定点。 */
export function advanceDueAt(cadence: DutyCadence, slot: number, now: number): number {
  return slotsAfter(cadence, slot, now).nextDueAt;
}

/** `t` 所在那个本地日的零点(「今天开过几轮」的起点)。 */
export function localDayStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

/**
 * 今天全系统开的工到上限了吗。**规则(`duty_due`)与开课工具读的是同一个判据** ——
 * 规则拦在「叫不叫醒」,工具拦在「写不写得进」,两处一个答案。
 * 本文件其余都是纯函数;这一条是只读查询(它读 `duty_runs`,不写任何东西)。
 */
export function dutyStartCapReached(db: Database.Database, now: number): boolean {
  return countDutyRunsStartedSince(db, localDayStart(now)) >= DUTY_DAILY_START_CAP;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 节奏的一行说法(界面与任务正文共用,不各写一份)。 */
export function cadenceText(cadence: DutyCadence): string {
  if (cadence.kind === "daily") return `每天 ${cadence.at ?? ""}`.trim();
  if (cadence.kind === "weekly") {
    const w = cadence.weekday ?? 0;
    return `每${WEEKDAYS[w] ?? `周${String(w)}`} ${cadence.at ?? ""}`.trim();
  }
  return `每 ${cadence.hours ?? 1} 小时(${pad2(DUTY_QUIET_FROM_HOUR)}:00–${pad2(DUTY_QUIET_TO_HOUR)}:00 不开新工)`;
}

/** 时刻的一行说法(本地 "HH:MM")。 */
export function formatClock(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ── 该不该叫醒业务经理(规则 `duty_due` 的判据本体)────────────────

/** 「开工」还是「收工」—— 同一条待办的两种形态,互斥。 */
export type DutyPhase = "open" | "close";

/** `dueDutyPhase` 读的全部事实。规则侧由 `collectRuleFacts` 物化好递进来(规则拿不到 db)。 */
export interface DutyDueInput {
  /** 这个项目是不是某条职责的工作间;不是就 `null`。 */
  readonly duty: { readonly status: string; readonly formal: boolean; readonly nextDueAt: number | null } | null;
  /** 这条职责未收工的那一轮;没有就 `null`。 */
  readonly openRunStartedAt: number | null;
  readonly now: number;
  /** 工作间项目在库里的状态(只有 `active` 才开工 / 收工)。 */
  readonly projectStatus: string;
  /** 有问题在等甲方答(球在甲方那边)。 */
  readonly awaitingClient: boolean;
  /** 有货交出去了、甲方还没表态(只对「正式交付物」的职责有意义)。 */
  readonly acceptancePending: boolean;
  /** 工作间安静不安静的三件事:没做完的活、等着审的产出、还没答的提问。 */
  readonly nonTerminalWorkCount: number;
  readonly pendingReviewCount: number;
  readonly openAskCount: number;
  /** 今天全系统开的工到上限了吗。 */
  readonly startCapReached: boolean;
}

/**
 * 这条职责此刻该产出哪一种待办;都不该就 `null`。**纯函数**,只读上面那组事实。
 *
 *   · 开工 —— 职责启用、工作间进行中、到点了、没有未收工的一轮、没有等甲方答的问题、
 *             今天没开满;正式交付的职责在「货交了等你验收」时也不开新工。
 *   · 收工 —— 有未收工的一轮,并且工作间**安静了**(活都落定了),或者已经拖到了
 *             下一个排定点(「既过不恋」:不把旧的拖进新一轮)。
 *
 * ⚠️ **有问题在等甲方答时,两种都不做**:开工不叠轮次;收工要等他的答复落进这一轮。
 *    答复到了另有 `resume_client` 叫醒业务经理,之后这里自然会再产出收工。
 */
export function dueDutyPhase(q: DutyDueInput): DutyPhase | null {
  const duty = q.duty;
  if (duty === null) return null;
  if (duty.status !== "active" || q.projectStatus !== "active") return null;

  if (q.openRunStartedAt === null) {
    if (duty.nextDueAt === null || duty.nextDueAt > q.now) return null;
    if (q.awaitingClient) return null;
    if (duty.formal && q.acceptancePending) return null;
    if (q.startCapReached) return null;
    return "open";
  }

  if (q.awaitingClient) return null;
  const quiet = q.nonTerminalWorkCount === 0 && q.pendingReviewCount === 0 && q.openAskCount === 0;
  const overdue = duty.nextDueAt !== null && duty.nextDueAt <= q.now;
  return quiet || overdue ? "close" : null;
}

/** 时长的一行说法:「不到 1 分钟」「35 分钟」「2 小时 10 分钟」「3 天 4 小时」。向下取整(30 秒不是「1 分钟」)。 */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH === 0 ? `${days} 天` : `${days} 天 ${restH} 小时`;
}
