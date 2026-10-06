/**
 * 丙批 · 两条真机确认的缺陷(方案丙)
 *
 * ══ 缺陷 1(最严重):一条 `blocked` 的子项 ⇒ **整个项目零待办** ══════════
 *
 * 真机实测(`collectTodos` 直接跑在真机库的 `VACUUM INTO` 副本上,三组对照):
 *
 *   ① 真机库原样(1 根 blocked + 子项 done/done/blocked/open/open)
 *        → 待办**空** —— 没有任何人会被叫醒
 *   ② 子项全 done、只留那条 blocked 的子项、根仍 blocked → `integrate` **不出现**
 *   ③ 那条子项也 done、根仍 blocked(对照组)          → `integrate` **出现** ✓
 *
 * **机制**:那条 blocked 的子项把依赖它的两条 `open` 卡在 `myWaitingWorks`
 * (`depsSatisfied=false`)⇒ 项目**零可执行待办** ⇒ 排空器每 10 秒空转。
 * 而**没有任何规则读 `works.status='blocked'`**:`myOpenWorks` 只要
 * `open|in_progress`;`asks` 表 0 行;`blocker_opened` 只在 severity ∈
 * {high, critical} 时写 outbox(medium 阻塞**连 outbox 都没有**)。
 *
 * ══ 缺陷 2:容器根被当成真活派给 worker ════════════════════════════════
 *
 * 真机日志:第 4/8 回合 → wk 执行「催收语音机器人升级 · 交付整合」,**跑了 6 分钟**,
 * 然后该工作项 blocked。而 **worker 自己识别对了**(真机 `session_messages` 原文):
 * 「它是一个『交付整合』容器,而我刚拿到的任务就是它」。
 *
 * **根因**:`parent_work_id IS NULL` 只是「没有父」,扁平结构下**每个真活都是根**
 * ⇒ 判据必须是「**有子项**」,不是「是根」。
 *
 * ── 这个文件钉的六条判据(S1–S6)────────────────────────────────
 *
 *   S1 有子项的根(**任意状态**)不产出 `execute_work`
 *   S2 **叶子根(真活)必须产出 `execute_work`** ← 反向判据:守的是「别把真活误判成
 *      容器」,那是**静默停摆**的方向,比误派一次严重
 *   S3 子树全终态 + 根 open/blocked ⇒ 产出 `integrate`(今天为真,不许弄坏)
 *   S4 **一条 blocked 的子项 ⇒ 必须有人被叫醒** ← 今天为假,主判据
 *   S5 因 `ask_client` 而 blocked 的工作项 ⇒ **不该**叫醒 PM(等甲方)
 *   S6 整合成功(根上落了 `deliverable`)⇒ 根被置 `done`(经唯一写口)
 *
 * 真机库副本上的实测输出(不只是内存库里的形状)见报告;这里用内存库把**判据**
 * 逐条钉死,因为判据是纯查询、与库的来源无关。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertWork, getWork, updateWorkStatus, markWorkReviewed, workIdsWithChildren,
  type WorkStatus,
} from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertReviewVerdict } from "../../src/platform/storage/repo/reviewVerdicts.js";
import { insertBlocker, blockWork } from "../../src/platform/storage/repo/blockers.js";
import {
  collectPendingWork, hasActionableWork,
} from "../../src/platform/runtime/pendingWork.js";
import {
  collectTodos, drainProject, renderTask, type DrainTurnReport,
} from "../../src/platform/runtime/dispatcher.js";

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "催收语音机器人升级", client: "甲方",
    goal: "把三段式换成 omni", status: "active", createdAt: T0,
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

/** `done` + 已审(质检跑过的现场)。 */
function mkReviewedDone(over: { id?: string; parent?: string | null; title?: string } = {}): string {
  const id = mkWork({ ...over, status: "done" });
  markWorkReviewed(db, id, T0 + 500);
  return id;
}

function mkDeliverable(id: string, workId: string | null, status = "open"): void {
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null,
    kind: "deliverable", status: status as "open", authorAgentId: "pm",
    title: `交付物 ${id}`, body: "整合产物", metadataJson: null,
    createdAt: T0 + 900, updatedAt: T0 + 900, workId,
  });
}

/** 一条未答复的甲方提问 —— 库里「球在甲方那边」的**唯一**结构化事实。 */
function mkOpenClientQuestion(id: string): void {
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null,
    kind: "client_question", status: "open", authorAgentId: "bm",
    title: "试运行生产队列具体怎么安排?", body: "候选 A / B / C", metadataJson: null,
    createdAt: T0 + 950, updatedAt: T0 + 950,
  });
}

/** 一条未解决的阻塞,并**挂到**某条工作项上(`blocker_blocks` 是唯一那条边)。 */
function mkBlocker(
  id: string, workId: string, severity: "low" | "medium" | "high" | "critical",
): void {
  insertBlocker(db, {
    id, projectId: "p1", raisedByAgentId: "wk",
    title: `${id} 的现场`, detail: "需要谁做什么决定",
    severity, status: "open", createdAt: T0,
  });
  blockWork(db, id, workId);
}

const board = (now = T0) => collectTodos({ db, projectId: "p1", now });
const kinds = (now = T0): string[] => board(now).runnable.map((t) => t.kind);
const todosOf = (kind: string, now = T0) =>
  board(now).runnable.filter((t) => t.kind === kind);

const okTurn: DrainTurnReport = { aborted: false, timedOut: false, text: "好了", toolCalls: [] };

// ══════════════════════════════════════════════════════════════════
// 丙① 容器根不进 `execute_work`
// ══════════════════════════════════════════════════════════════════

describe("丙① · 容器(有子项)不进 `execute_work`;叶子(真活)照旧", () => {
  it("S1 · 有子项的根 **不产出** `execute_work`(任意状态:open / in_progress / blocked)", () => {
    for (const status of ["open", "in_progress", "blocked"] as const) {
      const root = mkWork({ id: `root_${status}`, status, title: `容器(${status})` });
      mkWork({ id: `kid_${status}`, parent: root, title: "子项" });
      // 容器不在**注入面**里:模型再也看不到「分派给你、可以开工的工作项」有它
      const pw = collectPendingWork(db, "wk", "p1", T0);
      expect(
        pw.myOpenWorks.map((w) => w.id),
        `容器(${status})不该出现在 myOpenWorks 里`,
      ).not.toContain(root);
      expect(
        pw.myWaitingWorks.map((w) => w.id),
        `容器(${status})也不是「在等前置」—— 它根本不由执行者跑`,
      ).not.toContain(root);
      expect(
        todosOf("execute_work").map((t) => t.target),
        `容器(${status})不该产出 execute_work`,
      ).not.toContain(root);
      // 正样本自检:那条**子项**是叶子,它必须在(`kid_${status}` 就是证人)
      expect(todosOf("execute_work").map((t) => t.target)).toContain(`kid_${status}`);
    }
  });

  it("S2 · **叶子根(真活)必须产出 `execute_work`** —— 反向判据,守的是静默停摆方向", () => {
    const leaf = mkWork({ id: "leaf_only", title: "真活:接入方案设计" });
    const t = todosOf("execute_work").find((x) => x.target === leaf);
    expect(
      t,
      "扁平的库里**每一条真活都是根** —— 判据若写成「是根」,这里会一条都不剩(静默停摆)",
    ).toBeDefined();
    expect(collectPendingWork(db, "wk", "p1", T0).myOpenWorks.map((w) => w.id)).toEqual([leaf]);
  });

  it("S2 对照 · 容器**不因为子项都终态就变回叶子** —— 判据是「有子项」,不是「子项还开着」", () => {
    const root = mkWork({ id: "R" });
    mkReviewedDone({ id: "c_done", parent: root });
    mkWork({ id: "c_cancelled", parent: root, status: "cancelled" });
    expect(todosOf("execute_work").map((t) => t.target), "R 有子项 ⇒ 永远不是可执行项").toEqual([]);
    // 同一次断言里的正样本:一条**同期**建的叶子真活照样在(证明上面不是「看板空了」)
    mkWork({ id: "leaf_alive" });
    expect(todosOf("execute_work").map((t) => t.target)).toEqual(["leaf_alive"]);
  });

  it("`hasActionableWork`:只有容器派给 worker 时**不叫醒他**(叫醒也只能空转)", () => {
    const root = mkWork({ id: "only_container" });
    mkWork({ id: "kid", parent: root, assignee: "pm" });
    // kid 派给 pm(不可执行)⇒ worker 手上只剩容器
    expect(hasActionableWork(collectPendingWork(db, "wk", "p1", T0))).toBe(false);
    mkWork({ id: "leaf_for_wk" });
    expect(hasActionableWork(collectPendingWork(db, "wk", "p1", T0))).toBe(true);
  });

  it("判据落在 `works` 上:`workIdsWithChildren` 就是「有子项」那一条 SQL", () => {
    const root = mkWork({ id: "R" });
    expect([...workIdsWithChildren(db, "p1")], "还没有子项时它是叶子").toEqual([]);
    mkWork({ id: "kid", parent: root });
    expect([...workIdsWithChildren(db, "p1")]).toEqual(["R"]);
    // 子项没了 ⇒ 它又变回叶子:判据是**库里当下的形状**,不是一次性的标记
    db.prepare(`DELETE FROM works WHERE id = 'kid'`).run();
    expect([...workIdsWithChildren(db, "p1")]).toEqual([]);
    // 作用域 = 项目:别的项目里的子项**不许**把本项目的工作项判成容器
    insertProject(db, {
      id: "p_other", name: "别的项目", client: "甲方", goal: "g",
      status: "active", createdAt: T0,
    });
    insertWork(db, {
      id: "kid_other", projectId: "p_other", parentWorkId: root, title: "别人的子项",
      goal: "g", status: "open", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    expect([...workIdsWithChildren(db, "p1")], "子项属于别的项目 ⇒ 本项目看不到它").toEqual([]);
    expect([...workIdsWithChildren(db, "p_other")]).toEqual(["R"]);
  });

  it("S3 · 子树全终态 + 根 open/blocked ⇒ `integrate` 照常产出(今天为真,别弄坏)", async () => {
    for (const rootStatus of ["open", "blocked"] as const) {
      const id = `root_${rootStatus}`;
      const root = mkWork({ id, status: rootStatus });
      mkReviewedDone({ id: `c1_${rootStatus}`, parent: root });
      mkReviewedDone({ id: `c2_${rootStatus}`, parent: root });
      const t = todosOf("integrate");
      expect(t.map((x) => x.refs[0]), `根 ${rootStatus} 不卡 integrate`).toContain(root);
      // 清理,让下一轮只留下要测的那棵树
      db.prepare(`DELETE FROM works WHERE id IN (?, ?, ?)`).run(root, `c1_${rootStatus}`, `c2_${rootStatus}`);
      db.prepare(`DELETE FROM artifacts WHERE work_id IS NOT NULL`).run();
    }
    expect(todosOf("integrate")).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 丙③ 非终态的 `blocked` 进 PM 的待办
// ══════════════════════════════════════════════════════════════════

describe("丙③ · `blocked` 必须有驱动者(缺陷 1 的解)", () => {
  /**
   * 真机库的**形状**(逐字段照抄 `~/.sansheng/sansheng.db` 的副本):
   *   根 blocked(有 4 个子项)+ 子项 done/done/blocked/open/open,
   *   依赖链 done → blocked → open → open。
   */
  function realMachineShape(): { root: string; blockedChild: string } {
    const root = mkWork({ id: "root_container", status: "blocked", title: "催收语音机器人升级 · 交付整合" });
    const c1 = mkReviewedDone({ id: "c1_done", parent: root });
    const blockedChild = mkWork({ id: "c2_blocked", parent: root, status: "blocked", title: "对话链路改造与 omni 接入" });
    const c3 = mkWork({ id: "c3_open", parent: root, title: "核心指标埋点与监控" });
    const c4 = mkWork({ id: "c4_open", parent: root, title: "灰度上线 + 试运行" });
    db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run(blockedChild, c1);
    db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run(c3, blockedChild);
    db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run(c4, c3);
    mkBlocker("blk_pm_work", root, "medium");
    mkBlocker("blk_client_wait", blockedChild, "high");
    return { root, blockedChild };
  }

  it("S4 · 一条 `blocked` 的子项 ⇒ **必须有人被叫醒**(修之前这里是零待办)", () => {
    const { root, blockedChild } = realMachineShape();
    const todos = board().runnable;
    // 先钉住「为什么会零待办」:两条 open 依赖那条 blocked ⇒ 前置不满足
    expect(
      todosOf("execute_work"),
      "c3/c4 的前置是那条 blocked 的子项 ⇒ 它们开不了工(这是现场,不是缺陷)",
    ).toEqual([]);
    expect(
      todos.map((t) => t.kind),
      "**一条 blocked 的工作项必须至少有一条待办** —— 否则排空器每 10 秒空转," +
        "而「零待办」与「组织把活干完了」在日志里长得一模一样",
    ).toContain("resolve_blocked_work");
    // 是**项目经理**被叫醒,而且一条待办覆盖全部被阻塞的工作项(集合谓词:key 变了=有进度)
    const t = todosOf("resolve_blocked_work")[0]!;
    expect(t).toMatchObject({ agentId: "pm", role: "project_manager" });
    expect(t.refs).toEqual([blockedChild, root].sort());
    expect(t.key).toBe(`resolve_blocked_work:${[blockedChild, root].sort().join("+")}`);
    expect(t.label).toContain("2 条被阻塞的工作项");
  });

  it("S4b · **裸 `blocked`(一条阻塞都没登记)也照样被叫** —— 那是最该有人看一眼的一种", () => {
    const w = mkWork({ id: "w_bare", status: "blocked" });
    const t = todosOf("resolve_blocked_work");
    expect(t.map((x) => x.refs[0])).toContain(w);
    // 渲染里必须点名「一条阻塞都没登记」,否则模型不知道自己要查什么
    expect(renderTask(db, t[0]!)).toContain("一条阻塞都没登记");
  });

  it("阻塞**解除**之后不再是待办(判据是库里的状态,不是「刚才发生过什么」)", () => {
    const w = mkWork({ id: "w_x", status: "blocked" });
    mkBlocker("blk_x", w, "medium");
    expect(todosOf("resolve_blocked_work")).toHaveLength(1);
    // 挪回 open:它现在是一条正常的执行待办,不再需要 PM
    updateWorkStatus(db, w, "open", T0 + 10);
    expect(todosOf("resolve_blocked_work")).toEqual([]);
    expect(todosOf("execute_work").map((t) => t.target)).toContain(w);
  });

  it("S5 · **因 `ask_client` 而 blocked 的工作项不叫醒 PM**(那在等甲方)", () => {
    const w = mkWork({ id: "w_wait_client", status: "blocked" });
    mkBlocker("blk_wait_client", w, "high");
    mkOpenClientQuestion("q_wait");
    expect(
      todosOf("resolve_blocked_work"),
      "甲方还没回话 —— PM 叫醒也只能空转一轮(那件事由业务经理对甲方说)",
    ).toEqual([]);
    // ── 正样本:甲方**答了**之后,同一条工作项立刻回到 PM 的待办里 ──────
    // (库里那条 client_question 转 accepted 就是「球回来了」;这也是这个抑制
    //  **自愈**的机制:甲方答复 = 一条 user message ⇒ 门铃 + 10 秒兜底都会重查)
    db.prepare(`UPDATE artifacts SET status = 'accepted' WHERE id = 'q_wait'`).run();
    expect(todosOf("resolve_blocked_work").map((t) => t.refs[0])).toContain(w);
  });

  it("S5 边界 · 抑制要**两条同时成立**:裸 `blocked` 不因为项目里有个甲方提问就被压住", () => {
    mkOpenClientQuestion("q_unrelated");
    const bare = mkWork({ id: "w_bare2", status: "blocked" });
    expect(
      todosOf("resolve_blocked_work").map((t) => t.refs[0]),
      "没有登记阻塞 ⇒ 没人说得出它为什么卡住 —— 一次无关的甲方提问不许把它压成静默",
    ).toContain(bare);
    // 而挂了阻塞的那条确实被压住(同一次断言里的另一半,否则「包含」可能只是全都在)
    const withBlocker = mkWork({ id: "w_with_blocker", status: "blocked" });
    mkBlocker("blk_w2", withBlocker, "medium");
    const refs = todosOf("resolve_blocked_work")[0]!.refs;
    expect(refs).toContain(bare);
    expect(refs).not.toContain(withBlocker);
  });

  it("渲染:每一条被阻塞的工作项都带上**它的阻塞 id 与 severity**(结构化列,不读正文)", () => {
    const w = mkWork({ id: "w_render", status: "blocked", title: "对话链路改造" });
    mkBlocker("blk_render", w, "medium");
    const text = renderTask(db, todosOf("resolve_blocked_work")[0]!);
    expect(text).toContain("w_render");
    expect(text).toContain("对话链路改造");
    expect(text).toContain("blk_render");
    expect(text).toContain("medium");
    // 它必须说清「不挪回去它永远不会被跑」—— 否则 PM 解了阻塞却把工作项留在 blocked
    expect(text).toContain("不挪回去它永远不会被跑");
  });

  it("优先级:`resolve_blocked_work` 排在 `execute_work` **之前**(被卡住的活先修)", () => {
    mkWork({ id: "w_blocked", status: "blocked" });
    mkWork({ id: "w_free" });
    const order = board().runnable.map((t) => t.kind);
    expect(order.indexOf("resolve_blocked_work")).toBeLessThan(order.indexOf("execute_work"));
  });

  it("限流是**预算**,不是判据:PM 被叫若干次而目标不动 ⇒ 进 exhausted(可见,不静默)", async () => {
    mkWork({ id: "w_stuck", status: "blocked" });
    let pmRounds = 0;
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 2,
      runAgentTurn: async (agentId) => { if (agentId === "pm") pmRounds++; return okTurn; },
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(pmRounds, "预算 = 2,不是无限").toBe(2);
    expect(r.stopReason).toBe("no_progress");
    expect(r.newlyExhausted.map((t) => t.kind)).toEqual(["resolve_blocked_work"]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 丙② 容器终态由平台收口(经唯一写口)
// ══════════════════════════════════════════════════════════════════

describe("丙② · 整合成功后平台把容器置 `done`(唯一写口 `updateWorkStatus`)", () => {
  /** 假的项目经理:被叫醒整合时按提示词写出那条交付物。 */
  const pmWritesDeliverable = (agentId: string, task: string): void => {
    if (agentId !== "pm" || !task.startsWith("# 现在轮到你了:整合这条交付")) return;
    const roots = db
      .prepare(`SELECT id FROM works WHERE project_id = 'p1' AND parent_work_id IS NULL`)
      .all() as Array<{ id: string }>;
    for (const r of roots) mkDeliverable(`art_d_${r.id}`, r.id);
  };

  it("S6 · 根 `open` + 子树终态 → PM 整合 → 根被置 `done`(且走了状态机:review_state = pending)", async () => {
    const root = mkWork({ id: "R", title: "交付:选型建议" });
    mkReviewedDone({ id: "c1", parent: root });
    mkReviewedDone({ id: "c2", parent: root });
    expect(getWork(db, root)?.status).toBe("open");

    // 收口走的是**唯一写口**,所以 `review_state` 会跟着迁到 `pending` —— 在质检
    // 那个回合**开始之前**抓住这一刻(它随后就被 `markWorkReviewed` 置成 done 了)。
    let stateWhenQaWoke: string | null = null;
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async (agentId, task) => {
        pmWritesDeliverable(agentId, task);
        if (agentId === "qa") {
          stateWhenQaWoke = getWork(db, root)!.reviewState;
          // 021:质检必须显式给 pass 结论 —— 平台不再把「回合结束」当成「审过了」。
          // 少了这一行,这条工作项会留在 `pending` 被重审,本文件的断言就变成在测别的东西。
          insertReviewVerdict(db, {
            workId: root, projectId: "p1", verdict: "pass", severity: "low",
            findingArtifactId: null, note: "夹具:通过", reviewedBy: "qa", createdAt: T0 + 100,
          });
        }
        return okTurn;
      },
      runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
    });

    expect(r.visited.map((v) => `${v.agentId}:${v.kind}`)).toEqual([
      "pm:integrate",
      // ⚠️ **这条是丙②的已知后果,刻意钉在这里**(不许它悄悄变):
      // 平台**经唯一写口**把根置 done ⇒ `review_state` 跟着变成 `pending`
      // ⇒ 那条整合产物按既有的 `review_work` 规则被质检修一遍。
      // 想「跳过质检」就得另外调 `markWorkReviewed` —— 那是**另一条设计决定**
      // (谁审整合产物),不该由这一次收口顺手做掉。
      "qa:review_work",
    ]);
    const done = getWork(db, root)!;
    expect(done.status, "「整合完了」在 works 上必须有一个终态 —— 否则这条交付没人认领也没人宣布结束").toBe("done");
    expect(
      stateWhenQaWoke,
      "经唯一写口 ⇒ 状态机真的走了一步(`review_state` 跟着变),不是绕过 §2.7 直接 UPDATE",
    ).toBe("pending");
    expect(done.reviewState, "随后质检把它审掉(at-least-once 的正常收尾)").toBe("done");
    // 走的是唯一写口 ⇒ 根终态那条「向甲方交代」的 outbox 事件也在(§2.9 的写入侧)
    const events = db
      .prepare(`SELECT kind, subject_id FROM dispatch_events WHERE project_id = 'p1'`)
      .all() as Array<{ kind: string; subject_id: string }>;
    expect(events.some((e) => e.kind === "work_done" && e.subject_id === root)).toBe(true);
    // 而且**只收一次**:第二次排空不再整合、也不再收口
    const second = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(second.visited.map((v) => v.kind)).not.toContain("integrate");
  });

  it("S6 负样本 · **没写出交付物就不许收口** —— 「回合成功」不等于「整合成功」", async () => {
    const root = mkWork({ id: "R" });
    mkReviewedDone({ id: "c1", parent: root });
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 2,
      runAgentTurn: async () => okTurn, // ← 假经理什么都不做
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(r.visited.filter((v) => v.kind === "integrate")).toHaveLength(2);
    expect(
      getWork(db, root)?.status,
      "平台不许替模型宣布一件没发生的事(判据是工件,不是回合成不成)",
    ).toBe("open");
  });

  it("S6 · 产出边挂在**子项**上也算整合成功(与规则的判据 ③ 逐字同源,不各写一套)", async () => {
    const root = mkWork({ id: "R" });
    const kid = mkReviewedDone({ id: "c1", parent: root });
    mkDeliverable("art_on_kid", kid);
    await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(getWork(db, root)?.status).toBe("done");
  });

  it("根已经是 `done` 时收口是幂等的(不刷第二条 outbox 事件)", async () => {
    const root = mkReviewedDone({ id: "R" });
    mkReviewedDone({ id: "c1", parent: root });
    await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async (agentId, task) => { pmWritesDeliverable(agentId, task); return okTurn; },
      runWork: async () => { throw new Error("不该被调用"); },
    });
    const n = (
      db.prepare(
        `SELECT COUNT(*) n FROM dispatch_events WHERE subject_id = ? AND kind = 'work_done'`,
      ).get(root) as { n: number }
    ).n;
    expect(n, "done → done 不是迁移,不该再记一条").toBe(0);
  });
});
