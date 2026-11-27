/**
 * 职责的功课工具(039,2026-11-27)· 回归 —— `duty_run_open` / `duty_run_close`
 *
 * ── 这一文件守的是四条硬要求 ───────────────────────────────────
 *
 *   ① **开工先列功课**:写不出 1–3 步、每步一条可检验的标准,就还没想清这一轮做什么
 *      —— 工具拒收,**一行都不写**。
 *   ② **同一职责同时只有一轮**:上一轮没收工不开新的一轮;已暂停的职责不开工;
 *      今天开满了不开工。
 *   ③ **不写完不算收工**:每一步功课都要交代,自省五项都不许空。
 *   ④ **有失败必须写自己的原因**:这一轮里平台查到失败(工作项失败 / 质检不通过 /
 *      甲方拒收)时,`cause` 为空就拒收 —— 而失败清单由**平台查**,不靠模型自觉想起来。
 *
 * 规则那一侧(什么时候叫醒)在 `duty-rule.test.ts`;宿主级在 `duty-host.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { loadProjectForAuthz, updateProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertDispatchEvent } from "../../src/platform/storage/repo/dispatch.js";
import { insertReviewVerdict } from "../../src/platform/storage/repo/reviewVerdicts.js";
import { insertDeliveryVerdict } from "../../src/platform/storage/repo/deliveryVerdicts.js";
import {
  dutyOfProject, failuresSince, getDuty, getDutyRun, insertDuty, insertDutyRun,
  openDutyRunOf, type DutyRow, type DutyRunRow,
} from "../../src/platform/storage/repo/duties.js";
import { DUTY_DAILY_START_CAP, DUTY_MAX_STEPS } from "../../src/platform/runtime/duty.js";
import { ROLE_SPECS, PROJECT_ROLES } from "../../src/platform/identity/role.js";
import { solveToolset } from "../../src/platform/harness/authorize.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";

/** 本地时刻构造(测试对时区不敏感)。 */
function at(y: number, month: number, day: number, h: number, m = 0): number {
  return new Date(y, month - 1, day, h, m, 0, 0).getTime();
}

const MIN = 60_000;
/** 2026-11-27 09:01 —— 每天 09:00 的职责,开工晚了一分钟。 */
const T0 = at(2026, 11, 27, 9, 1);
const SLOT = at(2026, 11, 27, 9);

let db: Database.Database;
let workRoot = "";
let seq = 0;

beforeEach(() => {
  db = openPlatformMemoryDb();
  workRoot = mkdtempSync(join(tmpdir(), "ss-duty-runs-"));
  seq = 0;
  insertProject(db, {
    id: "p1", name: "行业简报", client: "职责", goal: "每天一份三行简报", status: "active", createdAt: T0 - 7 * 24 * 60 * MIN,
  });
  ensureProjectOrg(db, "p1", T0 - 7 * 24 * 60 * MIN);
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

function mkDuty(over: Partial<DutyRow> = {}): DutyRow {
  const row: DutyRow = {
    id: "du_1", projectId: "p1", name: "行业简报", goal: "每天一份三行简报",
    boundaries: "", cadence: { kind: "daily", at: "09:00", weekday: null, hours: null },
    formal: false, status: "active", nextDueAt: SLOT, lastRunAt: null,
    createdAt: T0 - MIN, updatedAt: T0 - MIN,
    ...over,
  };
  insertDuty(db, row);
  return row;
}

function mkRun(over: Partial<DutyRunRow> = {}): DutyRunRow {
  const row: DutyRunRow = {
    id: "dr_open", dutyId: "du_1", scheduledFor: SLOT, startedAt: T0, finishedAt: null,
    status: "open",
    steps: [
      { title: "读三份来源", criterion: "每份一句结论 + 链接", done: null, note: null },
      { title: "写成三行", criterion: "不超过 200 字,每行一个结论", done: null, note: null },
    ],
    doneSummary: null, notDone: null, cause: null, nextChange: null, gaps: null, learned: null,
    failures: [],
    ...over,
  };
  insertDutyRun(db, row);
  return row;
}

let clock = T0;
function ctx(agentId: string, now = clock): ToolRunContext {
  const agent = getAgent(db, agentId);
  if (agent === null) throw new Error(`夹具里没有 agent ${agentId}`);
  return {
    db, agent, project: loadProjectForAuthz(db, "p1")!,
    now: () => now, newId: (p) => `${p}_${++seq}`,
    workspace: createGitWorkspace(), workspaceRoot: workRoot,
  };
}
function call(tool: string, args: Record<string, unknown>, agentId = "bm", now = clock): ToolResult {
  const r = dispatch(tool, args, ctx(agentId, now));
  if (r instanceof Promise) throw new Error("sync only");
  return r;
}
const PLAN = [
  { title: "读三份来源", criterion: "每份一句结论 + 链接" },
  { title: "写成三行", criterion: "不超过 200 字" },
];
const ACCOUNTING = [{ done: true, note: "都读到了" }, { done: false, note: "有一份打不开" }];
const REVIEW = {
  done: "三份来源各一句结论", notDone: "第三份打不开,没写进简报",
  nextChange: "提前十分钟缓存来源", gaps: "只覆盖了三家公司", learned: "某站要带 referer 才能打开",
};

/** 一条做完了的工作项(失败记录的标题从它身上取)。 */
function mkWork(id: string, title = "失败的活"): void {
  insertWork(db, {
    id, projectId: "p1", parentWorkId: null, title,
    goal: "g", status: "done", confirmedAt: 1, assigneeAgentId: "wk", createdAt: T0 - MIN, updatedAt: T0,
  });
}

/** 一份已定稿的交付物(拒收记录的标题从它身上取);正文按 027 的规矩真写一份文件。 */
function mkDeliverable(id: string, title: string, createdAt: number): void {
  const path = join(workRoot, "artifacts", `${id}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "交付物正文");
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null, kind: "deliverable", status: "accepted",
    authorAgentId: "wk", title, ...bodyAt(`artifacts/${id}.md`, "交付物正文"),
    metadataJson: null, createdAt, updatedAt: createdAt, workId: null,
  });
}

function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

// ── 开工 ────────────────────────────────────────────────────────

describe("duty_run_open · 开工先列功课", () => {
  it("正样本:写下功课(还没交代)、记下服务的排定点;下一次从此刻之后的排定点起算", () => {
    mkDuty();
    const r = call("duty_run_open", { steps: PLAN });
    expect(r.ok, r.ok ? "" : r.message).toBe(true);
    const run = openDutyRunOf(db, "du_1")!;
    expect(run.status).toBe("open");
    expect(run.scheduledFor).toBe(SLOT);
    expect(run.startedAt).toBe(T0);
    expect(run.steps).toEqual([
      { title: "读三份来源", criterion: "每份一句结论 + 链接", done: null, note: null },
      { title: "写成三行", criterion: "不超过 200 字", done: null, note: null },
    ]);
    const duty = getDuty(db, "du_1")!;
    expect(duty.lastRunAt).toBe(T0);
    // 按排定点累加:下一个是明天 09:00,不是「现在 + 24 小时」(那会漂)
    expect(duty.nextDueAt).toBe(at(2026, 11, 28, 9));
    expect(r.text).toContain("先不收工");
  });

  it("补做:进程当时不在 —— 服务的还是那个排定点,错过几轮如实可数,下一次排到未来", () => {
    // 排定在 24 日 09:00,现在是 27 日 09:01:25 / 26 / 27 三个排定点都过去了
    mkDuty({ nextDueAt: at(2026, 11, 24, 9) });
    const r = call("duty_run_open", { steps: PLAN });
    expect(r.ok).toBe(true);
    const run = openDutyRunOf(db, "du_1")!;
    expect(run.scheduledFor).toBe(at(2026, 11, 24, 9));
    expect(run.startedAt).toBe(T0);
    expect(r.text).toContain("错过 3 轮");
    // ⚠️ 只往后推一格(25 日)是不够的 —— 它也已经过去了
    expect(getDuty(db, "du_1")!.nextDueAt).toBe(at(2026, 11, 28, 9));
  });

  it("排定点正好是「现在」:它算已经过去的一轮,下一次必须排到**未来**(否则刚开工就又到点了)", () => {
    mkDuty({ nextDueAt: at(2026, 11, 24, 9) });
    // 现在 = 25 日 09:00 整:24 日那一轮在补做,25 日这一轮已经「到了此刻」
    const r = call("duty_run_open", { steps: PLAN }, "bm", at(2026, 11, 25, 9));
    expect(r.ok).toBe(true);
    expect((r.data as { missed: number }).missed).toBe(1);
    expect(getDuty(db, "du_1")!.nextDueAt).toBe(at(2026, 11, 26, 9));
  });

  it("工作间项目不在进行中(被暂停)⇒ 工具自己拦:调用期的授权门不重判项目状态,旧会话里它仍调得动", () => {
    mkDuty();
    mkRun();
    updateProject(db, "p1", { status: "paused" });
    const open = call("duty_run_open", { steps: PLAN });
    expect(open.ok).toBe(false);
    expect(open.code).toBe("conflict");
    expect(open.message).toContain("不在进行中");
    const close = call("duty_run_close", { ...REVIEW, steps: ACCOUNTING });
    expect(close.ok).toBe(false);
    expect(close.message).toContain("不在进行中");
    expect(openDutyRunOf(db, "du_1")?.id, "开着的那一轮原样留着").toBe("dr_open");
  });

  it("普通项目里拒收:这个工具只在职责的那一轮里用", () => {
    insertProject(db, { id: "p2", name: "普通项目", client: "我", goal: "g", status: "active", createdAt: T0 });
    ensureProjectOrg(db, "p2", T0);
    const agent = getAgent(db, "bm")!;
    const r = dispatch("duty_run_open", { steps: PLAN }, {
      db, agent, project: loadProjectForAuthz(db, "p2")!, now: () => T0, newId: (p) => `${p}_${++seq}`,
      workspace: createGitWorkspace(), workspaceRoot: workRoot,
    }) as ToolResult;
    expect(r.ok).toBe(false);
    expect(r.code).toBe("not_found");
  });

  it("已暂停的职责不开工", () => {
    mkDuty({ status: "paused", nextDueAt: null });
    const r = call("duty_run_open", { steps: PLAN });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("conflict");
    expect(r.message).toContain("已暂停");
    expect(openDutyRunOf(db, "du_1")).toBeNull();
  });

  it("⚠️ 同一职责同时只有一轮:上一轮没收工就拒收", () => {
    mkDuty();
    mkRun();
    const r = call("duty_run_open", { steps: PLAN });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("conflict");
    expect(r.message).toContain("还没收工");
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM duty_runs`).get() as { n: number }).n;
    expect(n, "拒收时不该多出一轮").toBe(1);
  });

  it("功课的形状:不是数组 / 一步没有 / 超过上限 / 标准为空 —— 都拒收,而且一行不写", () => {
    mkDuty();
    const bad: Array<[unknown, RegExp]> = [
      ["not an array", /steps 必须是数组/],
      [[], /至少一步/],
      [Array.from({ length: DUTY_MAX_STEPS + 1 }, (_, i) => ({ title: `第${i + 1}步`, criterion: "c" })), new RegExp(`一轮最多 ${DUTY_MAX_STEPS} 步`)],
      [[{ title: "读来源", criterion: "  " }], /可检验标准都不能为空/],
      [[{ title: "", criterion: "c" }], /都不能为空/],
      [[{ title: "读来源" }], /都不能为空/],
    ];
    for (const [steps, re] of bad) {
      const r = call("duty_run_open", { steps });
      expect(r.ok, JSON.stringify(steps)).toBe(false);
      expect(r.code).toBe("invalid_args");
      expect(r.message).toMatch(re);
    }
    expect(openDutyRunOf(db, "du_1")).toBeNull();
    expect(getDuty(db, "du_1")!.nextDueAt, "拒收时排定不动").toBe(SLOT);
  });

  it("今天全系统开满了就不开(规则拦一层,工具是第二道 —— 同一个判据)", () => {
    mkDuty();
    for (let i = 0; i < DUTY_DAILY_START_CAP; i++) {
      mkRun({ id: `dr_old_${i}`, startedAt: T0 - (i + 1) * MIN, scheduledFor: T0 - (i + 1) * MIN, status: "done", finishedAt: T0 });
    }
    const r = call("duty_run_open", { steps: PLAN });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("conflict");
    expect(r.message).toContain(`${DUTY_DAILY_START_CAP} 轮`);
    // 昨天开的不算今天:同样的十二轮发生在昨天 ⇒ 照常开工
    const r2 = call("duty_run_open", { steps: PLAN }, "bm", T0 + 24 * 60 * MIN);
    expect(r2.ok).toBe(true);
  });

  it("授权:只有业务经理持 `duty.run`;别的角色调它被授权门挡下", () => {
    mkDuty();
    const holders = PROJECT_ROLES.filter((role) => ROLE_SPECS[role].ceiling.includes("duty.run"));
    expect(holders).toEqual(["business_manager"]);
    const r = call("duty_run_open", { steps: PLAN }, "pm");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("denied");
    expect(openDutyRunOf(db, "du_1")).toBeNull();
  });

  it("工作间项目不在进行中时,新建的会话拿不到这两个工具(`duty.` 是项目内能力);进行中拿得到", () => {
    mkDuty();
    const bm = getAgent(db, "bm")!;
    const active = solveToolset(bm, loadProjectForAuthz(db, "p1"));
    expect(active.tools).toEqual(expect.arrayContaining(["duty_run_open", "duty_run_close"]));
    updateProject(db, "p1", { status: "paused" });
    const paused = solveToolset(bm, loadProjectForAuthz(db, "p1"));
    expect(paused.tools).not.toContain("duty_run_open");
    expect(paused.tools).not.toContain("duty_run_close");
    expect(paused.blockedByScope.map((d) => d.subject)).toContain("duty.run");
  });
});

// ── 收工 ────────────────────────────────────────────────────────

describe("duty_run_close · 不写完不算收工", () => {
  it("正样本:逐步交代 + 自省五项落库;这一轮收口为终态", () => {
    mkDuty();
    mkRun();
    const r = call("duty_run_close", { ...REVIEW, steps: ACCOUNTING });
    expect(r.ok, r.ok ? "" : r.message).toBe(true);
    const run = getDutyRun(db, "dr_open")!;
    expect(run.status).toBe("done");
    expect(run.finishedAt).toBe(T0);
    expect(run.steps).toEqual([
      { title: "读三份来源", criterion: "每份一句结论 + 链接", done: true, note: "都读到了" },
      { title: "写成三行", criterion: "不超过 200 字,每行一个结论", done: false, note: "有一份打不开" },
    ]);
    expect(run.doneSummary).toBe(REVIEW.done);
    expect(run.notDone).toBe(REVIEW.notDone);
    expect(run.nextChange).toBe(REVIEW.nextChange);
    expect(run.gaps).toBe(REVIEW.gaps);
    expect(run.learned).toBe(REVIEW.learned);
    expect(run.cause, "没有失败时原因为空是合法的").toBeNull();
    expect(run.failures).toEqual([]);
    expect(openDutyRunOf(db, "du_1")).toBeNull();
    expect(r.text).toContain("1/2 步做成");
  });

  it("没有未收工的一轮 → 拒收(不是静默成功)", () => {
    mkDuty();
    const r = call("duty_run_close", { ...REVIEW, steps: ACCOUNTING });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("conflict");
  });

  it("自省五项任何一项为空都拒收 —— 「没有」要写成「无」,空着是没想", () => {
    mkDuty();
    mkRun();
    for (const key of ["done", "notDone", "nextChange", "gaps", "learned"]) {
      for (const empty of ["", "   ", undefined]) {
        const args: Record<string, unknown> = { ...REVIEW, steps: ACCOUNTING };
        if (empty === undefined) delete args[key];
        else args[key] = empty;
        const r = call("duty_run_close", args);
        expect(r.ok, `${key} = ${JSON.stringify(empty)}`).toBe(false);
        expect(r.code).toBe("invalid_args");
        expect(r.message).toContain(key);
      }
    }
    expect(openDutyRunOf(db, "du_1")?.id, "拒收时这一轮仍然开着").toBe("dr_open");
  });

  it("每一步功课都要交代:条数不符 / 缺 done → 拒收", () => {
    mkDuty();
    mkRun();
    const short = call("duty_run_close", { ...REVIEW, steps: [ACCOUNTING[0]] });
    expect(short.ok).toBe(false);
    expect(short.message).toContain("开工时列了 2 步");
    const noFlag = call("duty_run_close", { ...REVIEW, steps: [{ note: "没标" }, ACCOUNTING[1]] });
    expect(noFlag.ok).toBe(false);
    expect(noFlag.message).toContain("缺 done");
  });

  it("⚠️ 这一轮有失败而没写自己的原因 → 拒收,并把失败清单摆出来(清单由平台查)", () => {
    mkDuty();
    mkRun();
    mkWork("wk_fail");
    mkWork("wk_review", "被判不通过的活");
    insertDispatchEvent(db, { projectId: "p1", kind: "work_failed", subjectId: "wk_fail", summary: "s", createdAt: T0 + 1 });
    insertReviewVerdict(db, {
      workId: "wk_review", projectId: "p1", verdict: "fail", severity: "medium",
      findingArtifactId: null, note: "结论没有出处", reviewedBy: "qa", createdAt: T0 + 2,
    });

    const noCause = call("duty_run_close", { ...REVIEW, steps: ACCOUNTING });
    expect(noCause.ok).toBe(false);
    expect(noCause.code).toBe("invalid_args");
    expect(noCause.message).toContain("2 件事没成");
    expect(noCause.message).toContain("[work_failed] wk_fail「失败的活」");
    expect(noCause.message).toContain("[review_fail] wk_review「被判不通过的活」");
    expect(openDutyRunOf(db, "du_1")?.id, "拒收时这一轮仍然开着").toBe("dr_open");

    // 把 cause 写成空白也一样(「  」不是原因)
    const blank = call("duty_run_close", { ...REVIEW, cause: "   ", steps: ACCOUNTING });
    expect(blank.ok).toBe(false);

    const withCause = call("duty_run_close", {
      ...REVIEW, cause: "目标没写清:没说结论要有出处", steps: ACCOUNTING,
    });
    expect(withCause.ok, withCause.ok ? "" : withCause.message).toBe(true);
    const run = getDutyRun(db, "dr_open")!;
    expect(run.cause).toBe("目标没写清:没说结论要有出处");
    expect(run.failures).toEqual([
      { kind: "work_failed", id: "wk_fail", title: "失败的活" },
      { kind: "review_fail", id: "wk_review", title: "被判不通过的活" },
    ]);
  });

  it("甲方拒收也算失败;而这一轮开工**之前**的失败不算在这一轮头上", () => {
    mkDuty();
    mkRun();
    mkWork("wk_old");
    insertDispatchEvent(db, { projectId: "p1", kind: "work_failed", subjectId: "wk_old", summary: "s", createdAt: T0 - 1 });
    // 这一条在开工之前 ⇒ 不要求写原因
    expect(call("duty_run_close", { ...REVIEW, steps: ACCOUNTING }).ok).toBe(true);

    mkRun({ id: "dr_2", scheduledFor: at(2026, 11, 28, 9), startedAt: at(2026, 11, 28, 9, 1) });
    mkDeliverable("art_rej", "第一版简报", T0 + MIN);
    insertDeliveryVerdict(db, {
      projectId: "p1", artifactId: "art_rej", verdict: "reject", note: "太长", createdAt: at(2026, 11, 28, 9, 5),
    });
    const noCause = call("duty_run_close", { ...REVIEW, steps: ACCOUNTING }, "bm", at(2026, 11, 28, 9, 30));
    expect(noCause.ok).toBe(false);
    expect(noCause.message).toContain("[rejected] art_rej「第一版简报」");
  });

  it("收工是终态:再收一次拒收,记录一个字不变", () => {
    mkDuty();
    mkRun();
    expect(call("duty_run_close", { ...REVIEW, steps: ACCOUNTING }).ok).toBe(true);
    const again = call("duty_run_close", { ...REVIEW, done: "改口:其实都做成了", steps: [{ done: true }, { done: true }] }, "bm", T0 + MIN);
    expect(again.ok).toBe(false);
    expect(again.code).toBe("conflict");
    const run = getDutyRun(db, "dr_open")!;
    expect(run.doneSummary).toBe(REVIEW.done);
    expect(run.steps[1]!.done).toBe(false);
  });
});

// ── 失败清单(平台查,不靠模型想起来)──────────────────────────────

describe("failuresSince · 平台查得到的失败", () => {
  it("只看这个时刻之后、只看这个项目;三种来源各记一条,标题取自工作项 / 工件", () => {
    insertProject(db, { id: "p2", name: "别的项目", client: "我", goal: "g", status: "active", createdAt: T0 });
    ensureProjectOrg(db, "p2", T0);
    insertWork(db, {
      id: "wk_fail", projectId: "p1", parentWorkId: null, title: "失败的活",
      goal: "g", status: "failed", confirmedAt: 1, assigneeAgentId: "wk", createdAt: T0 - MIN, updatedAt: T0,
    });
    insertWork(db, {
      id: "wk_other", projectId: "p2", parentWorkId: null, title: "别的项目的活",
      goal: "g", status: "failed", confirmedAt: 1, assigneeAgentId: "wk", createdAt: T0 - MIN, updatedAt: T0,
    });
    insertDispatchEvent(db, { projectId: "p1", kind: "work_failed", subjectId: "wk_fail", summary: "s", createdAt: T0 - 2 });
    insertDispatchEvent(db, { projectId: "p1", kind: "work_failed", subjectId: "wk_fail", summary: "s", createdAt: T0 + 1 });
    insertDispatchEvent(db, { projectId: "p1", kind: "work_blocked", subjectId: "wk_fail", summary: "s", createdAt: T0 + 3 });
    insertDispatchEvent(db, { projectId: "p1", kind: "work_done", subjectId: "wk_fail", summary: "s", createdAt: T0 + 4 });
    insertDispatchEvent(db, { projectId: "p2", kind: "work_failed", subjectId: "wk_other", summary: "s", createdAt: T0 + 5 });

    const got = failuresSince(db, "p1", T0);
    expect(got).toEqual([
      { kind: "work_failed", id: "wk_fail", title: "失败的活" },
      { kind: "work_blocked", id: "wk_fail", title: "失败的活" },
    ]);
    // 通过的裁决不是失败:质检 pass、甲方 accept 都不进清单
    mkWork("wk_pass", "通过的活");
    insertReviewVerdict(db, {
      workId: "wk_pass", projectId: "p1", verdict: "pass", severity: "low",
      findingArtifactId: null, note: "", reviewedBy: "qa", createdAt: T0 + 6,
    });
    mkDeliverable("art_ok", "收下的简报", T0 + 6);
    insertDeliveryVerdict(db, { projectId: "p1", artifactId: "art_ok", verdict: "accept", note: "", createdAt: T0 + 7 });
    expect(failuresSince(db, "p1", T0 + 10)).toEqual([]);
    expect(failuresSince(db, "p1", T0).map((f) => f.kind)).toEqual(["work_failed", "work_blocked"]);
  });
});
