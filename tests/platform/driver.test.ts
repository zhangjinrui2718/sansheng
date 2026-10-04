/**
 * 驱动者循环 · 测试
 *
 * ── 这一层最要紧的性质是「它一定会停」 ────────────────────────────
 *
 * 一个不设上界的多 agent 循环是这个系统能犯的最贵的错误:它不在代码评审里
 * 显形,只以账单的形式出现,而且日志里长得像「系统在努力工作」。
 *
 * 所以下面的测试刻意不测「它能不能把活干完」(那是端到端的事),而是穷举
 * **三种停法**:
 *
 *   ① 没有待办了        → exhausted
 *   ② 撞上单次级联上限  → max_rounds(且必须如实报出来,不静默停)
 *   ③ 同一个待办反复被唤醒而项目状态没变 → no_progress(级联内 + 跨级联两层)
 *
 * 假 provider 是刻意的:`runCascade` 的职责是**编排**(谁该动、动哪个、什么时候
 * 停),不是「跟模型说话」。真模型那条路由真机端到端覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember, removeMember } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertWork, getWork, updateWorkStatus } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertAsk, answerAsk } from "../../src/platform/storage/repo/asks.js";
import { insertChange } from "../../src/platform/storage/repo/changes.js";
import { insertBlocker, setBlockerStatus } from "../../src/platform/storage/repo/blockers.js";
import { insertMeeting, respondToMeeting } from "../../src/platform/storage/repo/meetings.js";
import {
  collectPendingWork, hasActionableWork, renderPendingWork,
} from "../../src/platform/runtime/pendingWork.js";
import {
  collectTodos, createMemoryStallStore, emptyCascadeState, peekTodos,
  projectSignature, renderTask, runCascade,
  type CascadeTurnReport, type CascadeWorkReport,
} from "../../src/platform/runtime/driver.js";
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

const okTurn: CascadeTurnReport = {
  aborted: false, timedOut: false, text: "好了", toolCalls: [],
};

// ── ① 每个角色的可执行待办 ──────────────────────────────────────

describe("collectPendingWork · 分派给我的工作项(此前完全缺失的那一块)", () => {
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
    // 前置完成后下游才可开工
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

describe("hasActionableWork · 按角色的 ceiling 过滤(新)", () => {
  it("proposed 变更是待办 —— 但对业务经理不是(他只有 change.read)", () => {
    insertChange(db, {
      id: "c1", projectId: "p1", title: "加字段", rationale: "r",
      impactJson: null, createdAt: T0,
    });
    const bm = collectPendingWork(db, "bm", "p1", T0);
    expect(bm.pendingChanges).toHaveLength(1);
    // 按 ceiling 过滤:业务经理推不动这条变更
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

// ── 待办收集(判据)──────────────────────────────────────────────

describe("collectTodos · 谁此刻能动手", () => {
  it("空项目 → 只有项目经理的那一条「拆解」", () => {
    const todos = peekTodos(db, "p1", T0);
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ agentId: "pm", kind: "decompose_project" });
  });

  it("有人提问 → answer_ask 排在最高优先级(有人 block 着)", () => {
    mkWork();
    insertAsk(db, {
      id: "a1", projectId: "p1", fromAgentId: "wk", toAgentId: "pm",
      question: "走 A 还是 B?", hypothesis: "我倾向 A", createdAt: T0,
    });
    const todos = peekTodos(db, "p1", T0);
    expect(todos[0]).toMatchObject({ agentId: "pm", kind: "answer_ask" });
    // 同一个人手上的执行类待办排在后面
    expect(todos.map((t) => t.kind)).toContain("execute_work");
    expect(todos.findIndex((t) => t.kind === "answer_ask"))
      .toBeLessThan(todos.findIndex((t) => t.kind === "execute_work"));
  });

  it("worker 的工作项 → execute_work 且带目标 id", () => {
    const w = mkWork();
    const t = peekTodos(db, "p1", T0).find((x) => x.kind === "execute_work");
    expect(t).toMatchObject({ agentId: "wk", target: w, key: `execute_work:${w}` });
  });

  it("下游结果只有**级联自己观察到了**才算业务经理的待办", () => {
    mkWork();
    // 库里什么都有,但没有级联事件 → 业务经理没有待办
    expect(peekTodos(db, "p1", T0).some((t) => t.kind === "report_downstream")).toBe(false);
    const state = emptyCascadeState();
    state.downstream.push({ kind: "work_done", id: "w1", summary: "「调研」完成了" });
    const todos = collectTodos({ db, projectId: "p1", now: T0, state });
    expect(todos.some((t) => t.kind === "report_downstream" && t.agentId === "bm")).toBe(true);
  });

  it("质检的待办只来自「刚做完」(库里没有等待审查的状态)", () => {
    mkWork({ status: "done" });
    // 工作项已经是 done,但**没有**级联事件说「刚刚完成」→ 不叫醒质检
    expect(peekTodos(db, "p1", T0).some((t) => t.kind === "review_work")).toBe(false);
    const state = emptyCascadeState();
    state.reviewQueue.push({ workId: "w1", title: "调研" });
    expect(
      collectTodos({ db, projectId: "p1", now: T0, state }).some(
        (t) => t.kind === "review_work" && t.agentId === "qa",
      ),
    ).toBe(true);
  });

  it("不在项目里的人不会被派活", () => {
    db.prepare(`UPDATE project_assignments SET removed_at = ? WHERE agent_id = 'wk'`).run(T0 + 1);
    mkWork();
    expect(peekTodos(db, "p1", T0 + 2).some((t) => t.agentId === "wk")).toBe(false);
  });
});

// ── ③ 一定会停 ──────────────────────────────────────────────────

describe("runCascade · 没有待办就什么都不做", () => {
  it("拆过、没有指派、没有提问 → 0 回合 exhausted", async () => {
    mkWork({ status: "done" });
    const r = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(r.rounds).toBe(0);
    expect(r.stopReason).toBe("exhausted");
  });
});

describe("runCascade · 无进展检测(级联内)", () => {
  it("同一个待办被叫醒而项目状态没变 → 第一回合之后就停(不烧 token)", async () => {
    // 项目零工作项 → 项目经理的 decompose 待办。假回合**什么都不做**。
    let called = 0;
    const r = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => { called++; return okTurn; },
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(called).toBe(1);              // 只叫了一次,不是 maxRounds 次
    expect(r.rounds).toBe(1);
    expect(r.stopReason).toBe("no_progress");
    // 如实说是**哪一条**待办卡住了(不是一句笼统的「没有进展」)
    expect(r.stopDetail).toContain("把项目拆成工作项");
  });

  it("**跨级联**记忆:第二次扫描不会再叫一遍(否则周期扫描每 60 秒烧一次)", async () => {
    const stall = createMemoryStallStore();
    let called = 0;
    const deps = {
      db, projectId: "p1", now: () => T0, log: () => {}, stallStore: stall,
      runAgentTurn: async (): Promise<CascadeTurnReport> => { called++; return okTurn; },
      runWork: async (): Promise<CascadeWorkReport> => { throw new Error("不该被调用"); },
    };
    const first = await runCascade(deps);
    expect(first.rounds).toBe(1);
    const second = await runCascade(deps);
    expect(second.rounds).toBe(0);
    expect(second.stopReason).toBe("no_progress");
    expect(called).toBe(1);
  });

  it("状态变了就清掉记忆 —— 下一轮照常叫醒", async () => {
    const stall = createMemoryStallStore();
    let n = 0;
    const r1 = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {}, stallStore: stall,
      // 项目经理**真的**拆出了一个工作项(只拆一次,像真项目经理那样)→ 状态变了
      runAgentTurn: async () => {
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
      runWork: async (agentId, workId) => {
        updateWorkStatus(db, workId, "done", T0 + 1);
        mkArtifact(`art_${++n}`);
        return {
          workId, title: "t", status: "done",
          aborted: false, timedOut: false, text: "做完了", toolCalls: [],
        };
      },
    });
    // pm 拆解 → wk 执行 → qa 审查 → bm 汇报
    expect(r1.visited.map((v) => v.agentId)).toEqual(["pm", "wk", "qa", "bm"]);
    expect(r1.reportedToClient).toBe(true);
    expect(r1.stopReason).toBe("exhausted");
  });
});

describe("runCascade · 硬上界(烧 token 的闸)", () => {
  /**
   * 「永远有活」的假组织:拆一个 → 做完一个 → 又出现一个。
   *
   * 用它才能测到**上界**这一条 —— 无进展检测抓不住它(每一回合都真的产生了
   * 状态变化),所以唯一能拦住它的就是 `maxRounds`。
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
      runAgentTurn: async (_agentId: string): Promise<CascadeTurnReport> => {
        if ((db.prepare(`SELECT COUNT(*) AS n FROM works`).get() as { n: number }).n === 0) {
          mk("wk");
        }
        return okTurn;
      },
      runWork: async (_agentId: string, workId: string): Promise<CascadeWorkReport> => {
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
    const r = await runCascade(foreverBusyDeps(2));
    expect(r.rounds).toBe(2);
    expect(r.stopReason).toBe("max_rounds");
    expect(r.stopDetail).toContain("上限 2");
  });

  it("默认上界是 8 —— 保守,但存在", async () => {
    const r = await runCascade(foreverBusyDeps());
    expect(r.rounds).toBe(8);
    expect(r.stopReason).toBe("max_rounds");
  });

  it("用户中断 → cancelled(不再往下跑)", async () => {
    let cancelled = false;
    const r = await runCascade({
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
    const r = await runCascade({
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
});

// ── 下游结果的累积(第 ④ 条的地基)──────────────────────────────

describe("runCascade · 下游结果怎么累积出来", () => {
  it("工作项 done → 进 reviewQueue 与 downstream;业务经理最后汇报一次", async () => {
    const w = mkWork();
    const r = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async (agentId, workId) => {
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
    // 业务经理汇报之后,那一批下游结果被消费掉(不会一直挂在待办里)
    expect(r.downstream).toEqual([]);
    expect(r.reportedToClient).toBe(true);
    expect(w).toBeTruthy();
  });

  it("新登记的阻塞也进下游结果 —— 它同样该让甲方知道", async () => {
    mkWork();
    const r = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async () => okTurn,
      runWork: async (agentId, workId) => {
        insertBlocker(db, {
          id: "b1", projectId: "p1", raisedByAgentId: "wk", title: "缺依赖",
          detail: "拉不到数据", severity: "high", status: "open", createdAt: T0 + 1,
        });
        updateWorkStatus(db, workId, "blocked", T0 + 1);
        return {
          workId, title: "调研路线 A", status: "blocked",
          aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    });
    expect(r.visited.map((v) => v.kind)).toContain("report_downstream");
    expect(r.reportedToClient).toBe(true);
  });
});

// ── 任务描述(④:不另造一套)────────────────────────────────────

describe("renderTask · 每个待办给 agent 的那一段", () => {
  it("拆解那条明确说「不要自己动手做」", () => {
    const t = peekTodos(db, "p1", T0)[0]!;
    const text = renderTask(t, emptyCascadeState());
    expect(text).toContain("work_create");
    expect(text).toContain("不要自己动手做");
  });

  it("汇报那条明说「没有人向你提问」—— 这是「主动」的定义", () => {
    const state = emptyCascadeState();
    state.downstream.push({ kind: "work_done", id: "w1", summary: "「调研」完成了" });
    const t = collectTodos({ db, projectId: "p1", now: T0, state })
      .find((x) => x.kind === "report_downstream")!;
    const text = renderTask(t, state);
    expect(text).toContain("没有人向你提问");
    expect(text).toContain("tell_client");
    expect(text).toContain("「调研」完成了");
  });

  it("审查那条要求「通过也要写依据」", () => {
    const state = emptyCascadeState();
    state.reviewQueue.push({ workId: "w1", title: "t" });
    const t = collectTodos({ db, projectId: "p1", now: T0, state })
      .find((x) => x.kind === "review_work")!;
    expect(renderTask(t, state)).toContain("review_finding");
  });
});

// ── 现场:项目上下文与状态签名 ──────────────────────────────────

describe("projectSignature · 无进展检测的判据", () => {
  it("工件多一条就算有变化 —— 只写不读的产出也是进展", () => {
    mkWork();
    const a = projectSignature(db, "p1");
    mkArtifact("art_1");
    expect(projectSignature(db, "p1")).not.toBe(a);
  });

  it("工作项状态变化算进展", () => {
    const w = mkWork();
    const a = projectSignature(db, "p1");
    updateWorkStatus(db, w, "done", T0 + 5);
    expect(projectSignature(db, "p1")).not.toBe(a);
  });
});

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

// ── 跨级联的级联状态(真机跑出来的一条洞)────────────────────────

describe("runCascade · 级联状态跨级联复用(否则撞上界时下游结果静默消失)", () => {
  it("撞上界之后,「工作项做完了」这件事留给下一次级联去汇报", async () => {
    const state = emptyCascadeState();
    const stall = createMemoryStallStore();
    let n = 0;
    const mk = (assignee: string) => {
      n++;
      insertWork(db, {
        id: `wk_s${n}`, projectId: "p1", parentWorkId: null, title: "t", goal: "g",
        status: "open", assigneeAgentId: assignee, createdAt: T0 + n, updatedAt: T0 + n,
      });
    };
    mk("wk");
    mk("wk");
    const shared = {
      db, projectId: "p1", now: () => T0, log: () => {}, stallStore: stall, state,
      runAgentTurn: async (): Promise<CascadeTurnReport> => okTurn,
      runWork: async (_a: string, workId: string): Promise<CascadeWorkReport> => {
        updateWorkStatus(db, workId, "done", T0 + 1);
        mkArtifact(`art_s${++n}`);
        return {
          workId, title: "t", status: "done",
          aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    };
    // 第一次级联只跑一个回合(比如上一批残留 + 上限 = 1)
    const first = await runCascade({ ...shared, maxRounds: 1 });
    expect(first.rounds).toBe(1);
    expect(first.stopReason).toBe("max_rounds");
    // 关键:那一条「下游结果」与「待审队列」**没有**随级联一起消失
    expect(state.downstream.length).toBeGreaterThan(0);
    expect(state.reviewQueue.length).toBeGreaterThan(0);

    // 第二次级联(下一个调度器 tick)接着把剩下的跑完 —— 包括向甲方汇报
    const second = await runCascade(shared);
    expect(second.visited.map((v) => v.agentId)).toContain("bm");
    expect(second.reportedToClient).toBe(true);
    expect(state.downstream).toEqual([]);
    expect(state.reviewQueue).toEqual([]);
  });

  it("不传 state 时每次新建 —— 一次性调用不会污染别人", async () => {
    const r1 = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {},
      runAgentTurn: async (): Promise<CascadeTurnReport> => okTurn,
      runWork: async (): Promise<CascadeWorkReport> => { throw new Error("不该被调用"); },
    });
    expect(r1.downstream).toEqual([]);
  });
});

describe("peekTodos · 周期扫描的门必须看见级联状态", () => {
  it("只有「下游结果」时,不带状态的快照是空的 —— 那正是漏报的成因", () => {
    // 库里放一条已终态的工作项:这样「项目零 work」那条待办不出现,
    // 剩下的唯一待办就只可能来自级联状态
    mkWork({ status: "done" });
    const state = emptyCascadeState();
    state.downstream.push({ kind: "work_done", id: "w1", summary: "「调研」完成了" });
    // 不带状态:库里确实没有可执行的待办 → 扫描会跳过
    expect(peekTodos(db, "p1", T0)).toHaveLength(0);
    // 带上状态:业务经理的汇报那一条在
    expect(peekTodos(db, "p1", T0, state).map((t) => t.kind)).toContain("report_downstream");
  });
});

describe("projectSignature · 覆盖面(漏一类状态 = 一次假的无进展)", () => {
  it("**参会方表态**算进展 —— meeting.status 只在第一个人表态时变", () => {
    insertMeeting(db, {
      id: "m1", projectId: "p1", topic: "对齐范围", conveningAgentId: "bm",
      createdAt: T0, participants: ["pm", "qa", "wk"],
    });
    const a = projectSignature(db, "p1");
    // 第一个人表态:meeting 状态 convened → in_progress(这一条第一版也能抓到)
    respondToMeeting(db, "m1", "pm", "support", T0 + 1);
    const b = projectSignature(db, "p1");
    expect(b).not.toBe(a);
    // 第二个人表态:只改 meeting_participants —— 第一版签名在这里**看不见变化**
    respondToMeeting(db, "m1", "qa", "oppose", T0 + 2, "范围太宽");
    expect(projectSignature(db, "p1")).not.toBe(b);
  });

  it("成员变动算进展", () => {
    const a = projectSignature(db, "p1");
    addMember(db, "p1", "bm", T0 + 1);
    expect(projectSignature(db, "p1")).toBe(a);
    removeMember(db, "p1", "wk", T0 + 2);
    expect(projectSignature(db, "p1")).not.toBe(a);
  });

  it("项目状态变化算进展", () => {
    const a = projectSignature(db, "p1");
    db.prepare(`UPDATE projects SET status = 'paused' WHERE id = 'p1'`).run();
    expect(projectSignature(db, "p1")).not.toBe(a);
  });

  it("阻塞被解决算进展(resolvedAt 进签名)", () => {
    insertBlocker(db, {
      id: "b1", projectId: "p1", raisedByAgentId: "wk", title: "缺依赖", detail: "d",
      severity: "high", status: "open", createdAt: T0,
    });
    const a = projectSignature(db, "p1");
    setBlockerStatus(db, "b1", "resolved", T0 + 3, "补上了");
    expect(projectSignature(db, "p1")).not.toBe(a);
  });
});

describe("runCascade · 一条待办卡住不该拖停别人", () => {
  it("卡住的那条被跳过,剩下的照跑", async () => {
    const stall = createMemoryStallStore();
    // 人为把 worker 的 execute_work 标记成「在当前状态下已试过且无变化」
    const w = mkWork();
    // 项目经理手上另有一条(有人问它)—— 它必须照常被叫醒
    insertAsk(db, {
      id: "a_skip", projectId: "p1", fromAgentId: "wk", toAgentId: "pm",
      question: "走 A 还是 B?", hypothesis: "我倾向 A", createdAt: T0,
    });
    const sig = projectSignature(db, "p1");
    stall.set(`p1::execute_work:${w}`, { signature: sig, attempts: 1 });

    const visited: string[] = [];
    let n = 0;
    const r = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {}, stallStore: stall,
      runAgentTurn: async (agentId): Promise<CascadeTurnReport> => {
        visited.push(agentId);
        // 真干活:把那条约它答的问结掉 → 项目状态变了,而且那条待办消失
        answerAsk(db, "a_skip", T0 + 1, null);
        mkArtifact(`art_skip${++n}`);
        return okTurn;
      },
      runWork: async (_a: string, workId: string): Promise<CascadeWorkReport> => {
        visited.push(`runWork:${workId}`);
        updateWorkStatus(db, workId, "done", T0 + 9);
        return {
          workId, title: "t", status: "done",
          aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    });
    // 第一回合本该轮到 worker(优先级 4 < pm 的 6),但它被 stall 挡住 →
    // 跳过它、叫醒项目经理;pm 产生了真实进展之后,那条 stall 记忆过期,
    // worker 的活接着被跑掉。
    expect(visited.slice(0, 2)).toEqual(["pm", `runWork:${w}`]);
    expect(r.stopReason).toBe("exhausted");
  });

  it("**全部**待办都卡住时才停", async () => {
    const stall = createMemoryStallStore();
    const w = mkWork();
    const sig = projectSignature(db, "p1");
    stall.set(`p1::execute_work:${w}`, { signature: sig, attempts: 1 });
    const r = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {}, stallStore: stall,
      runAgentTurn: async (): Promise<CascadeTurnReport> => okTurn,
      runWork: async (): Promise<CascadeWorkReport> => { throw new Error("不该被调用"); },
      maxRounds: 5,
    });
    // 唯一能跑的那条(worker 执行)已经被 stall 挡住 → 一次都不该叫
    expect(r.rounds).toBe(0);
    expect(r.stopReason).toBe("no_progress");
    expect(r.stopDetail).toContain("都已经试过");
  });
});

describe("runCascade · 最后一格预算留给甲方", () => {
  it("撞上界前,攒下的下游结果先汇报掉(而不是再开一个工作项)", async () => {
    // 3 条待办:worker 执行 2 条 + 一条攒下的下游结果
    const w1 = mkWork();
    const w2 = mkWork();
    const state = emptyCascadeState();
    state.downstream.push({ kind: "work_done", id: "w_prev", summary: "「上一批」完成了" });
    const visited: string[] = [];
    const r = await runCascade({
      db, projectId: "p1", now: () => T0, log: () => {}, state, maxRounds: 2,
      runAgentTurn: async (agentId): Promise<CascadeTurnReport> => {
        visited.push(agentId);
        return okTurn;
      },
      runWork: async (_a: string, workId: string): Promise<CascadeWorkReport> => {
        visited.push(`runWork:${workId}`);
        updateWorkStatus(db, workId, "done", T0 + 1);
        mkArtifact(`art_last${workId}`);
        return {
          workId, title: "t", status: "done",
          aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    });
    expect(r.rounds).toBe(2);
    // 第 1 回合照优先级走(work 排第一),第 2 回合是**最后一格** → 汇报
    expect(visited[0]).toBe(`runWork:${w1}`);
    expect(visited[1]).toBe("bm");
    expect(r.reportedToClient).toBe(true);
    expect(w2).toBeTruthy();
  });
});

describe("collectPendingWork · 变更:非终态都算待推进(真机跑出来的洞)", () => {
  it("`under_review` / `accepted` 也算 —— 否则变更会永久停在那儿", () => {
    insertChange(db, { id: "c1", projectId: "p1", title: "缩范围", rationale: "r", impactJson: null, createdAt: T0 });
    insertChange(db, { id: "c2", projectId: "p1", title: "换方案", rationale: "r", impactJson: null, createdAt: T0 + 1, status: "under_review" });
    insertChange(db, { id: "c3", projectId: "p1", title: "加一项", rationale: "r", impactJson: null, createdAt: T0 + 2, status: "accepted" });
    insertChange(db, { id: "c4", projectId: "p1", title: "已拒", rationale: "r", impactJson: null, createdAt: T0 + 3, status: "rejected" });
    insertChange(db, { id: "c5", projectId: "p1", title: "已实施", rationale: "r", impactJson: null, createdAt: T0 + 4, status: "implemented" });
    const pw = collectPendingWork(db, "pm", "p1", T0 + 5);
    // 仓储按 created_at DESC 返回 —— 顺序不是判据,集合才是
    expect([...pw.pendingChanges.map((c) => c.id)].sort()).toEqual(["c1", "c2", "c3"]);
    expect([...pw.pendingChanges.map((c) => c.status)].sort()).toEqual(
      ["accepted", "proposed", "under_review"],
    );
    expect(hasActionableWork(pw)).toBe(true);
    // 业务经理只有 change.read → 推不动,不算他的待办
    expect(hasActionableWork(collectPendingWork(db, "bm", "p1", T0 + 5))).toBe(false);
  });

  it("渲染里带状态 —— 「待评审」不该概括一条已经 accepted 的变更", () => {
    insertChange(db, { id: "c2", projectId: "p1", title: "换方案", rationale: "r", impactJson: null, createdAt: T0 + 1, status: "under_review" });
    const text = renderPendingWork(db, collectPendingWork(db, "pm", "p1", T0 + 2));
    expect(text).toContain("待推进的变更(1)");
    expect(text).toContain("[under_review]");
  });
});
