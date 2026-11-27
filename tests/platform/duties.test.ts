/**
 * 职责(039,2026-11-27)· 回归 —— 数据、时间、四个接口
 *
 * ── 这一文件守什么 ───────────────────────────────────────────────
 *
 *   ① **时间算得对、不漂**:下一次开工点按排定点累加(不是按实际收工时间),
 *      按小时的节奏夜里不开工,错过的轮次如实可数。
 *   ② **仓储把行读写对**:闭集之外的值响亮报错;`steps` 的 JSON 坏了**不退成空**
 *      (空数组会让「每一步都交代了」的收工校验空转通过)。
 *   ③ **职责只有人能建、能改**:四个接口先校验后落库;暂停 / 启用与工作间项目同步;
 *      「现在做一次」的三种状态冲突都拒收。
 *
 * 规则与工具的判据在 `duty-rule.test.ts` / `duty-runs.test.ts`;宿主级在 `duty-host.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import {
  insertDuty, getDuty, dutyOfProject, listDuties, updateDuty,
  insertDutyRun, getDutyRun, openDutyRunOf, lastDutyRunOf, updateDutyRun,
  countDutyRunsStartedSince,
  type DutyRow, type DutyRunRow,
} from "../../src/platform/storage/repo/duties.js";
import {
  closeProject, getProjectRow, listProjects, listAssignments,
} from "../../src/platform/storage/repo/projects.js";
import {
  cadenceText, formatDuration, inQuietHours, isQuietHour, localDayStart, missedSlots,
  nextDueAt, parseClock, validateCadence,
  DUTY_QUIET_FROM_HOUR, DUTY_QUIET_TO_HOUR,
} from "../../src/platform/runtime/duty.js";
import { projectWorkspaceRoot } from "../../src/platform/workspace/root.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { DutyView } from "@shared/types/platform.js";

const MIN = 60_000;

/** 本地时刻构造(测试对时区不敏感:期望值与被测值用同一套本地日历算)。 */
function at(y: number, month: number, day: number, h: number, m = 0): number {
  return new Date(y, month - 1, day, h, m, 0, 0).getTime();
}

let db: Database.Database;
let workRoot = "";
let seq = 0;

beforeEach(() => {
  db = openPlatformMemoryDb();
  workRoot = mkdtempSync(join(tmpdir(), "ss-duties-"));
  seq = 0;
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

const DAILY_9 = { kind: "daily" as const, at: "09:00", weekday: null, hours: null };

function mkDuty(over: Partial<DutyRow> = {}): DutyRow {
  const row: DutyRow = {
    id: "du_1", projectId: "p_duty", name: "行业简报", goal: "每天一份三行简报",
    boundaries: "付费来源先问我", cadence: DAILY_9, formal: false, status: "active",
    nextDueAt: at(2026, 11, 27, 9), lastRunAt: null,
    createdAt: at(2026, 11, 26, 20), updatedAt: at(2026, 11, 26, 20),
    ...over,
  };
  db.prepare(
    `INSERT INTO projects (id, name, client, goal, acceptance_criteria, status, created_at, closed_at, version, parent_project_id, close_consented_at)
     VALUES (?, '工作间', '职责', 'g', '[]', 'active', ?, NULL, 1, NULL, NULL)`,
  ).run(row.projectId, row.createdAt);
  insertDuty(db, row);
  return row;
}

function mkRun(over: Partial<DutyRunRow> = {}): DutyRunRow {
  const row: DutyRunRow = {
    id: "dr_1", dutyId: "du_1", scheduledFor: at(2026, 11, 27, 9), startedAt: at(2026, 11, 27, 9, 1),
    finishedAt: null, status: "open",
    steps: [{ title: "读三份来源", criterion: "每份有一句结论和链接", done: null, note: null }],
    doneSummary: null, notDone: null, cause: null, nextChange: null, gaps: null, learned: null,
    failures: [],
    ...over,
  };
  insertDutyRun(db, row);
  return row;
}

// ── ① 时间 ──────────────────────────────────────────────────────

describe("职责 · 时间(纯函数)", () => {
  it("parseClock:只认 00:00–23:59 的 HH:MM", () => {
    expect(parseClock("09:05")).toEqual({ ok: true, hour: 9, minute: 5 });
    expect(parseClock("00:00")).toEqual({ ok: true, hour: 0, minute: 0 });
    expect(parseClock("23:59")).toEqual({ ok: true, hour: 23, minute: 59 });
    for (const bad of ["9:05", "24:00", "07:60", "0905", "", "12:5"]) {
      expect(parseClock(bad).ok, bad).toBe(false);
    }
  });

  it("validateCadence:三种节奏各要配对的字段;形状不对就拒收,不补默认值", () => {
    expect(validateCadence({ kind: "daily", at: "09:00" })).toEqual({
      ok: true, cadence: { kind: "daily", at: "09:00", weekday: null, hours: null },
    });
    expect(validateCadence({ kind: "weekly", at: "08:30", weekday: 1 })).toEqual({
      ok: true, cadence: { kind: "weekly", at: "08:30", weekday: 1, hours: null },
    });
    expect(validateCadence({ kind: "hourly", hours: 2 })).toEqual({
      ok: true, cadence: { kind: "hourly", at: null, weekday: null, hours: 2 },
    });
    const bad = [
      { kind: "daily" }, { kind: "daily", at: "25:00" }, { kind: "weekly", at: "09:00" },
      { kind: "weekly", at: "09:00", weekday: 7 }, { kind: "weekly", at: "09:00", weekday: -1 },
      { kind: "hourly" }, { kind: "hourly", hours: 0 }, { kind: "hourly", hours: 1.5 },
      { kind: "hourly", hours: 200 }, { kind: "cron" }, {}, null,
    ];
    for (const b of bad) {
      expect(validateCadence(b).ok, JSON.stringify(b)).toBe(false);
    }
  });

  it("静默时段:[22:00, 08:00) —— 22 点与 0 点在里面,8 点整与 21 点不在", () => {
    for (const h of [22, 23, 0, 1, 7]) expect(isQuietHour(h), `${h} 点`).toBe(true);
    for (const h of [8, 9, 12, 21]) expect(isQuietHour(h), `${h} 点`).toBe(false);
    expect(inQuietHours(at(2026, 11, 27, 23, 10))).toBe(true);
    expect(inQuietHours(at(2026, 11, 27, 8, 0))).toBe(false);
    expect(DUTY_QUIET_FROM_HOUR).toBe(22);
    expect(DUTY_QUIET_TO_HOUR).toBe(8);
  });

  it("每天 09:00:今天的点没过就是今天;过了(或正好)就是明天 —— 严格大于", () => {
    expect(nextDueAt(DAILY_9, at(2026, 11, 27, 8))).toBe(at(2026, 11, 27, 9));
    expect(nextDueAt(DAILY_9, at(2026, 11, 27, 9))).toBe(at(2026, 11, 28, 9));
    expect(nextDueAt(DAILY_9, at(2026, 11, 27, 21, 30))).toBe(at(2026, 11, 28, 9));
    expect(nextDueAt(DAILY_9, at(2026, 12, 31, 23, 59))).toBe(at(2027, 1, 1, 9));
  });

  it("每周:本周那一天还没过就是本周;过了就是下周;今天就是那一天时看时刻", () => {
    // 2026-11-27 是周五(getDay = 5)
    expect(new Date(at(2026, 11, 27, 12)).getDay()).toBe(5);
    const monday = { kind: "weekly" as const, at: "08:00", weekday: 1, hours: null };
    // 周五 12:00 → 下周一 08:00
    expect(nextDueAt(monday, at(2026, 11, 27, 12))).toBe(at(2026, 11, 30, 8));
    // 周一 07:00(还没到点)→ 当天
    expect(nextDueAt(monday, at(2026, 11, 30, 7))).toBe(at(2026, 11, 30, 8));
    // 周一 09:00(已过)→ 下周一
    expect(nextDueAt(monday, at(2026, 11, 30, 9))).toBe(at(2026, 12, 7, 8));
    // 周日(0)与周六(6)两个端点
    const sunday = { kind: "weekly" as const, at: "10:00", weekday: 0, hours: null };
    expect(nextDueAt(sunday, at(2026, 11, 27, 12))).toBe(at(2026, 11, 29, 10));
  });

  it("按小时:从起点加 N 小时;落进静默时段就顺延到紧接着的 08:00", () => {
    const every2 = { kind: "hourly" as const, at: null, weekday: null, hours: 2 };
    expect(nextDueAt(every2, at(2026, 11, 27, 10))).toBe(at(2026, 11, 27, 12));
    const every3 = { kind: "hourly" as const, at: null, weekday: null, hours: 3 };
    // 20:00 + 3h = 23:00(静默)→ 次日 08:00
    expect(nextDueAt(every3, at(2026, 11, 27, 20))).toBe(at(2026, 11, 28, 8));
    const every1 = { kind: "hourly" as const, at: null, weekday: null, hours: 1 };
    // 21:00 + 1h = 22:00(静默起点)→ 次日 08:00;07:00 + 1h = 08:00(不在静默里)
    expect(nextDueAt(every1, at(2026, 11, 27, 21))).toBe(at(2026, 11, 28, 8));
    expect(nextDueAt(every1, at(2026, 11, 27, 7))).toBe(at(2026, 11, 27, 8));
    // 午夜之后:23:00 + 2h = 01:00 → **当天** 08:00(不是次日)
    expect(nextDueAt(every2, at(2026, 11, 27, 23))).toBe(at(2026, 11, 28, 8));
  });

  it("不漂:每天 09:00 连排 10 轮,每个开工点都是当天 09:00(按排定点累加,不按收工时间)", () => {
    let t = at(2026, 11, 27, 8);
    for (let i = 0; i < 10; i++) {
      t = nextDueAt(DAILY_9, t);
      const d = new Date(t);
      expect([d.getHours(), d.getMinutes()], `第 ${i + 1} 轮`).toEqual([9, 0]);
    }
    // 第 1 轮就是 27 日 09:00 ⇒ 第 10 轮是 6 天后的 09:00
    expect(t).toBe(at(2026, 12, 6, 9));
  });

  it("每天 / 每周的节奏**不套**静默时段:甲方亲手填的 23:30 就是 23:30", () => {
    const late = { kind: "daily" as const, at: "23:30", weekday: null, hours: null };
    expect(nextDueAt(late, at(2026, 11, 27, 10))).toBe(at(2026, 11, 27, 23, 30));
  });

  it("missedSlots:排定点到现在之间错过了几轮(不含正在补做的这一轮)", () => {
    const now = at(2026, 11, 30, 10);
    expect(missedSlots(DAILY_9, at(2026, 11, 27, 9), now)).toBe(3);
    expect(missedSlots(DAILY_9, at(2026, 11, 30, 9), now)).toBe(0);
    const every1 = { kind: "hourly" as const, at: null, weekday: null, hours: 1 };
    // 凌晨 03:00 起每小时的排定点都落在静默时段里 ⇒ 顺延成 08:00,再 09:00、10:00 ⇒ 3 个
    expect(missedSlots(every1, at(2026, 11, 30, 3), now)).toBe(3);
    // 跨夜:20:00 到次日 09:00 —— 排定是 21:00、(22:00 顺延成)次日 08:00、09:00 ⇒ 3 个
    expect(missedSlots(every1, at(2026, 11, 29, 20), at(2026, 11, 30, 9))).toBe(3);
  });

  it("localDayStart / formatDuration / cadenceText", () => {
    expect(localDayStart(at(2026, 11, 27, 15, 42))).toBe(at(2026, 11, 27, 0));
    expect(formatDuration(30_000)).toBe("不到 1 分钟");
    expect(formatDuration(35 * MIN)).toBe("35 分钟");
    expect(formatDuration(130 * MIN)).toBe("2 小时 10 分钟");
    expect(formatDuration(24 * 60 * MIN)).toBe("1 天");
    expect(formatDuration(28 * 60 * MIN)).toBe("1 天 4 小时");
    expect(cadenceText(DAILY_9)).toBe("每天 09:00");
    expect(cadenceText({ kind: "weekly", at: "08:00", weekday: 1, hours: null })).toBe("每周一 08:00");
    expect(cadenceText({ kind: "hourly", at: null, weekday: null, hours: 2 })).toBe("每 2 小时(22:00–08:00 不开新工)");
  });
});

// ── ② 仓储 ──────────────────────────────────────────────────────

describe("职责 · 仓储", () => {
  it("职责行读写一致(节奏三格、产出形态、可空的排定)", () => {
    mkDuty({ formal: true, cadence: { kind: "hourly", at: null, weekday: null, hours: 6 } });
    const d = getDuty(db, "du_1")!;
    expect(d.cadence).toEqual({ kind: "hourly", at: null, weekday: null, hours: 6 });
    expect(d.formal).toBe(true);
    expect(d.boundaries).toBe("付费来源先问我");
    expect(dutyOfProject(db, "p_duty")?.id).toBe("du_1");
    expect(dutyOfProject(db, "p_other")).toBeNull();
  });

  it("updateDuty:`nextDueAt: null` 是有意的清空,不会被吞掉;没传的字段不动", () => {
    mkDuty();
    updateDuty(db, "du_1", { status: "paused", nextDueAt: null }, at(2026, 11, 27, 10));
    const d = getDuty(db, "du_1")!;
    expect(d.status).toBe("paused");
    expect(d.nextDueAt).toBeNull();
    expect(d.name).toBe("行业简报");
    expect(d.updatedAt).toBe(at(2026, 11, 27, 10));
  });

  it("listDuties:启用的在前,组内按创建先后", () => {
    mkDuty({ id: "du_old", projectId: "p_1", createdAt: 1, updatedAt: 1, status: "paused" });
    mkDuty({ id: "du_new", projectId: "p_2", createdAt: 3, updatedAt: 3 });
    mkDuty({ id: "du_mid", projectId: "p_3", createdAt: 2, updatedAt: 2 });
    expect(listDuties(db).map((d) => d.id)).toEqual(["du_mid", "du_new", "du_old"]);
  });

  it("闭集之外的值响亮报错(不猜成某个合法值)", () => {
    mkDuty();
    db.prepare(`UPDATE duties SET status = 'snoozing' WHERE id = 'du_1'`).run();
    expect(() => getDuty(db, "du_1")).toThrow(/未定义 status/);
    db.prepare(`UPDATE duties SET status = 'active', cadence_kind = 'sometimes' WHERE id = 'du_1'`).run();
    expect(() => getDuty(db, "du_1")).toThrow(/未定义 cadence_kind/);
  });

  it("一轮功课:开着的那一轮读得到;收工后读不到;最近一轮与计数", () => {
    mkDuty();
    mkRun({ id: "dr_1", startedAt: at(2026, 11, 27, 9, 1) });
    expect(openDutyRunOf(db, "du_1")?.id).toBe("dr_1");
    updateDutyRun(db, "dr_1", {
      status: "done", finishedAt: at(2026, 11, 27, 9, 40),
      steps: [{ title: "读三份来源", criterion: "每份有一句结论和链接", done: true, note: "三份都读到了" }],
      doneSummary: "三份来源都读到了", notDone: "无", cause: null, nextChange: "提前十分钟缓存",
      gaps: "只覆盖了三家公司", learned: "某站要带 referer",
    });
    expect(openDutyRunOf(db, "du_1")).toBeNull();
    const run = getDutyRun(db, "dr_1")!;
    expect(run.status).toBe("done");
    expect(run.steps[0]).toEqual({ title: "读三份来源", criterion: "每份有一句结论和链接", done: true, note: "三份都读到了" });
    expect(run.gaps).toBe("只覆盖了三家公司");
    expect(lastDutyRunOf(db, "du_1")?.id).toBe("dr_1");
    mkRun({ id: "dr_2", scheduledFor: at(2026, 11, 28, 9), startedAt: at(2026, 11, 28, 9, 2) });
    expect(lastDutyRunOf(db, "du_1")?.id).toBe("dr_2");
    expect(countDutyRunsStartedSince(db, at(2026, 11, 28, 0))).toBe(1);
    expect(countDutyRunsStartedSince(db, at(2026, 11, 27, 0))).toBe(2);
    // 起点正好落在开工那一刻的那一轮也算(「>=」不是「>」)
    expect(countDutyRunsStartedSince(db, at(2026, 11, 28, 9, 2))).toBe(1);
    expect(countDutyRunsStartedSince(db, at(2026, 11, 28, 9, 3))).toBe(0);
  });

  it("⚠️ `steps` 的 JSON 坏了要抛,不退成空数组(空数组会让收工校验空转通过)", () => {
    mkDuty();
    mkRun();
    db.prepare(`UPDATE duty_runs SET steps = '{not json' WHERE id = 'dr_1'`).run();
    expect(() => getDutyRun(db, "dr_1")).toThrow(/steps 不是合法 JSON/);
    db.prepare(`UPDATE duty_runs SET steps = '{"a":1}' WHERE id = 'dr_1'`).run();
    expect(() => getDutyRun(db, "dr_1")).toThrow(/steps 不是数组/);
  });
});

// ── ③ 接口 ──────────────────────────────────────────────────────

const NOW = at(2026, 11, 27, 10, 0);

function makeDeps(): HttpDeps {
  return {
    db,
    dataDir: "/tmp/duties-http-test",
    cwd: workRoot,
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    workspace: createGitWorkspace(),
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/duties-http-test", factoryDir: "/tmp/duties-http-factory" },
    settings: { read: () => ({}), write: async () => ({ ok: true as const, settings: {} }), providers: () => [] },
    ensureWorkspace: (projectId) => mkdirSync(projectWorkspaceRoot(workRoot, projectId), { recursive: true }),
  };
}

async function call(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await createPlatformApp(makeDeps()).request(path, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const NEW_DUTY = {
  name: "行业简报", goal: "每天一份三行简报", boundaries: "付费来源先问我",
  cadence: { kind: "daily", at: "11:00" },
};

describe("职责 · 接口", () => {
  it("建一条职责 = 建一个工作间项目(组织进项目、工作区建出来)+ 一条职责记录;第一轮排在之后的最近排定点", async () => {
    const res = await call("POST", "/api/duties", NEW_DUTY);
    expect(res.status).toBe(201);
    const duty = res.json["duty"] as DutyView;
    expect(duty.name).toBe("行业简报");
    expect(duty.goal).toBe("每天一份三行简报");
    expect(duty.boundaries).toBe("付费来源先问我");
    expect(duty.formal).toBe(false);
    expect(duty.status).toBe("active");
    expect(duty.projectStatus).toBe("active");
    expect(duty.nextDueAt).toBe(at(2026, 11, 27, 11));
    expect(duty.lastRun).toBeNull();
    expect(res.json["workspaceBootstrapped"]).toBe(true);
    // 工作间:项目在、五个角色都是成员、目录在盘上
    expect(getProjectRow(db, duty.projectId)?.status).toBe("active");
    expect(listAssignments(db, duty.projectId)).toHaveLength(5);
  });

  it("⚠️ 先校验后落库:名称 / 目标 / 节奏不合法 ⇒ 400,而且**一个项目都不建**", async () => {
    const before = listProjects(db).length;
    const bad = [
      { ...NEW_DUTY, name: "  " },
      { ...NEW_DUTY, goal: "" },
      { ...NEW_DUTY, cadence: { kind: "daily" } },
      { ...NEW_DUTY, cadence: { kind: "hourly", hours: 0 } },
      { ...NEW_DUTY, cadence: { kind: "sometimes" } },
    ];
    for (const b of bad) {
      const res = await call("POST", "/api/duties", b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((res.json["error"] as { code: string }).code).toBe("invalid_args");
    }
    expect(listProjects(db).length, "校验失败时不该留下空项目").toBe(before);
    expect(listDuties(db)).toEqual([]);
  });

  it("今天的点已经过了 ⇒ 第一轮是明天(不因为「建的时候过了点」就立刻开工)", async () => {
    const res = await call("POST", "/api/duties", { ...NEW_DUTY, cadence: { kind: "daily", at: "09:30" } });
    const duty = res.json["duty"] as DutyView;
    expect(duty.nextDueAt).toBe(at(2026, 11, 28, 9, 30));
  });

  it("「先建着、暂不启用」:职责与工作间项目一起停在暂停", async () => {
    const res = await call("POST", "/api/duties", { ...NEW_DUTY, startPaused: true });
    const duty = res.json["duty"] as DutyView;
    expect(duty.status).toBe("paused");
    expect(duty.projectStatus).toBe("paused");
    expect(duty.nextDueAt).toBeNull();
    expect(getProjectRow(db, duty.projectId)?.status).toBe("paused");
  });

  it("列表与项目摘要:职责项目带 `duty` 标记,普通项目不带;最近一轮带着功课与自省", async () => {
    const created = (await call("POST", "/api/duties", NEW_DUTY)).json["duty"] as DutyView;
    db.prepare(
      `INSERT INTO projects (id, name, client, goal, acceptance_criteria, status, created_at, closed_at, version, parent_project_id, close_consented_at)
       VALUES ('p_plain', '普通项目', '我', 'g', '[]', 'active', ?, NULL, 1, NULL, NULL)`,
    ).run(NOW);
    insertDutyRun(db, {
      id: "dr_x", dutyId: created.id, scheduledFor: NOW, startedAt: NOW, finishedAt: NOW + MIN,
      status: "done",
      steps: [{ title: "读三份来源", criterion: "每份一句结论", done: true, note: "都读到了" }],
      doneSummary: "三份都读到", notDone: "无", cause: null, nextChange: "提前缓存",
      gaps: "只覆盖三家公司", learned: "某站要 referer",
      failures: [{ kind: "review_fail", id: "wk_x", title: "简报" }],
    });
    const list = await call("GET", "/api/duties");
    expect(list.status).toBe(200);
    const duties = list.json["duties"] as DutyView[];
    expect(duties.map((d) => d.id)).toEqual([created.id]);
    expect(duties[0]!.lastRun).toMatchObject({
      id: "dr_x", status: "done", notDone: "无", nextChange: "提前缓存", gaps: "只覆盖三家公司",
      steps: [{ title: "读三份来源", criterion: "每份一句结论", done: true, note: "都读到了" }],
      failures: [{ kind: "review_fail", id: "wk_x", title: "简报" }],
    });

    const projects = await call("GET", "/api/projects");
    const rows = projects.json["projects"] as Array<{ id: string; duty?: { cadence: string; status: string; nextDueAt: number | null } }>;
    const dutyRow = rows.find((r) => r.id === created.projectId)!;
    const plainRow = rows.find((r) => r.id === "p_plain")!;
    expect(dutyRow.duty).toEqual({ cadence: "每天 11:00", status: "active", nextDueAt: at(2026, 11, 27, 11) });
    expect("duty" in plainRow).toBe(false);
  });

  it("改:改名 / 改边界 / 改节奏(节奏一改就从此刻重新排下一次)", async () => {
    const created = (await call("POST", "/api/duties", NEW_DUTY)).json["duty"] as DutyView;
    const res = await call("PUT", `/api/duties/${created.id}`, {
      name: "行业动向", boundaries: "", cadence: { kind: "weekly", at: "08:00", weekday: 1 },
    });
    expect(res.status).toBe(200);
    const duty = res.json["duty"] as DutyView;
    expect(duty.name).toBe("行业动向");
    expect(duty.boundaries).toBe("");
    // 2026-11-27 是周五 ⇒ 下一个周一 08:00
    expect(duty.nextDueAt).toBe(at(2026, 11, 30, 8));
  });

  it("改坏了 ⇒ 400,而且原来的一个字都没动", async () => {
    const created = (await call("POST", "/api/duties", NEW_DUTY)).json["duty"] as DutyView;
    for (const bad of [{ name: "" }, { goal: " " }, { cadence: { kind: "daily", at: "nope" } }, { status: "snooze" }, { formal: "yes" }]) {
      const res = await call("PUT", `/api/duties/${created.id}`, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(getDuty(db, created.id)!.name).toBe("行业简报");
  });

  it("暂停 ⇔ 工作间项目也暂停、排定清空;启用 ⇔ 项目回到进行中、从此刻重新排下一次", async () => {
    const created = (await call("POST", "/api/duties", NEW_DUTY)).json["duty"] as DutyView;
    const paused = await call("PUT", `/api/duties/${created.id}`, { status: "paused" });
    const p = paused.json["duty"] as DutyView;
    expect(p.status).toBe("paused");
    expect(p.nextDueAt).toBeNull();
    expect(getProjectRow(db, created.projectId)?.status).toBe("paused");

    const resumed = await call("PUT", `/api/duties/${created.id}`, { status: "active" });
    const r = resumed.json["duty"] as DutyView;
    expect(r.status).toBe("active");
    expect(r.projectStatus).toBe("active");
    expect(r.nextDueAt).toBe(at(2026, 11, 27, 11));
    expect(getProjectRow(db, created.projectId)?.status).toBe("active");
  });

  it("工作间项目已收口的职责不能再启用(409)—— 不是 400,是状态冲突", async () => {
    const created = (await call("POST", "/api/duties", { ...NEW_DUTY, startPaused: true })).json["duty"] as DutyView;
    closeProject(db, created.projectId, "abandoned", NOW);
    const res = await call("PUT", `/api/duties/${created.id}`, { status: "active" });
    expect(res.status).toBe(409);
    expect((res.json["error"] as { code: string }).code).toBe("conflict");
    expect(getDuty(db, created.id)!.status).toBe("paused");
  });

  it("「现在做一次」:把下一次排定改成此刻;三种状态冲突都拒收", async () => {
    const created = (await call("POST", "/api/duties", NEW_DUTY)).json["duty"] as DutyView;
    const res = await call("POST", `/api/duties/${created.id}/run-now`);
    expect(res.status).toBe(200);
    expect((res.json["duty"] as DutyView).nextDueAt).toBe(NOW);

    const second = (await call("POST", "/api/duties", { ...NEW_DUTY, name: "第二条" })).json["duty"] as DutyView;
    // ① 上一轮还没收工(同一职责同时只有一轮)
    insertDutyRun(db, {
      id: "dr_open", dutyId: second.id, scheduledFor: NOW, startedAt: NOW, finishedAt: null,
      status: "open", steps: [], doneSummary: null, notDone: null, cause: null, nextChange: null,
      gaps: null, learned: null, failures: [],
    });
    const open = await call("POST", `/api/duties/${second.id}/run-now`);
    expect(open.status).toBe(409);
    expect((open.json["error"] as { message: string }).message).toContain("还没收工");

    // ② 已暂停(职责与工作间项目一起停)
    await call("PUT", `/api/duties/${second.id}`, { status: "paused" });
    const paused = await call("POST", `/api/duties/${second.id}/run-now`);
    expect(paused.status).toBe(409);
    expect((paused.json["error"] as { message: string }).message).toContain("已暂停");

    // ③ 职责是启用的,但工作间项目不在进行中(比如被业务经理用 project_update 暂停了)
    db.prepare(`UPDATE duties SET status = 'active', next_due_at = ? WHERE id = ?`).run(NOW, second.id);
    const projectPaused = await call("POST", `/api/duties/${second.id}/run-now`);
    expect(projectPaused.status).toBe(409);
    expect((projectPaused.json["error"] as { message: string }).message).toContain("不在进行中");
  });

  it("不存在的职责:404", async () => {
    expect((await call("PUT", "/api/duties/du_nope", { name: "x" })).status).toBe(404);
    expect((await call("POST", "/api/duties/du_nope/run-now")).status).toBe(404);
  });
});
