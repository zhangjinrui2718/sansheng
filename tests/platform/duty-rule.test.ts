/**
 * 职责到点(039,2026-11-27)· 规则 `duty_due` 与它在职责项目里的口径 —— 回归
 *
 * ── 这一文件守什么 ───────────────────────────────────────────────
 *
 *   ① **什么时候开工**:到点、职责启用、工作间进行中、没有未收工的一轮、没有等甲方
 *      答的问题、今天没开满;正式交付的职责在「货交了等你验收」时不开新工。
 *   ② **什么时候收工**:有未收工的一轮,并且工作间安静了(活落定了),或者已经拖到了
 *      下一个排定点(「既过不恋」)。
 *   ③ **职责项目里别的规则改口径**:工作项建出来就已确认(甲方设职责 = 预先授权);
 *      空项目不由项目经理自己起头拆;例行产出的职责不整合、不交付、不判收口。
 *   ④ **到顶有兜底**:不换手给项目经理(他手里没有职责的工具);宿主的熔断扫描
 *      暂停职责 / 收掉这一轮,并且收掉之后开工那一面拿到**全新**的预算。
 *
 * 判定只有一处(`dueDutyPhase`,纯函数)—— 这里既直接测它,也经 `collectTodos` 测接线。
 * 工具那一侧在 `duty-runs.test.ts`;宿主级在 `duty-host.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject, loadProjectForAuthz, updateProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import { insertWork, markWorkReviewed, type WorkRow } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertDeliveryVerdict } from "../../src/platform/storage/repo/deliveryVerdicts.js";
import { openDeliverableSession } from "../../src/platform/storage/repo/sessions.js";
import { bumpAttempt, markAttemptNotified, listAttempts } from "../../src/platform/storage/repo/dispatch.js";
import { insertAsk } from "../../src/platform/storage/repo/asks.js";
import {
  getDuty, getDutyRun, insertDuty, insertDutyRun, openDutyRunOf, settleExhaustedDuty, updateDuty,
  type DutyRow, type DutyRunRow,
} from "../../src/platform/storage/repo/duties.js";
import { DUTY_DAILY_START_CAP, dueDutyPhase, type DutyDueInput } from "../../src/platform/runtime/duty.js";
import { collectPendingWork, hasActionableWork, renderPendingWork } from "../../src/platform/runtime/pendingWork.js";
import {
  collectTodos, drainProject, renderTask, type DriverTodo, type TodoBoard,
} from "../../src/platform/runtime/dispatcher.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";

function at(y: number, month: number, day: number, h: number, m = 0): number {
  return new Date(y, month - 1, day, h, m, 0, 0).getTime();
}
const MIN = 60_000;
/** 2026-11-27 09:01 —— 每天 09:00 的职责刚到点。 */
const NOW = at(2026, 11, 27, 9, 1);
const SLOT = at(2026, 11, 27, 9);
const T = SLOT - 7 * 24 * 60 * MIN;

let db: Database.Database;
let workRoot = "";
let seq = 0;

beforeEach(() => {
  db = openPlatformMemoryDb();
  workRoot = mkdtempSync(join(tmpdir(), "ss-duty-rule-"));
  seq = 0;
  mkProject("p1");
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

function mkProject(id: string): void {
  insertProject(db, { id, name: `项目 ${id}`, client: "职责", goal: "每天一份三行简报", status: "active", createdAt: T });
  ensureProjectOrg(db, id, T);
}

function mkDuty(over: Partial<DutyRow> = {}): DutyRow {
  const row: DutyRow = {
    id: "du_1", projectId: "p1", name: "行业简报", goal: "每天一份三行简报",
    boundaries: "付费来源先问我", cadence: { kind: "daily", at: "09:00", weekday: null, hours: null },
    formal: false, status: "active", nextDueAt: SLOT, lastRunAt: null,
    createdAt: T, updatedAt: T,
    ...over,
  };
  insertDuty(db, row);
  return row;
}

function mkWork(id: string, over: Partial<WorkRow> = {}): WorkRow {
  const row: WorkRow = {
    id, projectId: "p1", parentWorkId: null, title: `活 ${id}`, goal: "g",
    status: "open", reviewState: "none", confirmedAt: 1, priority: 3, acceptanceCriteria: [],
    assigneeAgentId: "wk", createdAt: NOW - 5 * MIN, updatedAt: NOW - 5 * MIN,
    ...over,
  };
  insertWork(db, { confirmedAt: row.confirmedAt, id, projectId: row.projectId, parentWorkId: row.parentWorkId,
    title: row.title, goal: row.goal, status: row.status, assigneeAgentId: row.assigneeAgentId,
    createdAt: row.createdAt, updatedAt: row.updatedAt });
  // `insertWork` 不收质检状态(它有自己的一套缺省:建出来就是 done 的会被当成待审);
  // 夹具要的「已经审过」得在插入之后明确写进去。
  if (row.reviewState !== "none") {
    db.prepare(`UPDATE works SET review_state = ? WHERE id = ?`).run(row.reviewState, id);
  }
  return row;
}

function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

function mkArtifact(id: string, kind: "deliverable" | "client_question", over: Partial<Parameters<typeof insertArtifact>[1]> = {}): void {
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null, kind, status: kind === "deliverable" ? "accepted" : "open",
    authorAgentId: kind === "deliverable" ? "wk" : "bm", title: id,
    ...bodyAt(`artifacts/${id}.md`, "正文"), metadataJson: null,
    createdAt: NOW - 4 * MIN, updatedAt: NOW - 4 * MIN, workId: null,
    ...over,
  });
}

function mkRun(over: Partial<DutyRunRow> = {}): DutyRunRow {
  const row: DutyRunRow = {
    id: "dr_1", dutyId: "du_1", scheduledFor: SLOT, startedAt: NOW - MIN, finishedAt: null,
    status: "open",
    steps: [{ title: "读三份来源", criterion: "每份一句结论", done: null, note: null }],
    doneSummary: null, notDone: null, cause: null, nextChange: null, gaps: null, learned: null,
    failures: [],
    ...over,
  };
  insertDutyRun(db, row);
  return row;
}

function board(projectId = "p1", now = NOW): TodoBoard {
  return collectTodos({ db, projectId, now });
}
/** 这个项目此刻的待办,写成 `kind` / `duty_due:…:open` 这样可读的标签。 */
function labels(projectId = "p1", now = NOW): string[] {
  const b = board(projectId, now);
  const tag = (t: DriverTodo): string =>
    t.kind === "duty_due" ? `duty_due:${t.key.includes(":open@") ? "open" : "close"}` : t.kind;
  return [...b.runnable.map(tag), ...b.exhausted.map((t) => `×${tag(t)}`)];
}
function dutyTodo(now = NOW): DriverTodo | undefined {
  return board("p1", now).runnable.find((t) => t.kind === "duty_due");
}

const BASE: DutyDueInput = {
  duty: { status: "active", formal: false, nextDueAt: SLOT },
  openRunStartedAt: null,
  now: NOW,
  projectStatus: "active",
  awaitingClient: false,
  acceptancePending: false,
  nonTerminalWorkCount: 0,
  pendingReviewCount: 0,
  openAskCount: 0,
  startCapReached: false,
};

// ── ① 判据本体(纯函数)───────────────────────────────────────────

describe("dueDutyPhase · 什么时候开工", () => {
  it("到点、一切就绪 ⇒ 开工", () => {
    expect(dueDutyPhase(BASE)).toBe("open");
  });

  it("还没到点 / 职责已暂停 / 工作间不在进行中 / 没排定 ⇒ 都不开工", () => {
    expect(dueDutyPhase({ ...BASE, duty: { ...BASE.duty!, nextDueAt: NOW + MIN } })).toBeNull();
    expect(dueDutyPhase({ ...BASE, duty: { ...BASE.duty!, status: "paused" } })).toBeNull();
    expect(dueDutyPhase({ ...BASE, duty: { ...BASE.duty!, nextDueAt: null } })).toBeNull();
    for (const status of ["paused", "done", "abandoned", "draft"]) {
      expect(dueDutyPhase({ ...BASE, projectStatus: status }), status).toBeNull();
    }
    expect(dueDutyPhase({ ...BASE, duty: null })).toBeNull();
  });

  it("排定点正好是现在也算到点(<=)", () => {
    expect(dueDutyPhase({ ...BASE, duty: { ...BASE.duty!, nextDueAt: NOW } })).toBe("open");
  });

  it("有问题在等甲方答 ⇒ 不开工(不叠轮次)", () => {
    expect(dueDutyPhase({ ...BASE, awaitingClient: true })).toBeNull();
  });

  it("今天开满了 ⇒ 不开工", () => {
    expect(dueDutyPhase({ ...BASE, startCapReached: true })).toBeNull();
  });

  it("正式交付的职责:货交了等甲方验收 ⇒ 不开新工;例行产出的不受这一条影响", () => {
    expect(dueDutyPhase({ ...BASE, duty: { ...BASE.duty!, formal: true }, acceptancePending: true })).toBeNull();
    expect(dueDutyPhase({ ...BASE, duty: { ...BASE.duty!, formal: false }, acceptancePending: true })).toBe("open");
  });
});

describe("dueDutyPhase · 什么时候收工", () => {
  const open = { ...BASE, openRunStartedAt: NOW - MIN, duty: { ...BASE.duty!, nextDueAt: NOW + 24 * 60 * MIN } };

  it("工作间安静了(没有未完成的活、没有待审、没有未答的提问)⇒ 收工", () => {
    expect(dueDutyPhase(open)).toBe("close");
  });

  it("安静的三件事缺一件都不收:还有活没做完 / 还有产出等着审 / 还有提问没答", () => {
    expect(dueDutyPhase({ ...open, nonTerminalWorkCount: 1 })).toBeNull();
    expect(dueDutyPhase({ ...open, pendingReviewCount: 1 })).toBeNull();
    expect(dueDutyPhase({ ...open, openAskCount: 1 })).toBeNull();
  });

  it("拖到了下一个排定点 ⇒ 即使活还没落定也收(既过不恋:不把旧的拖进新一轮)", () => {
    expect(dueDutyPhase({ ...open, nonTerminalWorkCount: 2, duty: { ...open.duty!, nextDueAt: NOW } })).toBe("close");
  });

  it("有问题在等甲方答时不收 —— 答复落进这一轮之后再收", () => {
    expect(dueDutyPhase({ ...open, awaitingClient: true })).toBeNull();
    // 即使已经拖到了下一个排定点:球在甲方那边,收了就把他的答复关在门外了
    expect(dueDutyPhase({ ...open, awaitingClient: true, duty: { ...open.duty!, nextDueAt: NOW } })).toBeNull();
  });
});

// ── ② 接线:经 collectTodos ──────────────────────────────────────

describe("规则 duty_due · 开工", () => {
  it("到点 ⇒ 业务经理拿到一条 `duty_due:<职责>:open@<排定点>`;没开过工时预算锚在创建时刻", () => {
    mkDuty();
    const t = dutyTodo();
    expect(t?.kind).toBe("duty_due");
    // 账本按**排定点**记:每个排定点一本新账(上一趟烧穿的不会带过来)
    expect(t?.key).toBe(`duty_due:du_1:open@${SLOT}`);
    expect(t?.role).toBe("business_manager");
    expect(t?.agentId).toBe("bm");
    expect(t?.targetState).toBe(T);
    expect(t?.label).toContain("开工");
    expect(labels()).toEqual(["duty_due:open"]);
  });

  it("没到点 / 不是职责的项目 ⇒ 没有", () => {
    mkDuty({ nextDueAt: NOW + MIN });
    expect(dutyTodo()).toBeUndefined();
    mkProject("p2");
    expect(board("p2").runnable.some((t) => t.kind === "duty_due")).toBe(false);
  });

  it("职责已暂停(排定清空)⇒ 没有;工作间项目被暂停 ⇒ 也没有", () => {
    mkDuty({ status: "paused", nextDueAt: null });
    expect(dutyTodo()).toBeUndefined();
    updateProject(db, "p1", { status: "paused" });
    expect(dutyTodo()).toBeUndefined();
  });

  it("等甲方答的问题 ⇒ 不开工", () => {
    mkDuty();
    mkArtifact("q_open", "client_question");
    expect(dutyTodo()).toBeUndefined();
  });

  it("今天开满了 ⇒ 不开工;昨天开的不算", () => {
    mkDuty();
    mkProject("p2");
    insertDuty(db, {
      id: "du_2", projectId: "p2", name: "另一条", goal: "g", boundaries: "",
      cadence: { kind: "hourly", at: null, weekday: null, hours: 1 }, formal: false, status: "active",
      nextDueAt: NOW + HOUR, lastRunAt: null, createdAt: T, updatedAt: T,
    });
    for (let i = 0; i < DUTY_DAILY_START_CAP; i++) {
      insertDutyRun(db, {
        id: `dr_old_${i}`, dutyId: "du_2", scheduledFor: NOW - (i + 1) * MIN, startedAt: NOW - (i + 1) * MIN,
        finishedAt: NOW, status: "done", steps: [], doneSummary: "x", notDone: "无", cause: null,
        nextChange: "x", gaps: "无", learned: "无", failures: [],
      });
    }
    expect(labels()).toEqual([]);
    // 同样这十二轮如果开在昨天(把「现在」挪到次日同一时刻)⇒ 照常开工
    expect(labels("p1", NOW + 24 * HOUR)).toEqual(["duty_due:open"]);
  });

  it("正式交付的职责:货交了等甲方验收 ⇒ 不开新工;甲方收了 ⇒ 下一轮照常", () => {
    mkDuty({ formal: true });
    mkWork("wk_d", { status: "done", reviewState: "done" });
    mkArtifact("art_d", "deliverable", { workId: "wk_d" });
    openDeliverableSession(db, { id: "s_d", projectId: "p1", deliverableArtifactId: "art_d", createdAt: NOW - MIN });
    expect(dutyTodo()).toBeUndefined();
    insertDeliveryVerdict(db, { projectId: "p1", artifactId: "art_d", verdict: "accept", note: null, createdAt: NOW });
    expect(labels().filter((l) => l.startsWith("duty_due"))).toEqual(["duty_due:open"]);
  });
});

const HOUR = 60 * MIN;

describe("规则 duty_due · 收工", () => {
  it("开了工、工作间空着 ⇒ `duty_due:<职责>:close`,预算锚在这一轮开工的时刻", () => {
    mkDuty({ nextDueAt: NOW + 24 * HOUR });
    mkRun();
    const t = dutyTodo();
    // 账本按**那一轮**记:每一轮收工一本新账
    expect(t?.key).toBe("duty_due:du_1:close@dr_1");
    expect(t?.targetState).toBe(NOW - MIN);
    expect(t?.label).toContain("收工");
  });

  it("活还没落定 ⇒ 不收:还有没做完的工作项 / 还有等着审的产出 / 还有没答的提问", () => {
    mkDuty({ nextDueAt: NOW + 24 * HOUR });
    mkRun();
    mkWork("wk_open", { status: "in_progress" });
    expect(dutyTodo()).toBeUndefined();
    // 活做完了、等着审 ⇒ 还不收
    updateWorkRaw("wk_open", "status = 'done', review_state = 'pending'");
    expect(dutyTodo()).toBeUndefined();
    // 审完了 ⇒ 收
    markWorkReviewed(db, "wk_open", NOW);
    expect(dutyTodo()?.key).toBe("duty_due:du_1:close@dr_1");
    // 但只要还有一条提问没答 ⇒ 再等
    insertAsk(db, {
      id: "ask_1", projectId: "p1", fromAgentId: "wk", toAgentId: "pm", question: "q", hypothesis: "h",
      status: "open", deadlineAt: null, createdAt: NOW, updatedAt: NOW, answeredAt: null, answer: null,
      escalatedTo: null,
    } as never);
    expect(dutyTodo()).toBeUndefined();
  });

  it("拖到了下一个排定点:活还没落定也收", () => {
    mkDuty({ nextDueAt: NOW });
    mkRun();
    mkWork("wk_open", { status: "in_progress" });
    expect(dutyTodo()?.key).toBe("duty_due:du_1:close@dr_1");
  });

  it("有问题在等甲方答 ⇒ 不收", () => {
    mkDuty({ nextDueAt: NOW });
    mkRun();
    mkArtifact("q_open", "client_question");
    expect(dutyTodo()).toBeUndefined();
  });
});

function updateWorkRaw(id: string, sets: string): void {
  db.prepare(`UPDATE works SET ${sets} WHERE id = ?`).run(id);
}

// ── ③ 职责项目里别的规则改口径 ──────────────────────────────────

describe("职责项目里的口径", () => {
  function pmCtx(projectId: string): ToolRunContext {
    return {
      db, agent: getAgent(db, "pm")!, project: loadProjectForAuthz(db, projectId)!,
      now: () => NOW, newId: (p) => `${p}_${++seq}`,
      workspace: createGitWorkspace(), workspaceRoot: workRoot,
    };
  }

  it("⚠️ 职责项目里建出来的工作项**已确认开工**(甲方设职责 = 预先授权);普通项目里照旧等他点", () => {
    mkDuty({ nextDueAt: NOW + HOUR });
    mkProject("p2");
    const inDuty = dispatch("work_create", { title: "读三份来源", goal: "各一句结论", assigneeRole: "research_worker" }, pmCtx("p1")) as ToolResult;
    const plain = dispatch("work_create", { title: "读三份来源", goal: "各一句结论", assigneeRole: "research_worker" }, pmCtx("p2")) as ToolResult;
    expect(inDuty.ok, inDuty.ok ? "" : inDuty.message).toBe(true);
    expect(plain.ok).toBe(true);
    const dutyWork = db.prepare(`SELECT confirmed_at FROM works WHERE project_id = 'p1'`).get() as { confirmed_at: number | null };
    const plainWork = db.prepare(`SELECT confirmed_at FROM works WHERE project_id = 'p2'`).get() as { confirmed_at: number | null };
    expect(dutyWork.confirmed_at, "职责项目:建出来就能跑").toBe(NOW);
    expect(plainWork.confirmed_at, "普通项目:D3 硬档一个字没动").toBeNull();
    // 后果:职责项目里执行者立刻拿到这条活;普通项目里要等「确认开工」
    expect(labels().map((l) => l.replace(/:wk.*$/, ""))).toContain("execute_work");
    expect(labels("p2").some((l) => l.startsWith("execute_work"))).toBe(false);
    expect(inDuty.text).toContain("已预先授权");
  });

  it("空的职责工作间不由项目经理自己起头拆解(每轮由业务经理列完功课再请他拆);普通空项目照旧", () => {
    mkDuty({ nextDueAt: NOW + HOUR });
    expect(labels()).toEqual([]);
    mkProject("p2");
    expect(labels("p2")).toEqual(["decompose_project"]);
  });

  /** 「做完了、审过了、还没有交付物」的一条根工作项 ⇒ 普通项目里该叫项目经理去整合。 */
  function seedReviewedRoot(): void {
    mkWork("wk_root", { status: "done", reviewState: "done" });
  }

  it("例行产出的职责:不整合、不交付、不判收口、不问「为什么没交付物」", () => {
    mkDuty({ nextDueAt: NOW + HOUR });
    seedReviewedRoot();
    expect(labels()).toEqual([]);
    // 对照:同样的形状在普通项目里,整合那一条规则会叫项目经理
    mkProject("p2");
    insertWork(db, { confirmedAt: 1, id: "wk_plain", projectId: "p2", parentWorkId: null, title: "t", goal: "g",
      status: "done", assigneeAgentId: "wk", createdAt: NOW, updatedAt: NOW });
    markWorkReviewed(db, "wk_plain", NOW);
    expect(labels("p2")).toContain("integrate");

    // 一份定稿的交付物挂在上面 ⇒ 普通项目里该叫业务经理交付;例行职责里不交付
    mkArtifact("art_d", "deliverable", { workId: "wk_root" });
    expect(labels()).toEqual([]);
    insertArtifact(db, {
      id: "art_plain", projectId: "p2", conversationId: null, kind: "deliverable", status: "accepted",
      authorAgentId: "wk", title: "交付", ...bodyAt("artifacts/art_plain.md", "正文"), metadataJson: null,
      createdAt: NOW, updatedAt: NOW, workId: "wk_plain",
    });
    expect(labels("p2")).toContain("handover");
  });

  it("例行产出的职责:唯一的工作项被取消了 ⇒ 也不问「为什么没交付物」(普通项目会问)", () => {
    // ⚠️ 这个形状才走得到那条规则:上一条用例里「做完了、还没整合的根」会让
    // `integratableRootCount > 0` 把它压住 —— 拆掉防线测试照样绿(变异 G25 第一轮就漏在这里)。
    // 一条被取消的根不算「收口了、等整合」,于是「全终结 + 零交付物」真的成立。
    mkDuty({ nextDueAt: NOW + HOUR });
    mkWork("wk_cancelled", { status: "cancelled" });
    expect(labels()).toEqual([]);
    // 对照:普通项目里同样「全终结、零交付物」⇒ 叫业务经理判断这是怎么了
    mkProject("p2");
    insertWork(db, { confirmedAt: 1, id: "wk_cancelled_plain", projectId: "p2", parentWorkId: null, title: "t", goal: "g",
      status: "cancelled", assigneeAgentId: "wk", createdAt: NOW, updatedAt: NOW });
    expect(labels("p2")).toContain("review_undelivered_project");
  });

  it("正式交付物的职责:整合与交付照旧走(它本来就是要交东西的)", () => {
    mkDuty({ formal: true, nextDueAt: NOW + HOUR });
    seedReviewedRoot();
    expect(labels()).toContain("integrate");
    mkArtifact("art_d", "deliverable", { workId: "wk_root" });
    expect(labels()).toContain("handover");
  });

  it("正式交付物的职责:全做完了、甲方也收了 ⇒ 判断收口的那条规则照旧叫业务经理;例行的永不叫", () => {
    // ⚠️ 把职责的排定挪到未来:这里只看收口那一条规则,不让 duty_due 混进来
    const finished = (): void => {
      mkWork("wk_root", { status: "done", reviewState: "done" });
      mkArtifact("art_d", "deliverable", { workId: "wk_root" });
      openDeliverableSession(db, { id: "s_d", projectId: "p1", deliverableArtifactId: "art_d", createdAt: NOW - MIN });
      insertDeliveryVerdict(db, { projectId: "p1", artifactId: "art_d", verdict: "accept", note: null, createdAt: NOW });
    };
    mkDuty({ formal: true, nextDueAt: NOW + 24 * HOUR });
    finished();
    expect(labels()).toEqual(["close_project"]);
    // 同一个形状换成例行职责:不判收口,也不问「为什么没交付物」
    db.prepare(`UPDATE duties SET formal = 0 WHERE id = 'du_1'`).run();
    expect(labels()).toEqual([]);
  });

  it("⚠️ 到顶不换手给项目经理(他手里没有职责的工具,叫醒他只是一轮空转)", () => {
    mkDuty();
    for (let i = 0; i < 3; i++) bumpAttempt(db, { projectId: "p1", todoKey: `duty_due:du_1:open@${SLOT}`, targetState: T, at: NOW + i });
    markAttemptNotified(db, "p1", `duty_due:du_1:open@${SLOT}`, NOW + 3);
    expect(labels()).toEqual(["×duty_due:open"]);
  });
});

describe("待办注入面:别的回合也知道这里有一轮开着", () => {
  it("有未收工的一轮 ⇒ 业务经理的待办块里有一行「并进日报,不单独播」;别的角色看不到;它不是唤醒理由", () => {
    mkDuty({ nextDueAt: NOW + 24 * HOUR });
    mkRun();
    const bm = collectPendingWork(db, "bm", "p1", NOW);
    expect(bm.openDutyRun?.id).toBe("dr_1");
    expect(hasActionable(bm)).toBe(false);
    const text = renderPendingWork(db, bm);
    expect(text).toContain("职责「行业简报」有一轮没收工(dr_1)");
    expect(text).toContain("并进日报");
    expect(collectPendingWork(db, "pm", "p1", NOW).openDutyRun).toBeNull();
    expect(collectPendingWork(db, "wk", "p1", NOW).openDutyRun).toBeNull();
  });

  it("没有未收工的一轮 / 不是职责项目 ⇒ 没有这一行", () => {
    mkDuty({ nextDueAt: NOW + 24 * HOUR });
    expect(collectPendingWork(db, "bm", "p1", NOW).openDutyRun).toBeNull();
    mkProject("p2");
    expect(collectPendingWork(db, "bm", "p2", NOW).openDutyRun).toBeNull();
  });
});

function hasActionable(w: { openDutyRun: unknown }): boolean {
  // 只看这一格是不是被当成了唤醒理由:把其余各格清空后 `hasActionableWork` 仍为真才算是
  return hasActionableWork({ ...w, asksToAnswer: [], meetingsToRespond: [], myBlockedAsks: [], overdueAsks: [],
    openBlockers: [], pendingChanges: [], myOpenWorks: [], myWaitingWorks: [], myWorksWithCancelledDeps: [],
    needsDecomposition: false });
}

// ── 任务正文 ────────────────────────────────────────────────────

describe("职责到点的任务正文:先把现状摆好", () => {
  it("开工:职责、边界、上一轮自省里的「下一轮怎么改」、现状、先列功课", () => {
    mkDuty();
    mkWork("wk_stuck", { status: "in_progress", title: "卡住的活" });
    insertDutyRun(db, {
      id: "dr_last", dutyId: "du_1", scheduledFor: T, startedAt: T + MIN, finishedAt: T + 30 * MIN,
      status: "done", steps: [{ title: "读三份来源", criterion: "各一句结论", done: true, note: null }],
      doneSummary: "读了两份", notDone: "第三份打不开", cause: null,
      nextChange: "提前十分钟缓存来源", gaps: "只覆盖了两家", learned: "某站要 referer", failures: [],
    });
    const text = renderTask(db, dutyTodo()!);
    expect(text).toContain("职责「行业简报」到点了 —— 开工");
    expect(text).toContain("每天一份三行简报");
    expect(text).toContain("付费来源先问我");
    expect(text).toContain("每天 09:00");
    expect(text).toContain("提前十分钟缓存来源 —— 这一条这一轮要兑现".replace(" —— ", "  ← "));
    expect(text).toContain("没做完的工作项:1 条");
    expect(text).toContain("wk_stuck [in_progress] 卡住的活");
    expect(text).toContain("duty_run_open");
    expect(text).toContain("不挂 `[未播报]`");
  });

  it("第一轮(从没开过工)与「上一轮还没收工」都如实写;甲方没写边界也不编一条", () => {
    mkDuty({ boundaries: "" });
    const first = renderTask(db, dutyTodo()!);
    expect(first).toContain("从没开过工 —— 这是第一轮");
    expect(first).toContain("这个工作间里还没有任何工作项");
    expect(first).toContain("甲方没写");
    mkRun({ id: "dr_orphan", dutyId: "du_1", status: "done", finishedAt: NOW });
    // 上一轮已收工但状态写成了 open 的那种形状不会出现;这里验的是「有未收工的一轮时正文换成收工」
    db.prepare(`UPDATE duty_runs SET status = 'open', finished_at = NULL WHERE id = 'dr_orphan'`).run();
    const close = renderTask(db, dutyTodo()!);
    expect(close).toContain("该收工了");
  });

  it("收工:功课逐条摆出来;这一轮里没成的事由平台查;有失败就明说原因不许为空", () => {
    mkDuty({ nextDueAt: NOW + 24 * HOUR });
    mkRun();
    const quiet = renderTask(db, dutyTodo()!);
    expect(quiet).toContain("工作间安静了");
    expect(quiet).toContain("1. 读三份来源 —— 每份一句结论");
    expect(quiet).toContain("duty_run_close");
    expect(quiet).not.toContain("不许为空");

    mkWork("wk_fail", { status: "failed", title: "失败的活", updatedAt: NOW });
    db.prepare(
      `INSERT INTO dispatch_events (project_id, kind, subject_id, summary, created_at)
       VALUES ('p1', 'work_failed', 'wk_fail', 's', ?)`,
    ).run(NOW);
    // ⚠️ failed 是**终态**:对工作间来说那条活已经落定,它是安静的。要触发「拖到了下一个
    // 排定点」,得有一条真的还没做完的活 —— 开工前就卡住、这一轮没碰过。
    mkWork("wk_stuck", { status: "in_progress", title: "卡住的活", updatedAt: NOW - 30 * MIN });
    expect(dutyTodo(), "没做完的活还在、也没到下一个排定点 ⇒ 还不收").toBeUndefined();
    db.prepare(`UPDATE duties SET next_due_at = ? WHERE id = 'du_1'`).run(NOW);
    const forced = renderTask(db, dutyTodo()!);
    expect(forced).toContain("已经到了下一个排定点");
    expect(forced).toContain("[work_failed] wk_fail「失败的活」");
    expect(forced).toContain("不许为空");
    expect(forced).toContain("还没做完的工作项:1 条");
    expect(forced).toContain("wk_stuck [in_progress] 卡住的活",
      "这一轮没碰过、但确实没做完的活也要摆出来");
  });

  it("职责记录已经不在了:如实说,不编一份正文", () => {
    expect(renderTask(db, {
      agentId: "bm", role: "business_manager", kind: "duty_due", projectId: "p1", key: "duty_due:du_gone:open",
      target: "du_gone", refs: [], targetState: null, attempts: 0, label: "x",
    })).toContain("已经不在了");
  });
});

// ── ④ 到顶有兜底 ────────────────────────────────────────────────

describe("熔断 settleExhaustedDuty · 预算烧穿不留僵尸", () => {
  /** 把某一面的账推到顶:开工按排定点记,收工按那一轮记。 */
  function exhaust(phase: "open" | "close", targetState: number): void {
    const key = phase === "open" ? `duty_due:du_1:open@${SLOT}` : "duty_due:du_1:close@dr_1";
    for (let i = 0; i < 3; i++) {
      bumpAttempt(db, { projectId: "p1", todoKey: key, targetState, at: NOW + i });
    }
    markAttemptNotified(db, "p1", key, NOW + 3);
  }

  it("没到顶 ⇒ 什么都不动", () => {
    mkDuty();
    bumpAttempt(db, { projectId: "p1", todoKey: `duty_due:du_1:open@${SLOT}`, targetState: T, at: NOW });
    expect(settleExhaustedDuty(db, "p1", NOW)).toEqual([]);
    expect(getDuty(db, "du_1")!.status).toBe("active");
  });

  it("开工到顶(连续三次没能开工)⇒ 暂停职责,工作间项目一起停;之后不再有待办;幂等", () => {
    mkDuty();
    exhaust("open", T);
    const out = settleExhaustedDuty(db, "p1", NOW + 10);
    expect(out.map((s) => s.kind)).toEqual(["paused"]);
    const duty = getDuty(db, "du_1")!;
    expect(duty.status).toBe("paused");
    expect(duty.nextDueAt).toBeNull();
    expect(loadProjectForAuthz(db, "p1")!.status).toBe("paused");
    expect(labels("p1", NOW + 20)).toEqual([]);
    expect(settleExhaustedDuty(db, "p1", NOW + 20)).toEqual([]);
  });

  it("收工到顶(连续三次没能收工)⇒ 这一轮由平台收掉(abandoned,没有自省);职责不停", () => {
    mkDuty({ nextDueAt: NOW + 24 * HOUR });
    mkRun();
    exhaust("close", NOW - MIN);
    const out = settleExhaustedDuty(db, "p1", NOW + 10);
    expect(out.map((s) => s.kind)).toEqual(["abandoned"]);
    const run = getDutyRun(db, "dr_1")!;
    expect(run.status).toBe("abandoned");
    expect(run.finishedAt).toBe(NOW + 10);
    // 平台**不替模型写自省**:功课的交代一格不动,自省五项里只有「缺口」记下这一轮是怎么收的
    expect(run.steps[0]!.done).toBeNull();
    expect(run.doneSummary).toBeNull();
    expect(run.cause).toBeNull();
    expect(run.gaps).toContain("由平台收掉");
    expect(openDutyRunOf(db, "du_1")).toBeNull();
    expect(getDuty(db, "du_1")!.status).toBe("active");
  });

  it("⚠️ 收掉之后,开工那一面拿到的是**全新**的预算 —— 收工烧穿的账不会被紧接着的开工继承", async () => {
    mkDuty({ nextDueAt: NOW + 24 * HOUR });
    mkRun();
    exhaust("close", NOW - MIN);
    settleExhaustedDuty(db, "p1", NOW + 10);
    // 下一轮到点:开工那一面在 runnable 里(新一个排定点的账是新的)
    const later = NOW + 25 * HOUR;
    expect(labels("p1", later)).toEqual(["duty_due:open"]);
    // 业务经理开工(第二轮)⇒ 紧接着的收工**也是一本新账**:上一轮收工烧穿过,这一轮照常有人来叫
    seq = 100; // 工具生成的 id 是 dr_<序号>:避开夹具用的 dr_1
    const bmCtx = (now: number): ToolRunContext => ({
      db, agent: getAgent(db, "bm")!, project: loadProjectForAuthz(db, "p1")!, now: () => now,
      newId: (p) => `${p}_${++seq}`, workspace: createGitWorkspace(), workspaceRoot: workRoot,
    });
    const opened = dispatch("duty_run_open", {
      steps: [{ title: "读三份来源", criterion: "各一句结论" }],
    }, bmCtx(later)) as ToolResult;
    expect(opened.ok, opened.ok ? "" : opened.message).toBe(true);
    const newRun = openDutyRunOf(db, "du_1")!;
    expect(newRun.id).not.toBe("dr_1");
    expect(labels("p1", later + MIN)).toEqual(["duty_due:close"]);
    // 第二轮收工又连续三次没成 ⇒ 同样由平台收掉,职责照旧不停
    for (let i = 0; i < 3; i++) {
      bumpAttempt(db, { projectId: "p1", todoKey: `duty_due:du_1:close@${newRun.id}`, targetState: newRun.startedAt, at: later + i });
    }
    markAttemptNotified(db, "p1", `duty_due:du_1:close@${newRun.id}`, later + 3);
    expect(settleExhaustedDuty(db, "p1", later + 4).map((s) => s.kind)).toEqual(["abandoned"]);
    expect(getDuty(db, "du_1")!.status).toBe("active");
    // 两轮收工的旧账随待办消失作废 —— 清理发生在排空之后(`pruneAttempts`),所以真的排一趟
    const tomorrow = later + 2 * HOUR;
    await drainProject({
      db, projectId: "p1", now: () => tomorrow, log: () => {},
      // 假回合**真的开工**(调 duty_run_open):不开工的话排空会连叫三次然后到顶 ——
      // 那是对的(第一格测的就是它),但这里要验的是「新一面从 1 次记起」。
      runAgentTurn: async (agentId) => {
        const opened = dispatch("duty_run_open", {
          steps: [{ title: "读三份来源", criterion: "各一句结论" }],
        }, {
          db, agent: getAgent(db, agentId)!, project: loadProjectForAuthz(db, "p1")!,
          now: () => tomorrow, newId: (p) => `${p}_${++seq}`,
          workspace: createGitWorkspace(), workspaceRoot: workRoot,
        });
        return { aborted: false, timedOut: false, text: "开工了", toolCalls: [] };
      },
      runWork: async () => { throw new Error("没有工作项要跑"); },
    });
    expect(listAttempts(db, "p1").has("duty_due:du_1:close@dr_1"), "第一轮收工的账随待办消失作废").toBe(false);
    expect(listAttempts(db, "p1").has(`duty_due:du_1:close@${newRun.id}`), "第二轮收工的账同样作废").toBe(false);
    expect(settleExhaustedDuty(db, "p1", tomorrow), "旧账清掉之后不会再把职责误判成叫不醒").toEqual([]);
    expect(getDuty(db, "du_1")!.status).toBe("active");
    // 再扫一遍不会把职责误判成「叫不醒」而暂停
    expect(settleExhaustedDuty(db, "p1", NOW + 25 * HOUR)).toEqual([]);
    expect(getDuty(db, "du_1")!.status).toBe("active");
  });

  it("⚠️ 被自动暂停后甲方去恢复 ⇒ 拿到的是新账,不会带着那本烧穿的老账立刻又被暂停", () => {
    mkDuty();
    exhaust("open", SLOT);
    expect(settleExhaustedDuty(db, "p1", NOW + 10).map((s) => s.kind)).toEqual(["paused"]);
    // 设置页的「启用」:职责与工作间回到 active,并从此刻重新排下一次(与 PUT /api/duties 同一组写入)
    const resumedAt = NOW + 2 * HOUR;
    updateDuty(db, "du_1", { status: "active", nextDueAt: resumedAt + HOUR }, resumedAt);
    updateProject(db, "p1", { status: "active" });
    expect(labels("p1", resumedAt + HOUR)).toEqual(["duty_due:open"]);
    expect(settleExhaustedDuty(db, "p1", resumedAt + HOUR)).toEqual([]);
  });

  it("不是职责的项目 / 职责已暂停 ⇒ 不动", () => {
    mkProject("p2");
    expect(settleExhaustedDuty(db, "p2", NOW)).toEqual([]);
    mkDuty({ status: "paused", nextDueAt: null });
    exhaust("open", T);
    expect(settleExhaustedDuty(db, "p1", NOW)).toEqual([]);
  });
});
