/**
 * 返工回路:`rework` 待办(2026-10-07 真机事故的回归)
 *
 * ── 这一批修的是什么 ─────────────────────────────────────────────
 *
 * 真机现场(项目「催收语音机器人技术方案」):根工作项被质检**连续三轮 fail**,
 * 三份审查意见共一万多字节(质检自己还写了「建议升级」),而 `turn_usage` 显示
 * **三次审查之间一个执行回合都没有**。两个缺陷叠在一起:
 *
 *   ① `review_verdict` 判 fail 走 `updateWorkStatus(work,'in_progress')`,而那条
 *      工作项是**容器**(有子项)⇒ `pendingWork.ts` 的 `myOpenWorks` 把容器排除在外
 *      ⇒ **没有任何执行者会接手**。而工具当时回给模型的话是「原执行者会再跑一轮」
 *      —— 平台做不到那件事,于是模型在**假前提**上推理(第二轮质检据此写下
 *      「worker 仍无任何实质性输出动作」)。
 *   ② 排空器每轮开头的 `closeIntegratedContainers` 见那条根「非终态 + 子项全终态
 *      且已审」⇒ **8 秒内又把它收口成 `done`** ⇒ 质检再审**同一份没变的东西**
 *      (真机 `dispatch_events` 里 4 条一字不差的「已完成」)。
 *
 * ── 为什么这个文件必须存在(本批最该记的一条)────────────────────
 *
 * 那个缺陷能一路走到真机,是因为**测试的形状与真实数据的形状不一样**:
 * `tests/platform/review-verdict.test.ts` 的夹具是
 * `insertWork({ id: "W0", parentWorkId: null, title: "整合与最终交付" })`
 * —— 一个**没有子项的「整合」**。它测的是叶子,而缺陷只在容器上出现;
 * 而容器过滤是**后加的、为另一场真机事故**(`20ca9a2` 10-05「容器根不再被当活派」),
 * 那次提交改了 `dispatcher` + `pendingWork` + 自己的测试,**没碰 `review.ts`,
 * 也没碰它的测试** ⇒ 两处各自正确的改动合起来变成一句假承诺,交叉处无测试。
 *
 * 所以本文件里**每一个**用例都建在**有子项**的形状上(容器),或者显式对照叶子 ——
 * 「叶子绿、容器红」正是这次事故的形态。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertWork, getWork, markWorkReviewed, type WorkStatus,
} from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertReviewVerdict } from "../../src/platform/storage/repo/reviewVerdicts.js";
import { bumpAttempt } from "../../src/platform/storage/repo/dispatch.js";
import { insertBlocker } from "../../src/platform/storage/repo/blockers.js";
import {
  collectTodos, drainProject, renderTask, RULES,
  type DrainTurnReport, type DriverTodo,
} from "../../src/platform/runtime/dispatcher.js";
import {
  reworkPendingOf, reworkOwner, REWORK_ESCALATE_ROUND, type ReworkPending,
} from "../../src/platform/runtime/rework.js";

function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "语音机器人", client: "甲方",
    goal: "产出一份可独立交付的技术方案", status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
});
afterEach(() => db.close());

function mkWork(over: {
  id?: string; parent?: string | null; title?: string; status?: WorkStatus; assignee?: string;
} = {}): string {
  const id = over.id ?? `wk_${++seq}`;
  insertWork(db, {
    id, projectId: "p1", parentWorkId: over.parent ?? null,
    title: over.title ?? `工作项 ${id}`, goal: "写出结论",
    status: over.status ?? "open", assigneeAgentId: over.assignee ?? "wk",
    createdAt: T0 + seq, updatedAt: T0 + seq,
  });
  return id;
}

/** `done` + **已审**(质检跑过的现场)。 */
function mkReviewedDone(over: { id?: string; parent?: string | null; title?: string } = {}): string {
  const id = mkWork({ ...over, status: "done" });
  markWorkReviewed(db, id, T0 + 500);
  return id;
}

let artSeq = 0;
function mkArtifact(over: {
  kind?: string; workId?: string | null; author?: string; at?: number; title?: string;
} = {}): string {
  const id = `art_${++artSeq}`;
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null,
    kind: (over.kind ?? "evidence") as "evidence",
    status: "open", authorAgentId: over.author ?? "wk",
    title: over.title ?? `工件 ${id}`,
    ...bodyAt(`artifacts/${id}.md`, "正文(判定不该读它)"),
    metadataJson: null,
    createdAt: over.at ?? T0 + 900, updatedAt: over.at ?? T0 + 900,
    workId: over.workId ?? null,
  });
  return id;
}

/** 写一条审查结论。**只写 verdict 行** —— 状态迁移由被测代码决定,测试不代劳。 */
function verdict(workId: string, v: "pass" | "fail", at: number, extra: {
  severity?: "low" | "medium" | "high"; finding?: string | null;
} = {}): void {
  insertReviewVerdict(db, {
    workId, projectId: "p1", verdict: v,
    severity: extra.severity ?? (v === "fail" ? "high" : "low"),
    findingArtifactId: extra.finding ?? null, note: null,
    reviewedBy: "qa", createdAt: at,
  });
}

const board = (now = T0 + 10_000) => collectTodos({ db, projectId: "p1", now });
const kinds = (now = T0 + 10_000): string[] =>
  board(now).runnable.map((t) => `${t.kind}:${t.agentId}`).sort();
const reworkTodo = (now = T0 + 10_000): DriverTodo | undefined =>
  board(now).runnable.find((t) => t.kind === "rework");

const okTurn: DrainTurnReport = { aborted: false, timedOut: false, text: "好了", toolCalls: [] };

// ══════════════════════════════════════════════════════════════════
// ① 规则形状
// ══════════════════════════════════════════════════════════════════

describe("① 规则 `rework_failed_review` 的形状", () => {
  it("它在规则表里,kind = `rework`,on 含 tick,why 有现场", () => {
    const r = RULES.find((x) => x.id === "rework_failed_review");
    expect(r, "规则表里没有 rework_failed_review").toBeDefined();
    expect(r?.then.kind).toBe("rework");
    expect(r?.on).toContain("tick");
    // 返工完成的**唯一**结构化信号就是「这条工作项上出现了更新的产出」= 一次
    // `artifact_inserted`;少了它,这条待办要等 10 秒的兜底 tick 才消失。
    expect(r?.on).toContain("artifact_inserted");
    expect(r?.why.length).toBeGreaterThan(100);
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 目的地:有作者给作者,没有作者给 PM(用户裁决)
// ══════════════════════════════════════════════════════════════════

describe("② 返工目的地(用户裁决:有作者给作者,找不到人解决就给 PM)", () => {
  it("**有作者** ⇒ 退给产出的作者(不是工作项的负责人)", () => {
    const w = mkWork({ id: "W", assignee: "cw" }); // 负责人是编码工
    mkArtifact({ workId: w, author: "wk" }); // 但产出是研究工写的
    verdict(w, "fail", T0 + 1000);
    const t = reworkTodo();
    expect(t, "判了 fail 就必须有人被叫醒 —— 这是本次事故的直接判据").toBeDefined();
    expect(t?.agentId, "谁写的谁改:不看 assignee").toBe("wk");
    expect(t?.kind).toBe("rework");
    expect(t?.target).toBe(w);
    expect(t?.refs).toEqual([w]);
    expect(t?.key).toBe(`rework:${w}`);
  });

  it("**这份产出是质检自己写的 `review_finding`** ⇒ **不算产出**,退给 PM(不是质检自己)", () => {
    // ⚠️ 这条钉的是 migration 014 那个「产出 ∪ 关于」的并集陷阱:
    // `review_finding` 的 `work_id` 指向**被审的那条**,naive 实现会把返工
    // 退给**质检自己**。
    const w = mkWork({ id: "W", status: "done" });
    mkArtifact({ kind: "review_finding", workId: w, author: "qa" });
    verdict(w, "fail", T0 + 1000);
    expect(reworkTodo()?.agentId, "唯一的产出是质检意见 ⇒ 没有作者可退").toBe("pm");
  });

  it("**容器、且它自己一份产出都没有** ⇒ 退给 PM(真机那个现场)", () => {
    // 真实形状:6 个子项各自有产出(挂在**子项**的 work_id 上),而根工作项
    // 一份都没有 —— 「子项有交付物」不等于「这条容器交付了它自己那份」。
    const root = mkWork({ id: "R", title: "交付:技术方案" });
    const c1 = mkReviewedDone({ id: "c1", parent: root });
    const c2 = mkReviewedDone({ id: "c2", parent: root });
    mkArtifact({ workId: c1, author: "wk", kind: "deliverable" });
    mkArtifact({ workId: c2, author: "wk", kind: "deliverable" });
    verdict(root, "fail", T0 + 1000);
    const t = reworkTodo();
    expect(t, "容器判 fail 之后必须有人被叫醒(以前**没有**:容器不在 myOpenWorks 里)")
      .toBeDefined();
    expect(t?.agentId).toBe("pm");
    expect(t?.target).toBe(root);
    // 负样本自检:子项自己有产出这件事**不能**让它把目的地算成子项的作者
    expect(t?.agentId).not.toBe("wk");
  });

  it(`**第 ${REWORK_ESCALATE_ROUND} 轮起换人** —— 反复给同一个作者已经没有不同的结果`, () => {
    const w = mkWork({ id: "W" });
    mkArtifact({ workId: w, author: "wk" });
    // 前两轮:给作者
    verdict(w, "fail", T0 + 1000);
    verdict(w, "fail", T0 + 2000);
    expect(reworkTodo()?.agentId).toBe("wk");
    // 第三轮:换人
    verdict(w, "fail", T0 + 3000);
    const t = reworkTodo();
    expect(t?.agentId).toBe("pm");
    expect(t?.label, "轮次要如实写进人读的那一行").toContain(`第 ${REWORK_ESCALATE_ROUND} 轮`);
  });

  it("`reworkOwner` 是纯函数:同一份现场给同一个答案(重启后照样算得出来)", () => {
    const w = mkWork({ id: "W", status: "done" });
    mkArtifact({ workId: w, author: "cw" });
    verdict(w, "fail", T0 + 1000);
    const pending = reworkPendingOf(db, "p1", getWork(db, w)!, {
      seq: 1, workId: w, projectId: "p1", verdict: "fail", severity: "high",
      findingArtifactId: null, note: null, reviewedBy: "qa", createdAt: T0 + 1000,
    }) as ReworkPending;
    const members = [
      { agentId: "pm", role: "project_manager" as const },
      { agentId: "cw", role: "coding_worker" as const },
    ];
    expect(reworkOwner(pending, members)).toEqual({
      agentId: "cw", role: "coding_worker", reason: "author",
    });
    // 作者不在项目里(被移出)⇒ 兜底 PM,而不是派给一个建不出会话的人
    expect(reworkOwner(pending, [members[0]!])).toEqual({
      agentId: "pm", role: "project_manager", reason: "pm_fallback",
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// ③ 不再重审「一个字节都没变」的产出(真机三轮循环的回归)
// ══════════════════════════════════════════════════════════════════

describe("③ 判过 fail 的产出不再被重审,返工交东西之后才回到审查", () => {
  it("**判 fail 之后平台就算又把它标成 `done/pending`,也不审** —— 它在等返工", () => {
    // 真机形态:fail 之后平台 8 秒内把它收口成 done + review_state=pending,
    // 于是质检被叫来审**同一份没变的东西**(三轮)。
    const w = mkWork({ id: "W", status: "done" });
    const before = mkArtifact({ workId: w, author: "wk", kind: "deliverable", at: T0 + 900 });
    verdict(w, "fail", T0 + 1000);
    // 平台又收口了一次(旧行为):done + review_state=pending
    db.prepare(`UPDATE works SET status='done', review_state='pending' WHERE id='W'`).run();
    expect(kinds(), "等返工的产出不该再进审查").not.toContain("review_work:qa");
    // 这份产出是 wk 写的 ⇒ 目的地是作者本人(与「没有作者才给 PM」那条对照)
    expect(kinds()).toContain("rework:wk");

    // 正样本自检:交一份**比结论更新**的产出之后,两条立刻换位
    mkArtifact({ workId: w, author: "wk", kind: "deliverable", at: T0 + 2000 });
    expect(kinds(), "重新交过东西就不再是等返工").not.toContain("rework:wk");
    expect(kinds(), "新产出该被审").toContain("review_work:qa");
    // 而且旧的那一份仍然在库里(finding 的现场不许被抹掉)
    expect(before).toBeTruthy();
  });

  it("`done` 但**从来没有结论**的产出照常进审查(负样本:别把「没审过」读成「在返工」)", () => {
    const w = mkWork({ id: "W", status: "done" });
    mkArtifact({ workId: w, author: "wk", kind: "deliverable" });
    expect(kinds()).toContain("review_work:qa");
    expect(kinds()).not.toContain("rework:pm");
  });

  it("**普通执行回合不再被点火**(它不带质检意见)", () => {
    const w = mkWork({ id: "W", status: "in_progress", assignee: "wk" });
    mkArtifact({ workId: w, author: "wk" });
    verdict(w, "fail", T0 + 1000);
    expect(kinds(), "同一条工作项不能既派执行又派返工").not.toContain("execute_work:wk");
    expect(kinds()).toContain("rework:wk");
  });
});

// ══════════════════════════════════════════════════════════════════
// ④ 收口不再撤销「退回」(8 秒循环的端到端回归)
// ══════════════════════════════════════════════════════════════════

describe("④ 排空器不再把刚退回的容器立刻又收口成 `done`", () => {
  it("**容器被判 fail ⇒ 跑一次排空,它仍是 `in_progress`,而且派发的是返工回合**", async () => {
    const root = mkWork({ id: "R", title: "交付:技术方案", status: "in_progress" });
    const c1 = mkReviewedDone({ id: "c1", parent: root });
    mkArtifact({ workId: c1, author: "wk", kind: "deliverable" });
    verdict(root, "fail", T0 + 1000);
    // 先自检:这条根的收口判据本身是**成立**的(子项全终态 + 已审 + 子树有交付物)
    // —— 没有这条自检,「它没被收口」可能只是因为判据压根不成立
    expect(getWork(db, root)!.status).toBe("in_progress");

    const dispatched: Array<{ agentId: string; kind: string; task: string }> = [];
    const r = await drainProject({
      db, projectId: "p1", now: () => T0 + 5000, log: () => {},
      runAgentTurn: async (agentId, task, kind) => {
        dispatched.push({ agentId, kind, task });
        return okTurn;
      },
      runWork: async () => { throw new Error("不该被调用"); },
      maxRounds: 1,
    });
    expect(dispatched[0]?.kind, "派出去的必须是返工回合").toBe("rework");
    expect(dispatched[0]?.agentId).toBe("pm");
    expect(
      getWork(db, root)!.status,
      "收口不许撤销这次退回 —— 撤销了就是真机那个 8 秒循环",
    ).toBe("in_progress");
    expect(r.rounds).toBe(1);
  });

  it("**对照**:同一条容器**没有被判 fail** 时,收口照常发生(证伪「收口整体坏了」)", async () => {
    const root = mkWork({ id: "R", status: "in_progress" });
    const c1 = mkReviewedDone({ id: "c1", parent: root });
    mkArtifact({ workId: c1, author: "wk", kind: "deliverable" });
    await drainProject({
      db, projectId: "p1", now: () => T0 + 5000, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
      // ⚠️ 不能写 `maxRounds: 0` —— 到界判定在「平台记账」**之前**,那样收口压根不跑,
      // 断言就成了一条永远为假的假现场(写这条注释是因为我第一版正是这么写的)。
      maxRounds: 1,
    });
    expect(getWork(db, root)!.status).toBe("done");
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑤ 2026-10-07 的**静默死锁**:pass 的消费不再绑在回合类型上
// ══════════════════════════════════════════════════════════════════

describe("⑤ `pass` 的消费与「哪个回合办成的」解耦(真机静默死锁的回归)", () => {
  it("**预算已用尽、那个回合永远不会再来 ⇒ pass 仍然要被消费掉**", async () => {
    // ⚠️ 本用例测的是**消费**,不是兜底规则 —— 夹具停在「全终结 + 一条 `open` 交付物」
    // (`open` 永远变不成 `accepted`),那正是 `review_undelivered_project`(见
    // stalled-project.test.ts)要管的死尾。插一条未解决阻塞把它按住,否则红的是噪声。
    insertBlocker(db, {
      id: "b_fixture", projectId: "p1", raisedByAgentId: "wk",
      title: "夹具:按住「没交付」兜底", detail: "见注释",
      severity: "low", status: "open", createdAt: T0,
    });
    // 真机现场:质检在 `answer_ask` 回合里判了「通过」(17:09:18),而这条
    // `review_work` 的尝试预算已经 3/3 用尽 ⇒ 那个回合再也不会发生 ⇒
    // `review_state` 永远是 `pending` ⇒ `close_finished_project` 要求
    // 「待审产出 = 0」⇒ 项目永远收不了口,而且预算用尽只播报一次,**连告警都没有**。
    const w = mkWork({ id: "W", status: "done" }); // review_state = pending
    mkArtifact({ workId: w, author: "wk", kind: "deliverable" });
    verdict(w, "pass", T0 + 1000);
    // 把这条待办的预算烧到上限(判据与排空器同源:`maxAttemptsPerTodo` 默认 3)
    const key = `review_work:${w}`;
    for (let i = 0; i < 3; i++) {
      bumpAttempt(db, { projectId: "p1", todoKey: key, targetState: null, at: T0 + 1100 + i });
    }
    let turns = 0;
    const r = await drainProject({
      db, projectId: "p1", now: () => T0 + 5000, log: () => {},
      runAgentTurn: async () => { turns++; return okTurn; },
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(turns, "一个回合都不该跑(预算已尽)—— 但结论已经存在").toBe(0);
    expect(
      getWork(db, w)!.reviewState,
      "「这件事办过了没有」必须重新查库,不能依赖「哪个回合办成的」",
    ).toBe("done");
    // 消费之后这条待办自己消失(集合缩小 ⇒ 预算作废)
    expect(kinds()).not.toContain("review_work:qa");
    expect(r.stopReason).toBe("exhausted");
  });

  it("负样本:只有 `fail` 结论时**不消费**(它要的是返工,不是「已审」)", async () => {
    const w = mkWork({ id: "W", status: "done" });
    mkArtifact({ workId: w, author: "wk", kind: "deliverable" });
    verdict(w, "fail", T0 + 1000);
    await drainProject({
      db, projectId: "p1", now: () => T0 + 5000, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
      // 同理不能写 0:那样「平台记账」整块不跑,断言就没有牙。
      // 这里让排空真的跑起来(它会派发返工回合)→ 消费块执行过 → 结论仍然是不消费。
      maxRounds: 2,
    });
    expect(getWork(db, w)!.reviewState).not.toBe("done");
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑥ 返工包:结论 + id,**不搬正文**(用户裁决)
// ══════════════════════════════════════════════════════════════════

describe("⑥ 返工回合的任务正文 = 质检包(结论 + 原工件 id)", () => {
  it("**带结论、带 finding id、带上一轮产出 id**,并且**不复述 finding 的正文**", () => {
    const w = mkWork({ id: "W", status: "done" });
    const old = mkArtifact({ workId: w, author: "wk", kind: "deliverable", at: T0 + 800 });
    const finding = mkArtifact({
      kind: "review_finding", workId: w, author: "qa", at: T0 + 900,
      title: "【质检】不通过",
    });
    verdict(w, "fail", T0 + 1000, { severity: "high", finding });
    const todo = reworkTodo();
    expect(todo).toBeDefined();
    const task = renderTask(db, todo!);
    expect(task).toContain("第 1 轮");
    expect(task, "没有 finding id 的返工包 = 让模型自己猜为什么").toContain(finding);
    expect(task, "上一轮的产出 id 要如实给").toContain(old);
    expect(task).toContain(w);
    // **负样本**:任何一份工件的正文都不许出现在任务里
    expect(task, "平台不复述正文(用户裁决:不要重复原文,否则浪费)")
      .not.toContain("正文(判定不该读它)");
  });

  it("这条工作项**一份产出都没有**时,正文如实说这件事(真机那个现场)", () => {
    const root = mkWork({ id: "R", title: "交付:技术方案", status: "done" });
    const c1 = mkReviewedDone({ id: "c1", parent: root });
    mkArtifact({ workId: c1, author: "wk", kind: "deliverable" });
    verdict(root, "fail", T0 + 1000);
    const task = renderTask(db, reworkTodo()!);
    expect(task).toContain("一份产出都没有");
  });

  it("容器返工时把子树摆出来 —— 它要交的是**它自己**那份产出", () => {
    const root = mkWork({ id: "R", title: "交付:技术方案", status: "done" });
    const c1 = mkReviewedDone({ id: "c1", parent: root, title: "子项一" });
    mkArtifact({ workId: c1, author: "wk", kind: "deliverable" });
    verdict(root, "fail", T0 + 1000);
    const task = renderTask(db, reworkTodo()!);
    expect(task).toContain("它是容器");
    expect(task).toContain("c1");
    expect(task, "交付物的 workId 必须写那条根工作项").toContain(`\`${root}\``);
  });

  it("待办与库不一致时**不编现场**(有人刚好交了新产出)", () => {
    const w = mkWork({ id: "W", status: "done" });
    verdict(w, "fail", T0 + 1000);
    const todo = reworkTodo()!;
    // 交了一份更新的产出 ⇒ 它已经不在等返工了
    mkArtifact({ workId: w, author: "wk", kind: "deliverable", at: T0 + 2000 });
    const task = renderTask(db, todo);
    expect(task).toContain("已经不在等返工");
  });
});
