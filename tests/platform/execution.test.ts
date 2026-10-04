/**
 * BC6 执行层 · 测试
 *
 * ── 这里测的是**编排**,不是模型 ─────────────────────────────────
 *
 * `runWorkItem` 的职责是:前置检查 → 置 in_progress → 跑一个回合 → **按事实判定
 * 结局** → 带现场回来。所以假会话的剧本直接改库(模拟 agent 通过工具做的事),
 * 于是每条结局分支都能被精确触发。
 *
 * 最要紧的一条是「**不替它判成功**」:回合结束了而工作项还在 in_progress,
 * 必须如实报 unconverged,而不是因为「模型说了完成了」就标 done。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertWork, getWork, updateWorkStatus, type WorkRow } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertBlocker } from "../../src/platform/storage/repo/blockers.js";
import { listPendingDispatchEvents } from "../../src/platform/storage/repo/dispatch.js";
import { collectPendingWork } from "../../src/platform/runtime/pendingWork.js";
import {
  runWorkItem, composeWorkPrompt, renderExecutionReport, type ExecutionResult,
} from "../../src/platform/runtime/execution.js";

let db: Database.Database;
let seq = 0;
const AT = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertAgent(db, { id: "pm", role: "project_manager", specialization: null, displayName: "项目经理", createdAt: AT });
  insertAgent(db, { id: "wk", role: "worker", specialization: "engineering", displayName: "工程师", createdAt: AT });
  insertAgent(db, { id: "wk2", role: "worker", specialization: "data", displayName: "数据", createdAt: AT });
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: AT });
  for (const id of ["pm", "wk", "wk2"]) addMember(db, "p1", id, AT);
});
afterEach(() => db.close());

function mkWork(over: Partial<WorkRow> = {}): WorkRow {
  const w: WorkRow = {
    id: `w_${++seq}`, projectId: "p1", parentWorkId: null,
    title: "写一个接口", goal: "给用户列表加分页",
    status: "open", assigneeAgentId: "wk",
    createdAt: AT, updatedAt: AT,
    ...over,
  };
  insertWork(db, w);
  return w;
}

/** 假会话:剧本在 prompt 时执行,直接改库(模拟 agent 用工具做的事)。 */
function fakeSession(
  script: (ctx: { emit: (ev: AgentSessionEvent) => void; text: string }) => void,
): AgentSession {
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  return {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
    async prompt(text: string) {
      const emit = (ev: AgentSessionEvent) => { for (const l of [...listeners]) l(ev); };
      script({ emit, text });
      emit({ type: "agent_settled" });
    },
    dispose() {},
    getActiveToolNames() { return []; },
  } as unknown as AgentSession;
}

const saidDone = (msg = "干完了") =>
  fakeSession(({ emit }) => {
    emit({
      type: "message_update", message: {},
      assistantMessageEvent: { type: "text_delta", delta: msg },
    } as unknown as AgentSessionEvent);
  });

async function run(workId: string, session: AgentSession): Promise<ExecutionResult> {
  return runWorkItem({ session, db, workId, timeoutMs: 1000, injectPending: false });
}

// ── 前置检查 ────────────────────────────────────────────────────

describe("runWorkItem · 不该跑的就不跑", () => {
  it("工作项不存在 → 抛(这是调用方的 bug,不是运行期状态)", async () => {
    await expect(run("nope", saidDone())).rejects.toThrow(/不存在/);
  });

  for (const status of ["done", "failed", "cancelled"] as const) {
    it(`已是终态(${status})→ refused,且**不建回合**`, async () => {
      const w = mkWork({ status });
      const r = await run(w.id, saidDone());
      expect(r.outcome).toBe("refused");
      expect(r.refusalReason).toContain("终态");
      expect(r.turn.toolCalls).toEqual([]);
      expect(getWork(db, w.id)!.status, "不该改它的状态").toBe(status);
    });
  }

  it("负责人不是 worker → refused", async () => {
    const w = mkWork({ assigneeAgentId: "pm" });
    const r = await run(w.id, saidDone());
    expect(r.outcome).toBe("refused");
    expect(r.refusalReason).toContain("不是 worker");
    expect(r.refusalReason).toContain("执行是 worker 的能力");
  });

  it("负责人不存在 → refused(这条分支被 schema 挡着,只能靠外部损坏触发)", async () => {
    // works.assignee_agent_id 有外键指向 agents,所以正常路径**建不出**这种行。
    // 这条检查是防外部写坏数据的第二道 —— 用关掉外键的方式把它逼出来。
    const w = mkWork();
    db.pragma("foreign_keys = OFF");
    db.prepare(`UPDATE works SET assignee_agent_id = 'ghost' WHERE id = ?`).run(w.id);
    db.pragma("foreign_keys = ON");

    const r = await run(w.id, saidDone());
    expect(r.outcome).toBe("refused");
    expect(r.refusalReason).toContain("不存在");
  });

  it("被拒时 turn 字段仍是有效对象(调用方不必判空)", async () => {
    const w = mkWork({ status: "done" });
    const r = await run(w.id, saidDone());
    expect(r.turn).toBeDefined();
    expect(r.turn.settled).toBe(true);
    expect(r.turn.pending.summary).toContain("未执行");
  });
});

// ── 开工 ────────────────────────────────────────────────────────

describe("runWorkItem · 开工置 in_progress", () => {
  it("open → 跑之前先置 in_progress", async () => {
    const w = mkWork({ status: "open" });
    let statusDuringTurn: string | null = null;
    const session = fakeSession(() => { statusDuringTurn = getWork(db, w.id)!.status; });
    await run(w.id, session);
    expect(statusDuringTurn, "回合开始时它就该是 in_progress").toBe("in_progress");
  });

  it("已经是 in_progress 就保持(重跑一个没做完的工作项是合法的)", async () => {
    const w = mkWork({ status: "in_progress" });
    let statusDuringTurn: string | null = null;
    await run(w.id, fakeSession(() => { statusDuringTurn = getWork(db, w.id)!.status; }));
    expect(statusDuringTurn).toBe("in_progress");
    // 这一回合没把它推到终态 → unconverged
    expect(getWork(db, w.id)!.status).toBe("in_progress");
  });
});

// ── 结局判定 ────────────────────────────────────────────────────

describe("runWorkItem · 按事实判定结局,不替它判成功", () => {
  it("工作项被推到 done → converged", async () => {
    const w = mkWork();
    const r = await run(w.id, fakeSession(() => updateWorkStatus(db, w.id, "done", AT + 1)));
    expect(r.outcome).toBe("converged");
    expect(r.work.status).toBe("done");
  });

  it("工作项被标 failed → 也算 converged(它到达了终态)", async () => {
    const w = mkWork();
    const r = await run(w.id, fakeSession(() => updateWorkStatus(db, w.id, "failed", AT + 1)));
    expect(r.outcome).toBe("converged");
    expect(r.work.status).toBe("failed");
  });

  it("**回合结束了但工作项还在 in_progress → unconverged**,不标 done", async () => {
    const w = mkWork();
    const r = await run(w.id, saidDone("我做完了!(但它没改状态)"));
    expect(r.outcome, "它嘴上说做完了不算数").toBe("unconverged");
    expect(getWork(db, w.id)!.status).toBe("in_progress");
  });

  it("工作项被标 blocked → blocked(这是合法结局)", async () => {
    const w = mkWork();
    const r = await run(w.id, fakeSession(() => updateWorkStatus(db, w.id, "blocked", AT + 1)));
    expect(r.outcome).toBe("blocked");
  });
});

// ── 产出与现场 ──────────────────────────────────────────────────

describe("runWorkItem · 产出与现场", () => {
  it("只把**这一回合新写的**工件算作产出", async () => {
    // 回合前就存在的工件不该被算进去
    insertArtifact(db, {
      id: "art_old", projectId: "p1", conversationId: null, kind: "note", status: "open",
      authorAgentId: "wk", title: "旧的", body: "b", metadataJson: null,
      createdAt: AT, updatedAt: AT,
    });
    const w = mkWork();
    const r = await run(w.id, fakeSession(() => {
      insertArtifact(db, {
        id: "art_new", projectId: "p1", conversationId: null, kind: "evidence", status: "open",
        authorAgentId: "wk", title: "新的", body: "b", metadataJson: null,
        createdAt: AT + 1, updatedAt: AT + 1,
      });
    }));
    expect(r.producedArtifacts.map((a) => a.id)).toEqual(["art_new"]);
  });

  it("只把**这一回合新登记的**阻塞算作产出", async () => {
    insertBlocker(db, {
      id: "b_old", projectId: "p1", raisedByAgentId: "wk", title: "旧的", detail: "d",
      severity: "low", status: "open", createdAt: AT,
    });
    const w = mkWork();
    const r = await run(w.id, fakeSession(() => {
      insertBlocker(db, {
        id: "b_new", projectId: "p1", raisedByAgentId: "wk", title: "缺依赖", detail: "d",
        severity: "high", status: "open", createdAt: AT + 1,
      });
    }));
    expect(r.raisedBlockers).toEqual(["b_new"]);
  });

  it("**带回工具调用现场**(7-N:见不到现场等于没有现场)", async () => {
    const w = mkWork();
    const r = await run(w.id, fakeSession(({ emit }) => {
      emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "board_write", args: { kind: "note" } } as unknown as AgentSessionEvent);
      emit({
        type: "tool_execution_end", toolCallId: "c1", toolName: "board_write",
        result: { content: [{ type: "text", text: "已写工件" }], details: { ok: true } }, isError: false,
      } as unknown as AgentSessionEvent);
    }));
    expect(r.turn.toolCalls).toHaveLength(1);
    expect(r.turn.toolCalls[0]!.name).toBe("board_write");
    expect(r.turn.toolCalls[0]!.argsSummary).toContain("kind=note");
  });

  it("报告含状态迁移、产出、工具调用与它最后说的话", () => {
    const r: ExecutionResult = {
      outcome: "unconverged",
      work: {
        id: "w1", projectId: "p1", parentWorkId: null, title: "写接口", goal: "g",
        status: "in_progress", assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
      },
      turn: {
        text: "我还在做", thinking: "",
        toolCalls: [{ name: "board_write", argsSummary: "kind=note", isError: false, resultSummary: "已写工件", durationMs: 2 }],
        pending: { injected: true, summary: "1 条等你答" }, settled: true, timedOut: false,
      },
      producedArtifacts: [],
      raisedBlockers: [],
    };
    const rep = renderExecutionReport(r);
    expect(rep).toContain("w1");
    expect(rep).toContain("未收敛");
    expect(rep).toContain("不替它判成功");
    expect(rep).toContain("board_write");
    expect(rep).toContain("我还在做");
  });

  it("超时要在报告里说出来 —— 因为结局判定可能不准", () => {
    const r: ExecutionResult = {
      outcome: "unconverged",
      work: {
        id: "w1", projectId: "p1", parentWorkId: null, title: "t", goal: "g",
        status: "in_progress", assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
      },
      turn: {
        text: "", thinking: "", toolCalls: [],
        pending: { injected: false, summary: "" }, settled: false, timedOut: true,
      },
      producedArtifacts: [],
      raisedBlockers: [],
    };
    expect(renderExecutionReport(r)).toContain("超时");
  });
});

// ── 任务描述 ────────────────────────────────────────────────────

describe("composeWorkPrompt · 告诉它怎么算完成", () => {
  it("含标题与目标", () => {
    const p = composeWorkPrompt({
      id: "w1", projectId: "p1", parentWorkId: null, title: "写接口", goal: "加分页",
      status: "open", assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
    });
    expect(p).toContain("w1");
    expect(p).toContain("写接口");
    expect(p).toContain("加分页");
  });

  it("**明说工件就是交付物**,不需要另写总结来汇报(BC6 的核心变化)", () => {
    const p = composeWorkPrompt({
      id: "w1", projectId: "p1", parentWorkId: null, title: "t", goal: "g",
      status: "open", assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
    });
    expect(p).toContain("board_write");
    expect(p).toContain("工件就是你的交付物");
    expect(p).toContain("work.update");
    expect(p).toContain("blocker_open");
  });
});

// ── 墙钟超时的**处置**(缺陷的第二半:不能只打断,还要收口)──────────
//
// 真机现场:一个 worker 回合跑了 16 分钟还在 curl 文档,而工作项留在
// `in_progress`。那是个**静默死**:排空器会把它当 `execute_work` 待办反复叫醒,
// 直到尝试预算用尽,然后它既不在待办里、也没有任何 outbox 事件 ——
// 业务经理因此永远不会向甲方交代,也没有人重试。每次叫醒还要再买一个上界。
//
// 现在的处置:平台把它记 `failed`(终态),经 `updateWorkStatus` 这个唯一写口
// 写出 `work_failed` outbox 事件。要人介入,而不是自动重跑一段卡死行为。

interface AbortableSession {
  session: AgentSession;
  /** `abort()` 被调了几次 —— 「打断真的到达会话」的判据 */
  readonly aborts: number;
}

/** 假会话:prompt() 一直挂着(模拟卡死的回合),只有 abort() 能放它走。 */
function hangingSession(
  script: (ctx: { emit: (ev: AgentSessionEvent) => void; text: string }) => void = () => {},
): AbortableSession {
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  const state = { aborts: 0 };
  let release: (() => void) | null = null;
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
    async prompt(text: string) {
      const emit = (ev: AgentSessionEvent) => { for (const l of [...listeners]) l(ev); };
      script({ emit, text });
      await new Promise<void>((res) => { release = res; });
    },
    async abort() {
      state.aborts += 1;
      release?.();
    },
    dispose() {},
    getActiveToolNames() { return []; },
  };
  return {
    session: session as unknown as AgentSession,
    get aborts() { return state.aborts; },
  } as AbortableSession;
}

/** 跑一个工作项,墙钟上界压到 100ms(不真等 10 分钟)。 */
async function runWithWallClock(
  workId: string, session: AgentSession, wallClockTimeoutMs = 100,
): Promise<ExecutionResult> {
  return runWorkItem({
    session, db, workId, timeoutMs: 10_000, wallClockTimeoutMs, injectPending: false,
  });
}

describe("runWorkItem · 墙钟超时后的处置(不静默、留现场)", () => {
  it("超时 → 记 failed(终态)**并写出可查的下游事件**:不再自动重跑,甲方也会被告知", async () => {
    const w = mkWork();
    const s = hangingSession(); // 卡在什么工具上都不做 —— 与真机的 curl 死循环同形
    const r = await runWithWallClock(w.id, s.session);

    expect(s.aborts, "abort() 必须真的被调到").toBe(1);
    expect(r.outcome).toBe("timed_out");
    expect(r.timeoutDisposition).toBe("marked_failed");
    expect(getWork(db, w.id)!.status).toBe("failed");
    expect(r.work.status).toBe("failed");

    // 落点①:outbox —— 业务经理的汇报待办由它查出来(甲方可见,重启不丢)
    expect(listPendingDispatchEvents(db, "p1").map((e) => e.kind)).toEqual(["work_failed"]);

    // 落点②:它不再是一个 `execute_work` 待办 —— 「不再重复烧钱」的机器表达
    expect(
      collectPendingWork(db, "wk", "p1", AT).myOpenWorks.map((x) => x.id),
      "failed 是终态,排空器不会再叫醒它",
    ).toEqual([]);

    // 落点③:现场(跑了多久 / 打断瞬间在跑什么)带得回来
    expect(r.turn.timeout?.abortRequested).toBe(true);
    expect(r.turn.timeout?.elapsedMs).toBeGreaterThanOrEqual(80);
  });

  it("打断瞬间正在跑的工具进现场(事后分得清「原地打转」与「真在跑长活」)", async () => {
    const w = mkWork();
    const s = hangingSession(({ emit }) => {
      emit({
        type: "tool_execution_start", toolCallId: "c1", toolName: "bash",
        args: { command: "curl https://help.aliyun.com/document_detail/..." },
      } as unknown as AgentSessionEvent);
    });
    const r = await runWithWallClock(w.id, s.session);
    expect(r.turn.timeout?.interruptedTool?.name).toBe("bash");
    expect(r.turn.timeout?.interruptedTool?.argsSummary).toContain("curl https://help.aliyun.com");
  });

  it("超时前它自己已经到达终态 → **不覆盖**它的判定,如实报 left_terminal", async () => {
    const w = mkWork();
    const s = hangingSession(() => updateWorkStatus(db, w.id, "done", AT + 5));
    const r = await runWithWallClock(w.id, s.session);
    expect(r.timeoutDisposition).toBe("left_terminal");
    expect(r.outcome, "done 是它自己的判定,超时不该把它改写成 timed_out").toBe("converged");
    expect(getWork(db, w.id)!.status).toBe("done");
  });

  it("超时前它自己登记了阻塞(blocked)→ **不覆盖**,如实报 left_blocked", async () => {
    const w = mkWork();
    const s = hangingSession(() => updateWorkStatus(db, w.id, "blocked", AT + 5));
    const r = await runWithWallClock(w.id, s.session);
    expect(r.timeoutDisposition).toBe("left_blocked");
    expect(r.outcome).toBe("blocked");
    expect(getWork(db, w.id)!.status).toBe("blocked");
  });

  it("报告写清「上界 / 打断 / 处置」—— 不静默(7-N)", async () => {
    const w = mkWork();
    const s = hangingSession(({ emit }) => {
      emit({
        type: "tool_execution_start", toolCallId: "c1", toolName: "bash",
        args: { command: "curl 文档" },
      } as unknown as AgentSessionEvent);
    });
    const rep = renderExecutionReport(await runWithWallClock(w.id, s.session));
    expect(rep).toContain("墙钟上界");
    expect(rep).toContain("session.abort()");
    expect(rep).toContain("打断瞬间在跑:bash");
    expect(rep).toContain("记为 failed");
    expect(rep).toContain("超时处置");
  });

  it("没有超时的未收敛**不**留下超时处置(新路径只对超时生效,不误伤普通回合)", async () => {
    const w = mkWork();
    const r = await run(w.id, saidDone("我做完了(但没改状态)"));
    expect(r.outcome).toBe("unconverged");
    expect(r.timeoutDisposition).toBeUndefined();
    expect(getWork(db, w.id)!.status).toBe("in_progress");
    expect(listPendingDispatchEvents(db, "p1"), "没超时就不该有下游事件").toEqual([]);
  });
});
