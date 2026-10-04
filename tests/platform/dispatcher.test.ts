/**
 * 排空器 · 测试(批次 21:取代 `driver.test.ts` 的有状态级联)
 *
 * ── 这一层最要紧的性质 ──────────────────────────────────────────
 *
 *   ① **判定是纯查询**:`collectTodos(db, projectId, now)` 的入参里没有任何
 *      「上次发生了什么」,所以下面每个断言都能只靠库里的行复现 ——
 *      测试里也确实没有任何需要跨调用传递的状态对象。
 *   ② **它一定会停**:没有待办 → 停;撞硬上界 → 停(且不静默);同一条待办
 *      反复叫醒而目标不动 → 预算用尽后停(库里的账本,重启后仍然算数)。
 *   ③ **不丢活**:下游事件与「等待审查」都在库里,所以撞上界 / 进程重启之后
 *      照样查得出来 —— 批次 20 的三个真机洞就在这里被钉住。
 *
 * 假 provider 是刻意的:`drainProject` 的职责是**编排**(谁该动、动哪个、什么
 * 时候停),不是「跟模型说话」。真模型那条路由真机端到端覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformDb, openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember, removeMember } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertWork, getWork, updateWorkStatus, listWorksPendingReview,
} from "../../src/platform/storage/repo/works.js";
import {
  listPendingDispatchEvents, consumePendingDispatchEvents,
} from "../../src/platform/storage/repo/dispatch.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertAsk, answerAsk } from "../../src/platform/storage/repo/asks.js";
import { insertChange } from "../../src/platform/storage/repo/changes.js";
import { insertBlocker, setBlockerStatus } from "../../src/platform/storage/repo/blockers.js";
import { insertMeeting, respondToMeeting } from "../../src/platform/storage/repo/meetings.js";
import {
  collectPendingWork, hasActionableWork, renderPendingWork,
} from "../../src/platform/runtime/pendingWork.js";
import {
  collectTodos, drainProject, renderTask,
  type DrainTurnReport, type DrainWorkReport,
} from "../../src/platform/runtime/dispatcher.js";
import {
  renderProjectContext,
} from "../../src/platform/runtime/projectContext.js";

let db: Database.Database;
const T0 = 1_700_000_000_000;
let seq = 0;
const newId = (p: string) => `${p}_${++seq}`;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "语音机器人调研", client: "甲方",
    goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
});
afterEach(() => db.close());

function mkWork(over: {
  id?: string; title?: string; assignee?: string; status?: "open" | "in_progress" | "done";
} = {}): string {
  const id = over.id ?? newId("wk");
  insertWork(db, {
    id, projectId: "p1", parentWorkId: null,
    title: over.title ?? "调研路线 A", goal: "写出对比结论",
    status: over.status ?? "open",
    assigneeAgentId: over.assignee ?? "wk",
    createdAt: T0, updatedAt: T0,
  });
  return id;
}

function mkArtifact(id: string, authorAgentId = "wk"): void {
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null,
    kind: "evidence", status: "open", authorAgentId,
    title: id, body: "现场", metadataJson: null,
    createdAt: T0 + 1, updatedAt: T0 + 1,
  });
}

/**
 * 待办快照。**判定函数就是 `collectTodos`**(纯查询),测试不再另要一个入口 ——
 * 免得生产代码里留一个只有测试读的函数(「没有读者的逻辑」是这个项目的常客)。
 */
const board = (projectId = "p1", now = T0) => collectTodos({ db, projectId, now });

const okTurn: DrainTurnReport = {
  aborted: false, timedOut: false, text: "好了", toolCalls: [],
};

// ── ① 每个角色的可执行待办 ──────────────────────────────────────

describe("collectPendingWork · 分派给我的工作项", () => {
  it("派给 worker 的 open 工作项出现在 myOpenWorks 里", () => {
    const w = mkWork();
    const pw = collectPendingWork(db, "wk", "p1", T0);
    expect(pw.myOpenWorks.map((x) => x.id)).toEqual([w]);
    expect(pw.role).toBe("worker");
  });

  it("前置没满足的工作项进 myWaitingWorks,不算可开工", () => {
    const dep = mkWork({ title: "上游" });
    const downstream = mkWork({ title: "下游" });
    db.prepare(`INSERT INTO work_deps (work_id, depends_on_work_id) VALUES (?, ?)`).run(downstream, dep);

    const pw = collectPendingWork(db, "wk", "p1", T0);
    expect(pw.myOpenWorks.map((x) => x.id)).toEqual([dep]);
    expect(pw.myWaitingWorks.map((x) => x.id)).toEqual([downstream]);
    updateWorkStatus(db, dep, "done", T0 + 1);
    expect(collectPendingWork(db, "wk", "p1", T0 + 2).myOpenWorks.map((x) => x.id)).toEqual([downstream]);
  });

  it("只有工作项算不算 actionable —— 算,而且只有 worker 算", () => {
    mkWork();
    expect(hasActionableWork(collectPendingWork(db, "wk", "p1", T0))).toBe(true);
    // 同一条工作项派给项目经理:他不持 code.*,平台也不该叫他去执行
    mkWork({ assignee: "pm" });
    expect(hasActionableWork(collectPendingWork(db, "pm", "p1", T0))).toBe(false);
  });

  it("项目一个工作项都没有 → 只有项目经理的 needsDecomposition 为真", () => {
    expect(collectPendingWork(db, "pm", "p1", T0).needsDecomposition).toBe(true);
    expect(collectPendingWork(db, "bm", "p1", T0).needsDecomposition).toBe(false);
    expect(collectPendingWork(db, "qa", "p1", T0).needsDecomposition).toBe(false);
    mkWork();
    expect(collectPendingWork(db, "pm", "p1", T0).needsDecomposition).toBe(false);
  });

  it("非 active 项目不要求拆解 —— paused 的项目不该被自动开工", () => {
    db.prepare(`UPDATE projects SET status = 'paused' WHERE id = 'p1'`).run();
    expect(collectPendingWork(db, "pm", "p1", T0).needsDecomposition).toBe(false);
  });
});

describe("hasActionableWork · 按角色的 ceiling 过滤", () => {
  it("proposed 变更是待办 —— 但对业务经理不是(他只有 change.read)", () => {
    insertChange(db, {
      id: "c1", projectId: "p1", title: "加字段", rationale: "r",
      impactJson: null, createdAt: T0,
    });
    const bm = collectPendingWork(db, "bm", "p1", T0);
    expect(bm.pendingChanges).toHaveLength(1);
    expect(hasActionableWork(bm)).toBe(false);
    expect(hasActionableWork(collectPendingWork(db, "pm", "p1", T0))).toBe(true);
    expect(hasActionableWork(collectPendingWork(db, "qa", "p1", T0))).toBe(true);
  });

  it("角色读不出来时不猜 —— 退回「库里挂着就算」的宽判", () => {
    insertChange(db, {
      id: "c1", projectId: "p1", title: "加字段", rationale: "r",
      impactJson: null, createdAt: T0,
    });
    const pw = { ...collectPendingWork(db, "pm", "p1", T0), role: null };
    expect(hasActionableWork(pw)).toBe(true);
  });
});

// ── 判定:纯查询 ────────────────────────────────────────────────

describe("collectTodos · 谁此刻能动手(纯查询,不接收任何「上次发生了什么」)", () => {
  it("空项目 → 只有项目经理的那一条「拆解」", () => {
    const b = board("p1", T0);
    expect(b.runnable).toHaveLength(1);
    expect(b.runnable[0]).toMatchObject({ agentId: "pm", kind: "decompose_project" });
    expect(b.exhausted).toEqual([]);
  });

  it("有人提问 → answer_ask 排在最高优先级(有人 block 着)", () => {
    mkWork();
    insertAsk(db, {
      id: "a1", projectId: "p1", fromAgentId: "wk", toAgentId: "pm",
      question: "走 A 还是 B?", hypothesis: "我倾向 A", createdAt: T0,
    });
    const todos = board("p1", T0).runnable;
    expect(todos[0]).toMatchObject({ agentId: "pm", kind: "answer_ask" });
    expect(todos.map((t) => t.kind)).toContain("execute_work");
    expect(todos.findIndex((t) => t.kind === "answer_ask"))
      .toBeLessThan(todos.findIndex((t) => t.kind === "execute_work"));
  });

  it("worker 的工作项 → execute_work 且带目标 id", () => {
    const w = mkWork();
    const t = board("p1", T0).runnable.find((x) => x.kind === "execute_work");
    expect(t).toMatchObject({ agentId: "wk", target: w, key: `execute_work:${w}` });
    expect(t?.targetState).toBe(T0);
  });

  it("**等待审查是库里的状态**:done 的工作项就是质检的待办(不再依赖级联事件)", () => {
    const w = mkWork({ status: "done" });
    expect(getWork(db, w)?.reviewState).toBe("pending");
    const t = board("p1", T0).runnable.find((x) => x.kind === "review_work");
    expect(t).toMatchObject({ agentId: "qa", refs: [w] });
  });

  it("审查过的产出不再是待办(`review_state='done'`)", () => {
    const w = mkWork({ status: "done" });
    expect(listWorksPendingReview(db, "p1").map((x) => x.id)).toEqual([w]);
    db.prepare(`UPDATE works SET review_state = 'done' WHERE id = ?`).run(w);
    expect(board("p1", T0).runnable.some((t) => t.kind === "review_work")).toBe(false);
  });

  it("下游事件是业务经理的待办 —— 由 outbox 查出来,不是级联观察到的", () => {
    mkWork();
    // 库里还没有事件 → 业务经理没有待办
    expect(board("p1", T0).runnable.some((t) => t.kind === "report_downstream")).toBe(false);
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 5);
    const t = board("p1", T0 + 6).runnable.find((x) => x.kind === "report_downstream");
    expect(t).toMatchObject({ agentId: "bm" });
    expect(t?.label).toContain("1 条结果");
    // 消费之后就不再是待办
    consumePendingDispatchEvents(db, "p1", "bm", T0 + 7);
    expect(listPendingDispatchEvents(db, "p1")).toEqual([]);
    expect(board("p1", T0 + 8).runnable.some((t) => t.kind === "report_downstream")).toBe(false);
  });

  it("新登记的阻塞也是下游事件(甲方该知道)", () => {
    insertBlocker(db, {
      id: "b1", projectId: "p1", raisedByAgentId: "wk", title: "缺依赖", detail: "d",
      severity: "high", status: "open", createdAt: T0,
    });
    const events = listPendingDispatchEvents(db, "p1");
    expect(events.map((e) => e.kind)).toEqual(["blocker_opened"]);
    expect(events[0]?.summary).toContain("缺依赖");
  });

  it("不在项目里的人不会被派活", () => {
    db.prepare(`UPDATE project_assignments SET removed_at = ? WHERE agent_id = 'wk'`).run(T0 + 1);
    mkWork();
    expect(board("p1", T0 + 2).runnable.some((t) => t.agentId === "wk")).toBe(false);
  });

  it("派给非 worker 的存量工作项 → 叫醒派活的人去处置(真机现场的自愈路径)", () => {
    mkWork({ assignee: "bm", title: "与甲方对齐业务场景" });
    const t = board("p1", T0).runnable.find((x) => x.kind === "fix_work_assignment");
    expect(t).toMatchObject({ agentId: "pm" });
    expect(t?.label).toContain("1 条没人能执行");
    expect(renderTask(db, t!)).toContain("与甲方对齐业务场景");
  });
});

// ── ② 一定会停 ──────────────────────────────────────────────────

describe("drainProject · 没有待办就什么都不做", () => {
  it("拆过、没有指派、没有提问 → 0 回合 exhausted", async () => {
    mkWork({ status: "done" });
    // 把 review 也消掉(否则质检那条是待办)
    db.prepare(`UPDATE works SET review_state = 'done'`).run();
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(r.rounds).toBe(0);
    expect(r.stopReason).toBe("exhausted");
  });
});

describe("drainProject · 尝试预算(库里的账本,取代内存 stallStore)", () => {
  it("同一条待办被叫醒到预算上限就停 —— 不再无限重叫(不烧 token)", async () => {
    // 项目零工作项 → 项目经理的 decompose 待办。假回合**什么都不做**。
    let called = 0;
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 2,
      runAgentTurn: async () => { called++; return okTurn; },
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(called).toBe(2); // 预算是 2,不是无限
    expect(r.rounds).toBe(2);
    expect(r.stopReason).toBe("no_progress");
    // 如实说是**哪一条**待办卡住了(不是一句笼统的「没有进展」)
    expect(r.stopDetail).toContain("把项目拆成工作项");
    expect(r.newlyExhausted.map((t) => t.kind)).toEqual(["decompose_project"]);
    expect(r.exhausted.map((t) => t.kind)).toEqual(["decompose_project"]);
  });

  it("**跨排空**记忆:第二次排空不会再叫一遍(预算在库里,不在内存里)", async () => {
    let called = 0;
    const deps = {
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 1,
      runAgentTurn: async (): Promise<DrainTurnReport> => { called++; return okTurn; },
      runWork: async (): Promise<DrainWorkReport> => { throw new Error("不该被调用"); },
    };
    const first = await drainProject(deps);
    expect(first.rounds).toBe(1);
    const second = await drainProject(deps);
    expect(second.rounds).toBe(0);
    expect(second.stopReason).toBe("no_progress");
    expect(called).toBe(1);
    // 已经报过一次 → 这一次不再重复广播(宿主据此不刷 system 消息)
    expect(second.newlyExhausted).toEqual([]);
    expect(second.exhausted).toHaveLength(1);
  });

  it("目标真的动了就重新给预算 —— 不会把正在推进的事掐死", async () => {
    let n = 0;
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxAttemptsPerTodo: 1,
      runAgentTurn: async (): Promise<DrainTurnReport> => {
        const count = (db.prepare(`SELECT COUNT(*) AS n FROM works`).get() as { n: number }).n;
        if (count === 0) {
          n++;
          insertWork(db, {
            id: `wk_${n}`, projectId: "p1", parentWorkId: null, title: "t", goal: "g",
            status: "open", assigneeAgentId: "wk", createdAt: T0 + n, updatedAt: T0 + n,
          });
        }
        return okTurn;
      },
      runWork: async (_agentId, workId): Promise<DrainWorkReport> => {
        updateWorkStatus(db, workId, "done", T0 + 1);
        mkArtifact(`art_${++n}`);
        return {
          workId, title: "t", status: "done",
          aborted: false, timedOut: false, text: "做完了", toolCalls: [],
        };
      },
    });
    // 待办换了一条就换了一个 key → 新预算:pm 拆解 → wk 执行 → qa 审查 → bm 汇报
    expect(r.visited.map((v) => v.agentId)).toEqual(["pm", "wk", "qa", "bm"]);
    expect(r.reportedToClient).toBe(true);
    expect(r.stopReason).toBe("exhausted");
  });
});

describe("drainProject · 硬上界(烧 token 的闸)", () => {
  /**
   * 「永远有活」的假组织:拆一个 → 做完一个 → 又出现一个。
   * 每一回合都真的产生了状态变化,所以能拦住它的只有 `maxRounds`。
   */
  function foreverBusyDeps(maxRounds?: number) {
    let n = 0;
    const mk = (assignee: string) => {
      n++;
      insertWork(db, {
        id: `wk_x${n}`, projectId: "p1", parentWorkId: null, title: "t", goal: "g",
        status: "open", assigneeAgentId: assignee, createdAt: T0 + n, updatedAt: T0 + n,
      });
    };
    return {
      db, projectId: "p1", now: () => T0, log: () => {},
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      runAgentTurn: async (): Promise<DrainTurnReport> => {
        if ((db.prepare(`SELECT COUNT(*) AS n FROM works`).get() as { n: number }).n === 0) {
          mk("wk");
        }
        return okTurn;
      },
      runWork: async (_agentId: string, workId: string): Promise<DrainWorkReport> => {
        updateWorkStatus(db, workId, "done", T0 + n);
        mk("wk"); // 又冒出来一个新活
        return {
          workId, title: "t", status: "done",
          aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    };
  }

  it("maxRounds 到界就停,并**如实报出来**(不静默)", async () => {
    const r = await drainProject(foreverBusyDeps(2));
    expect(r.rounds).toBe(2);
    expect(r.stopReason).toBe("max_rounds");
    expect(r.stopDetail).toContain("上限 2");
  });

  it("默认上界是 8 —— 保守,但存在", async () => {
    const r = await drainProject(foreverBusyDeps());
    expect(r.rounds).toBe(8);
    expect(r.stopReason).toBe("max_rounds");
  });

  it("用户中断 → cancelled(不再往下跑)", async () => {
    let cancelled = false;
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      isCancelled: () => cancelled,
      runAgentTurn: async () => {
        cancelled = true;
        return { ...okTurn, aborted: true };
      },
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(r.rounds).toBe(1);
    expect(r.stopReason).toBe("cancelled");
  });

  it("某个角色的回合抛错不炸掉整条链 —— 后面的角色照样能动", async () => {
    mkWork();
    const visited: string[] = [];
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async (agentId) => {
        visited.push(agentId);
        if (agentId === "pm") throw new Error("会话建不出来");
        return okTurn;
      },
      runWork: async (agentId, workId) => {
        visited.push(agentId);
        updateWorkStatus(db, workId, "done", T0 + 1);
        return {
          workId, title: "t", status: "done",
          aborted: false, timedOut: false, text: "done", toolCalls: [],
        };
      },
    });
    expect(visited).toContain("wk");
    expect(r.visited.length).toBeGreaterThan(0);
  });

  it("卡住一条待办不拖停别人 —— 预算按待办逐条记账,不再需要专门的补丁", async () => {
    // 唯一能跑的那条(worker 执行)先被叫到预算用尽;另一条(有人问 pm)照跑
    const w = mkWork();
    insertAsk(db, {
      id: "a_skip", projectId: "p1", fromAgentId: "wk", toAgentId: "pm",
      question: "走 A 还是 B?", hypothesis: "我倾向 A", createdAt: T0,
    });
    // 人为把 worker 那条的预算用尽(等价于「它被叫过 1 次且目标没动」)
    db.prepare(
      `INSERT INTO dispatch_attempts (project_id, todo_key, attempts, target_state,
                                      first_attempt_at, last_attempt_at, notified_at)
       VALUES ('p1', ?, 3, ?, ?, ?, NULL)`,
    ).run(`execute_work:${w}`, T0, T0, T0);

    const visited: string[] = [];
    let n = 0;
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async (agentId): Promise<DrainTurnReport> => {
        visited.push(agentId);
        answerAsk(db, "a_skip", T0 + 1, null);
        mkArtifact(`art_skip${++n}`);
        return okTurn;
      },
      runWork: async (_a: string, workId: string): Promise<DrainWorkReport> => {
        visited.push(`runWork:${workId}`);
        updateWorkStatus(db, workId, "done", T0 + 9);
        return {
          workId, title: "t", status: "done",
          aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    });
    // pm 那条照跑;worker 那条在整个排空里一次都没被叫醒
    expect(visited).toEqual(["pm"]);
    // 剩下的唯一待办预算已用尽 → 停,但那是**它自己**的预算,不是整条链被拖停
    expect(r.stopReason).toBe("no_progress");
    expect(r.exhausted.map((t) => t.kind)).toEqual(["execute_work"]);
  });
});

// ── 下游结果与审查的消费(第 ④ 条的地基)────────────────────────

describe("drainProject · 消费语义(at-least-once)", () => {
  it("工作项 done → 质检审 → 业务经理汇报一次,且两边都被消费掉", async () => {
    const w = mkWork();
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async (_agentId, workId) => {
        updateWorkStatus(db, workId, "done", T0 + 1);
        mkArtifact("art_1");
        return {
          workId, title: "调研路线 A", status: "done",
          aborted: false, timedOut: false, text: "结论见工件", toolCalls: [],
        };
      },
    });
    expect(r.visited.map((v) => `${v.agentId}:${v.kind}`)).toEqual([
      "wk:execute_work", "qa:review_work", "bm:report_downstream",
    ]);
    expect(r.reportedToClient).toBe(true);
    expect(listPendingDispatchEvents(db, "p1")).toEqual([]);
    expect(listWorksPendingReview(db, "p1")).toEqual([]);
    expect(getWork(db, w)?.reviewState).toBe("done");
  });

  it("质检回合**失败**就不消费 —— 下次排空重来(不静默漏审)", async () => {
    mkWork({ status: "done" });
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async (agentId): Promise<DrainTurnReport> => {
        if (agentId === "qa") {
          return { aborted: false, timedOut: false, text: "", toolCalls: [], failed: true };
        }
        return okTurn;
      },
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(r.visited.map((v) => v.kind)).toContain("review_work");
    expect(listWorksPendingReview(db, "p1")).toHaveLength(1);
  });

  it("业务经理回合失败就不消费事件 —— 做完了不会没人汇报", async () => {
    const w = mkWork();
    await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxRounds: 1,
      runAgentTurn: async () => okTurn,
      runWork: async (_agentId, workId) => {
        updateWorkStatus(db, workId, "done", T0 + 1);
        mkArtifact("art_1");
        return {
          workId, title: "t", status: "done", aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    });
    // 只跑了 1 回合(wk 执行)→ 事件还在,下一次排空会汇报
    expect(listPendingDispatchEvents(db, "p1")).toHaveLength(1);
    const r2 = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(r2.visited.map((v) => v.agentId)).toEqual(["qa", "bm"]);
    expect(listPendingDispatchEvents(db, "p1")).toEqual([]);
  });
});

// ── 重启后补跑(把「等待审查」建成可查询状态的验收)──────────────

describe("排空器 · 重启后补跑(状态在库里)", () => {
  const dir = join(import.meta.dirname, "../../.tmp-dispatcher-test");
  const path = join(dir, "platform.db");

  it("进程重启后,没被审完的工作项照样被捡起来", async () => {
    rmSync(dir, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });

    // ── 第一个进程:工作项被做完(审查态 = pending),但只跑了 1 回合就被截断 ──
    const db1 = openPlatformDb(path);
    insertProject(db1, {
      id: "p1", name: "调研", client: "甲方", goal: "g", status: "active", createdAt: T0,
    });
    ensureProjectOrg(db1, "p1", T0);
    insertWork(db1, {
      id: "w1", projectId: "p1", parentWorkId: null, title: "调研", goal: "g",
      status: "open", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    const first = await drainProject({
      db: db1, projectId: "p1", now: () => T0, log: () => {}, maxRounds: 1,
      runAgentTurn: async () => okTurn,
      runWork: async (_a, workId) => {
        updateWorkStatus(db1, workId, "done", T0 + 1);
        return {
          workId, title: "调研", status: "done",
          aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    });
    expect(first.stopReason).toBe("max_rounds");
    expect(listWorksPendingReview(db1, "p1").map((w) => w.id)).toEqual(["w1"]);
    db1.close();

    // ── 第二个进程:全新连接、全新依赖对象、没有任何跨调用状态 ──
    const db2 = openPlatformDb(path);
    try {
      expect(listWorksPendingReview(db2, "p1").map((w) => w.id)).toEqual(["w1"]);
      const seen: string[] = [];
      const second = await drainProject({
        db: db2, projectId: "p1", now: () => T0 + 100, log: () => {},
        runAgentTurn: async (agentId): Promise<DrainTurnReport> => {
          seen.push(agentId);
          return okTurn;
        },
        runWork: async () => { throw new Error("重启后没有可执行的工作项"); },
      });
      expect(seen).toContain("qa"); // ← 这就是「重启后补跑」
      expect(second.visited.map((v) => v.kind)).toEqual(["review_work", "report_downstream"]);
      expect(listWorksPendingReview(db2, "p1")).toEqual([]);
      expect(listPendingDispatchEvents(db2, "p1")).toEqual([]);
    } finally {
      db2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 任务描述 ────────────────────────────────────────────────────

describe("renderTask · 每个待办给 agent 的那一段", () => {
  it("拆解那条明确说「不要自己动手做」,并限定负责人只能是 worker", () => {
    const t = board("p1", T0).runnable[0]!;
    const text = renderTask(db, t);
    expect(text).toContain("work_create");
    expect(text).toContain("不要自己动手做");
    expect(text).toContain("负责人只能是 **worker**");
  });

  it("汇报那条明说「没有人向你提问」,并带上库里查出来的事件现场", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 3);
    const t = board("p1", T0 + 4).runnable.find((x) => x.kind === "report_downstream")!;
    const text = renderTask(db, t);
    expect(text).toContain("没有人向你提问");
    expect(text).toContain("tell_client");
    expect(text).toContain("调研路线 A");
  });

  it("审查那条要求「通过也要写依据」,并列出等着审的产出", () => {
    mkWork({ status: "done", title: "调研机器人" });
    const t = board("p1", T0).runnable.find((x) => x.kind === "review_work")!;
    const text = renderTask(db, t);
    expect(text).toContain("review_finding");
    expect(text).toContain("调研机器人");
  });
});

// ── 现场:项目上下文 ────────────────────────────────────────────

describe("renderProjectContext · A(项目上下文)", () => {
  it("接待会话返回空串 —— 那条路径保持原样", () => {
    const c = renderProjectContext(db, "bm", null);
    expect(c.text).toBe("");
    expect(c.projectId).toBeNull();
    expect(c.summary).toContain("接待会话");
  });

  it("项目会话里带出项目名 / 目标 / 我的角色 / 成员", () => {
    const c = renderProjectContext(db, "bm", "p1");
    expect(c.text).toContain("语音机器人调研");
    expect(c.text).toContain("给出三条技术路线的对比与选型建议");
    expect(c.text).toContain("业务经理");
    expect(c.text).toContain("项目经理");
    expect(c.text).toContain("这就是你此刻所在的项目");
  });

  it("项目读不出来时不假装是接待会话", () => {
    const c = renderProjectContext(db, "bm", "pj_missing");
    expect(c.text).toContain("读不出来");
    expect(c.text).not.toBe("");
  });
});

describe("getWork 的现场不丢", () => {
  it("执行过的工作项仍能读回标题与状态", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "in_progress", T0 + 1);
    expect(getWork(db, w)?.status).toBe("in_progress");
  });
});

// ── 审查态与下游事件的不变量(status 的唯一写口维护它们)──────────

describe("updateWorkStatus · 审查态与下游事件", () => {
  it("迁入 done → review_state = pending,并记一条 work_done", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 1);
    expect(getWork(db, w)?.reviewState).toBe("pending");
    expect(listPendingDispatchEvents(db, "p1").map((e) => e.kind)).toEqual(["work_done"]);
  });

  it("迁出 done → review_state = none(不再挂着等审)", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 1);
    updateWorkStatus(db, w, "in_progress", T0 + 2);
    expect(getWork(db, w)?.reviewState).toBe("none");
    expect(listWorksPendingReview(db, "p1")).toEqual([]);
  });

  it("done → done 不重复记事件(重复写不该刷出第二条汇报)", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "done", T0 + 1);
    updateWorkStatus(db, w, "done", T0 + 2);
    expect(listPendingDispatchEvents(db, "p1")).toHaveLength(1);
  });

  it("in_progress 不产生事件(它不是该向甲方交代的事实)", () => {
    const w = mkWork();
    updateWorkStatus(db, w, "in_progress", T0 + 1);
    expect(listPendingDispatchEvents(db, "p1")).toEqual([]);
  });

  it("failed / blocked 各记一条对应种类的事件", () => {
    const a = mkWork();
    const b = mkWork();
    updateWorkStatus(db, a, "failed", T0 + 1);
    updateWorkStatus(db, b, "blocked", T0 + 2);
    expect(listPendingDispatchEvents(db, "p1").map((e) => e.kind).sort())
      .toEqual(["work_blocked", "work_failed"]);
  });
});

// ── 现场:项目状态的历史判据(旧签名函数已随级联删除)────────────

describe("collectPendingWork · 变更:非终态都算待推进", () => {
  it("`under_review` / `accepted` 也算 —— 否则变更会永久停在那儿", () => {
    insertChange(db, { id: "c1", projectId: "p1", title: "缩范围", rationale: "r", impactJson: null, createdAt: T0 });
    insertChange(db, { id: "c2", projectId: "p1", title: "换方案", rationale: "r", impactJson: null, createdAt: T0 + 1, status: "under_review" });
    insertChange(db, { id: "c3", projectId: "p1", title: "加一项", rationale: "r", impactJson: null, createdAt: T0 + 2, status: "accepted" });
    insertChange(db, { id: "c4", projectId: "p1", title: "已拒", rationale: "r", impactJson: null, createdAt: T0 + 3, status: "rejected" });
    insertChange(db, { id: "c5", projectId: "p1", title: "已实施", rationale: "r", impactJson: null, createdAt: T0 + 4, status: "implemented" });
    const pw = collectPendingWork(db, "pm", "p1", T0 + 5);
    expect([...pw.pendingChanges.map((c) => c.id)].sort()).toEqual(["c1", "c2", "c3"]);
    expect([...pw.pendingChanges.map((c) => c.status)].sort()).toEqual(
      ["accepted", "proposed", "under_review"],
    );
    expect(hasActionableWork(pw)).toBe(true);
    expect(hasActionableWork(collectPendingWork(db, "bm", "p1", T0 + 5))).toBe(false);
  });

  it("渲染里带状态 —— 「待评审」不该概括一条已经 accepted 的变更", () => {
    insertChange(db, { id: "c2", projectId: "p1", title: "换方案", rationale: "r", impactJson: null, createdAt: T0 + 1, status: "under_review" });
    const text = renderPendingWork(db, collectPendingWork(db, "pm", "p1", T0 + 2));
    expect(text).toContain("待推进的变更(1)");
    expect(text).toContain("[under_review]");
  });
});

// ── 会议与成员变动(旧签名测试的替代:判据全部可查)────────────

describe("库里的判据(不再需要项目状态签名)", () => {
  it("参会方表态 → 那个人手上的会议待办消失(查询直接反映)", () => {
    insertMeeting(db, {
      id: "m1", projectId: "p1", topic: "对齐范围", conveningAgentId: "bm",
      createdAt: T0, participants: ["pm", "qa", "wk"],
    });
    expect(board("p1", T0).runnable.filter((t) => t.kind === "attend_meeting")).toHaveLength(3);
    respondToMeeting(db, "m1", "pm", "support", T0 + 1);
    const after = board("p1", T0 + 2).runnable.filter((t) => t.kind === "attend_meeting");
    expect(after.map((t) => t.agentId).sort()).toEqual(["qa", "wk"]);
  });

  it("成员被移出 → 他的待办一起消失", () => {
    mkWork();
    expect(board("p1", T0).runnable.some((t) => t.agentId === "wk")).toBe(true);
    removeMember(db, "p1", "wk", T0 + 1);
    expect(board("p1", T0 + 2).runnable.some((t) => t.agentId === "wk")).toBe(false);
  });

  it("项目状态变化 → paused 项目不再产生拆解待办", () => {
    db.prepare(`UPDATE projects SET status = 'paused' WHERE id = 'p1'`).run();
    expect(board("p1", T0).runnable.some((t) => t.kind === "decompose_project")).toBe(false);
  });

  it("阻塞被解决不影响「新登记阻塞」这条历史事件(它记的是当时发生过什么)", () => {
    insertBlocker(db, {
      id: "b1", projectId: "p1", raisedByAgentId: "wk", title: "缺依赖", detail: "d",
      severity: "high", status: "open", createdAt: T0,
    });
    setBlockerStatus(db, "b1", "resolved", T0 + 3, "补上了");
    expect(listPendingDispatchEvents(db, "p1")).toHaveLength(1);
  });

  it("collectTodos 是纯查询:连调两次结果一致(没有累积状态)", () => {
    mkWork();
    const a = board("p1", T0).runnable.map((t) => `${t.kind}:${t.key}`);
    const b = board("p1", T0).runnable.map((t) => `${t.kind}:${t.key}`);
    expect(a).toEqual(b);
  });

  it("collectTodos 不写库:调用前后相关表的行数不变", () => {
    mkWork({ status: "done" });
    const count = () => ({
      attempts: (db.prepare(`SELECT COUNT(*) n FROM dispatch_attempts`).get() as { n: number }).n,
      events: (db.prepare(`SELECT COUNT(*) n FROM dispatch_events`).get() as { n: number }).n,
    });
    const before = count();
    collectTodos({ db, projectId: "p1", now: T0 });
    collectTodos({ db, projectId: "p1", now: T0 });
    expect(count()).toEqual(before);
  });
});

// ── 诊断入口 ────────────────────────────────────────────────────

describe("collectTodos · 快照的一致性", () => {
  it("没有待办时 runnable 与 exhausted 都是空", () => {
    expect(board("p1", T0).runnable).toHaveLength(1); // pm 拆解
    const empty = board("missing_project", T0);
    expect(empty.runnable).toEqual([]);
    expect(empty.exhausted).toEqual([]);
  });

  it("预算用尽的待办从 runnable 移到 exhausted(可见,不静默消失)", () => {
    db.prepare(
      `INSERT INTO dispatch_attempts (project_id, todo_key, attempts, target_state,
                                      first_attempt_at, last_attempt_at, notified_at)
       VALUES ('p1', 'decompose_project:p1', 3, NULL, ?, ?, NULL)`,
    ).run(T0, T0);
    const b = board("p1", T0);
    expect(b.runnable).toEqual([]);
    expect(b.exhausted.map((t) => t.kind)).toEqual(["decompose_project"]);
  });
});
