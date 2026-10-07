/**
 * 兜底:项目「没人能动」且「没有交付」时,平台去问谁
 * (2026-10-07 补;判据由用户那句「一段时间内没有任何角色在干活」改写而成)
 *
 * ── 这一批补的是两个**真空** ─────────────────────────────────────
 *
 *   ① **账本到顶在规则表里零读者**。平台按 `(项目, 待办)` 记账,叫醒到上限就停,
 *      并播一条一次性的 `system` 通知(`notified_at` 保证只播一次)—— **然后就永久静默**,
 *      而人不知道下一步该做什么。真机 2026-10-07 那个静默死锁就是踩着这个真空走出来的
 *      (那条 `review_work` 预算 3/3 用尽 ⇒ 质检再也不会被叫醒 ⇒ pass 没人消费)。
 *   ② **「工作项全终结 + 零已验收交付物」一条规则都不成立**:
 *      `close_finished_project` 的资格判据要求「已验收交付物 ≥ 1」,
 *      `handover` 的资格判据是「有一份**已验收**的 deliverable」⇒ 这里两条都不成立,
 *      项目永远 `active` 且无人被叫醒。真机形态见 AGENTS 那句
 *      「11 条全 done 而甲方要的那一份并不存在」。
 *
 * ── ⚠️ 判据**不用墙钟**(这是与用户原话唯一的偏差点,理由写在代码里)──────
 *
 * 「安静了多久」要在「真的干完了」与「卡住了」之间猜,而这条边界上真机踩过两次
 * (批次 20 的 `stallStore` 因「指纹漏一类状态 ⇒ 把真实进展读成无进展 ⇒ 掐死整条链」
 * 被整块删除;`runningTurns` 是宿主内存的忙闩,重启即清零)。库里已经有一份
 * **不需要猜**的记录:账本 + `notified_at`。而「干完了」的待办**根本没有那一行**。
 *
 * 所以本文件的用例几乎全在钉**误报方向** —— 兜底规则最大的风险不是不响,是乱响。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertWork, markWorkReviewed, updateWorkStatus, type WorkStatus,
} from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertReviewVerdict } from "../../src/platform/storage/repo/reviewVerdicts.js";
import { insertBlocker } from "../../src/platform/storage/repo/blockers.js";
import {
  bumpAttempt, listPendingDispatchEvents, markAttemptNotified,
} from "../../src/platform/storage/repo/dispatch.js";
import {
  collectTodos, renderTask, RULES, type DriverTodo,
} from "../../src/platform/runtime/dispatcher.js";

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

let artSeq = 0;
function mkArtifact(over: {
  kind?: string; status?: string; workId?: string | null; author?: string; at?: number;
} = {}): string {
  const id = `art_${++artSeq}`;
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null,
    kind: (over.kind ?? "evidence") as "evidence",
    status: (over.status ?? "open") as "open",
    authorAgentId: over.author ?? "wk", title: `工件 ${id}`,
    ...bodyAt(`artifacts/${id}.md`, "正文"),
    metadataJson: null, createdAt: over.at ?? T0 + 100, updatedAt: over.at ?? T0 + 100,
    workId: over.workId ?? null,
    ...(over.kind === "deliverable" ? { deliverableType: "html_report" as const } : {}),
  });
  return id;
}

function mkWork(over: {
  id?: string; parent?: string | null; status?: WorkStatus; reviewed?: boolean;
} = {}): string {
  const id = over.id ?? `wk_${++seq}`;
  insertWork(db, {
    id, projectId: "p1", parentWorkId: over.parent ?? null, title: `工作项 ${id}`,
    goal: "写出结论", status: over.status ?? "open", assigneeAgentId: "wk",
    createdAt: T0 + seq, updatedAt: T0 + seq,
  });
  if (over.reviewed === true) markWorkReviewed(db, id, T0 + 500);
  return id;
}

/** 把一条待办的账本推到「平台已经放弃并播报过」的那一格。 */
function abandon(todoKey: string, attempts = 3): void {
  for (let i = 0; i < attempts; i++) {
    bumpAttempt(db, { projectId: "p1", todoKey, targetState: null, at: T0 + 600 + i });
  }
  markAttemptNotified(db, "p1", todoKey, T0 + 700);
}

const board = (now = T0 + 10_000) => collectTodos({ db, projectId: "p1", now });
const todoOf = (kind: string, now = T0 + 10_000): DriverTodo | undefined =>
  board(now).runnable.find((t) => t.kind === kind);

// ══════════════════════════════════════════════════════════════════
// ① 账本到顶 ⇒ 换个人来处置(不是「再叫一次」)
// ══════════════════════════════════════════════════════════════════

describe("① `escalate_stalled_work`:平台已经不再叫醒它了 ⇒ 换手给项目经理", () => {
  it("**质检的待办被放弃 ⇒ 叫醒 PM**(真机那次就是这个形状)", () => {
    // 真机:根工作项 done + review_state=pending ⇒ 质检那条待办被叫到上限
    const w = mkWork({ id: "W", status: "done" });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    abandon(`review_work:${w}`);
    const t = todoOf("escalate_stalled_work");
    expect(t, "账本到顶必须有人接手 —— 此前这一格无人被叫醒").toBeDefined();
    expect(t?.agentId).toBe("pm");
    expect(t?.refs).toEqual([`review_work:${w}`]);
    expect(t?.key).toBe(`escalate_stalled_work:review_work:${w}`);
  });

  it("**只计数器到顶但平台没停在那里 ⇒ 不叫**(判据是 `notified_at`,不是 attempts)", () => {
    // 这一条钉的是**误报**:`attempts` 可能在同一轮里已经被别的机制解决掉了
    // (待办消失 ⇒ 账本作废),而 `notified_at` 只在「排空器真的停在那里」时才写。
    const w = mkWork({ id: "W", status: "done" });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    for (let i = 0; i < 3; i++) {
      bumpAttempt(db, { projectId: "p1", todoKey: `review_work:${w}`, targetState: null, at: T0 + 600 + i });
    }
    expect(board().exhausted.map((t) => t.kind)).toContain("review_work"); // 确实到顶了
    expect(todoOf("escalate_stalled_work"), "到顶≠平台停在那里 ⇒ 不许喊").toBeUndefined();
  });

  it("**项目经理自己的活被放弃 ⇒ 不叫 PM**(叫第四次不会有不同的结果)", () => {
    // `recover_failed_work` / `decompose_project` 的 owner 就是 PM。机械读规则表的
    // `then.targetRole`,不另写一份名单 —— 这是「换人」语义的判据本身。
    mkWork({ id: "F", status: "failed" });
    abandon("recover_failed_work:F");
    expect(todoOf("escalate_stalled_work")).toBeUndefined();
  });

  it("**升级待办自己不再触发升级**(否则是无限链)", () => {
    abandon("escalate_stalled_work:review_work:W", 3);
    expect(todoOf("escalate_stalled_work")).toBeUndefined();
  });

  it("任务正文只摆事实:哪几条 / 属于谁,不复述内容", () => {
    const w = mkWork({ id: "W", status: "done" });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    abandon(`review_work:${w}`);
    const task = renderTask(db, todoOf("escalate_stalled_work")!);
    expect(task).toContain(`review_work:${w}`);
    expect(task).toContain("review_work");
    expect(task, "要给出可执行的四条处置,而不是「再跑一遍」").toContain("改派");
    expect(task).not.toContain("正文");
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 全终结 + 零已验收交付物 ⇒ 业务经理判断
// ══════════════════════════════════════════════════════════════════

describe("② `review_undelivered_project`:全终结而没有交付物 ⇒ 业务经理判断", () => {
  it("**正样本**:工作项全终结、零已验收交付物 ⇒ 叫醒业务经理", () => {
    const w = mkWork({ id: "W", status: "done", reviewed: true });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    const t = todoOf("review_undelivered_project");
    expect(t, "这一格此前**一条规则都不成立**(收口要 ≥1 交付物、交付要有已验收交付物)").toBeDefined();
    expect(t?.agentId).toBe("bm");
    expect(t?.key).toBe("review_undelivered_project:p1");
  });

  it("**全终结 + 连一份交付物都没有(但还有根能被整合)⇒ 不叫**(PM 马上会去写)", () => {
    const root = mkWork({ id: "R", status: "done", reviewed: true });
    mkWork({ id: "c1", parent: root, status: "done", reviewed: true });
    expect(todoOf("review_undelivered_project"), "integrate 正在接手 ⇒ 不是安静").toBeUndefined();
    expect(todoOf("integrate"), "自检:这条根确实可以被整合").toBeDefined();
  });

  it("**已验收交付物在 ⇒ 不叫**(那是 handover / 收口的活)", () => {
    const w = mkWork({ id: "W", status: "done", reviewed: true });
    mkArtifact({ workId: w, kind: "deliverable", status: "accepted", author: "pm" });
    expect(todoOf("review_undelivered_project")).toBeUndefined();
  });

  it("**还有人在跑 / 还有待审 ⇒ 不叫**(对着活着的流水线喊 = 误报)", () => {
    const done = mkWork({ id: "W1", status: "done", reviewed: true });
    mkArtifact({ workId: done, kind: "deliverable", status: "open", author: "wk" });
    const w2 = mkWork({ id: "W2", status: "in_progress" });
    // W2 也要有自己的产出:否则它是一条**可以被整合**的根,`integrate` 会接手,
    // 兜底本来就该让位(这条抑制是另一条用例钉的)。
    mkArtifact({ workId: w2, kind: "deliverable", status: "open", author: "wk" });
    expect(todoOf("review_undelivered_project"), "非终态工作项 > 0").toBeUndefined();
    // 自检:W2 一终结,它立刻出现(证伪「规则整体不工作」)
    db.prepare(`UPDATE works SET status='done', review_state='done' WHERE id='W2'`).run();
    expect(todoOf("review_undelivered_project")).toBeDefined();
  });

  it("**outbox 里还有未消费的事件 ⇒ 不叫**(业务经理马上会因为下游结果被叫)", () => {
    const w = mkWork({ id: "W", status: "done", reviewed: true });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    // 一次状态迁移会写 outbox(`updateWorkStatus` 写 `work_done`)
    const w2 = mkWork({ id: "W2", status: "done", reviewed: true });
    mkArtifact({ workId: w2, kind: "deliverable", status: "open", author: "wk" });
    // ⚠️ 事件必须走**唯一的写口**(`updateWorkStatus`):裸 SQL 改 status **不写 outbox**
    // —— 本用例第一版就是这么红的(它假装有一条事件,其实一条也没有)。
    updateWorkStatus(db, "W2", "in_progress", T0 + 700);
    updateWorkStatus(db, "W2", "done", T0 + 750);
    expect(listPendingDispatchEvents(db, "p1").length, "自检:确实有一条未消费事件").toBeGreaterThan(0);
    expect(todoOf("review_undelivered_project"), "有未消费事件 ⇒ 球在业务经理那边").toBeUndefined();
    // 自检:事件被消费、且那条 done 也审过之后它才出现
    // (`updateWorkStatus` 迁入 done 会把 `review_state` 置成 `pending` —— 那期间
    //  挡着兜底的是 `review_work`,不是 outbox;两条抑制条件都得松开才算「安静」。)
    db.prepare(`UPDATE dispatch_events SET consumed_at = ?, consumed_by = 'bm'`).run(T0 + 8000);
    markWorkReviewed(db, "W2", T0 + 8100);
    expect(todoOf("review_undelivered_project")).toBeDefined();
  });

  it("**有未解决阻塞 ⇒ 不叫**(项目不是「安静」,那件事有人要处置)", () => {
    const w = mkWork({ id: "W", status: "done", reviewed: true });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    insertBlocker(db, {
      id: "b1", projectId: "p1", raisedByAgentId: "wk", title: "缺依赖", detail: "d",
      severity: "low", status: "open", createdAt: T0 + 700,
    });
    expect(todoOf("review_undelivered_project")).toBeUndefined();
  });

  it("**项目已收口 ⇒ 不叫**(终止判据落在 `projects.status` 上,重启后不会被叫活)", () => {
    const w = mkWork({ id: "W", status: "done", reviewed: true });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    db.prepare(`UPDATE projects SET status='done' WHERE id='p1'`).run();
    expect(todoOf("review_undelivered_project")).toBeUndefined();
  });

  it("**空项目 ⇒ 不叫**(那是拆解的活)", () => {
    expect(todoOf("review_undelivered_project")).toBeUndefined();
    expect(todoOf("decompose_project")).toBeDefined();
  });

  it("任务正文如实给出三件事:状态 / 为什么两条规则都不成立 / 三个判断", () => {
    const w = mkWork({ id: "W", status: "done", reviewed: true });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    const task = renderTask(db, todoOf("review_undelivered_project")!);
    expect(task).toContain("已验收交付物 = 0");
    expect(task).toContain("收口的判据不成立");
    expect(task, "要如实告诉甲方「这个项目没有可交付的东西」这一条").toContain("告诉甲方");
  });
});

// ══════════════════════════════════════════════════════════════════
// ③ 两条兜底与既有规则的分工(避免「两份定义」)
// ══════════════════════════════════════════════════════════════════

describe("③ 与既有规则的分工", () => {
  it("两条兜底都在规则表里,各带 kind / on / why,且 `on` 含 tick", () => {
    for (const id of ["escalate_abandoned_todo", "review_undelivered_project"]) {
      const r = RULES.find((x) => x.id === id);
      expect(r, `规则表里没有 ${id}`).toBeDefined();
      expect(r?.on).toContain("tick");
      expect(r?.why.length).toBeGreaterThan(100);
    }
    expect(RULES.find((x) => x.id === "escalate_abandoned_todo")?.then.kind)
      .toBe("escalate_stalled_work");
    expect(RULES.find((x) => x.id === "review_undelivered_project")?.then.kind)
      .toBe("review_undelivered_project");
  });

  it("**兜底与常规规则互斥**:还有人在动(待审 / 可整合 / 待交付)时它就不出现", () => {
    // 这是「安静」那条判据的真性质,也是本批最容易写错的地方:兜底最大的风险不是
    // 不响,是**对着一条活着的流水线喊**。逐个把「有人在动」的三种形态摆出来。
    const w = mkWork({ id: "W", status: "done" });              // 待审(review_work)
    expect(todoOf("review_work"), "自检:质检那条确实在").toBeDefined();
    expect(todoOf("review_undelivered_project")).toBeUndefined();

    markWorkReviewed(db, "W", T0 + 900);                        // 审完 ⇒ 可以被整合
    expect(todoOf("integrate"), "自检:整合那条确实在").toBeDefined();
    expect(todoOf("review_undelivered_project")).toBeUndefined();

    // 整合完(交出**已验收**的交付物)⇒ 轮到 handover,仍不是兜底
    mkArtifact({ workId: w, kind: "deliverable", status: "accepted", author: "pm" });
    expect(todoOf("handover"), "自检:交付那条确实在").toBeDefined();
    expect(todoOf("review_undelivered_project")).toBeUndefined();

  });

  it("**兜底不读正文**(只读结构化列:账本 / 状态 / 计数)", () => {
    // 判据:把一条**正文里有陷阱**的工件放进去,兜底的输出一个字节都不变。
    const w = mkWork({ id: "W", status: "done", reviewed: true });
    mkArtifact({ workId: w, kind: "deliverable", status: "open", author: "wk" });
    const before = board().runnable.map((t) => t.key).sort();
    mkArtifact({ kind: "note", status: "accepted", author: "pm" });
    expect(board().runnable.map((t) => t.key).sort()).toEqual(before);
  });
});
