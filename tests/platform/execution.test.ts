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
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertWork, getWork, updateWorkStatus, type WorkRow } from "../../src/platform/storage/repo/works.js";
import { insertArtifact, listArtifacts } from "../../src/platform/storage/repo/artifacts.js";
import { insertBlocker } from "../../src/platform/storage/repo/blockers.js";
import { insertSession } from "../../src/platform/storage/repo/sessions.js";
import { listTurnUsage } from "../../src/platform/storage/repo/usage.js";
import { listPendingDispatchEvents } from "../../src/platform/storage/repo/dispatch.js";
import { collectPendingWork } from "../../src/platform/runtime/pendingWork.js";
import {
  runWorkItem, composeWorkPrompt, renderExecutionReport, workFinishedByCall,
  type ExecutionResult, type RunWorkOptions,
} from "../../src/platform/runtime/execution.js";
import type { TurnTimeoutCause } from "../../src/platform/runtime/turn.js";

/**
 * 027 起正文住文件:测试里仍从「想写的正文」造出**落点三列** ——
 * sha256 与字节数都是真的(`node:crypto` 现算),不是占位串;正文本身不再进库。
 * 夹具仍然说得出「这件工件的正文是这一句」,只是表达成 (落点, 哈希, 字节数)。
 */
function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

let db: Database.Database;
let seq = 0;
const AT = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertAgent(db, { id: "pm", role: "project_manager", specialization: null, displayName: "项目经理", createdAt: AT });
  insertAgent(db, { id: "wk", role: "research_worker", specialization: "engineering", displayName: "研究员", createdAt: AT });
  insertAgent(db, { id: "wk2", role: "research_worker", specialization: "data", displayName: "数据", createdAt: AT });
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: AT });
  for (const id of ["pm", "wk", "wk2"]) addMember(db, "p1", id, AT);
});
afterEach(() => db.close());

function mkWork(over: Partial<WorkRow> = {}): WorkRow {
  const w: WorkRow = {
    id: `w_${++seq}`, projectId: "p1", parentWorkId: null,
    title: "写一个接口", goal: "给用户列表加分页",
    status: "open", confirmedAt: 1, assigneeAgentId: "wk",
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
      deltaKind: "text", delta: msg ,
    } as RuntimeEvent);
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

  it("负责人不是执行角色 → refused", async () => {
    const w = mkWork({ assigneeAgentId: "pm" });
    const r = await run(w.id, saidDone());
    expect(r.outcome).toBe("refused");
    expect(r.refusalReason).toContain("不是执行角色");
    expect(r.refusalReason).toContain("执行是执行角色的能力");
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
  it("只把**这一回合新写的、且沿 014 产出边挂到这条工作项上的**工件算作产出", async () => {
    // 回合前就已经挂着这条边的工件(典型:上一次审查留下的 review_finding,
    // 或上一次跑留下的 evidence)不算这一回合的产出
    const w = mkWork();
    insertArtifact(db, {
      id: "art_old", projectId: "p1", conversationId: null, kind: "note", status: "open",
      authorAgentId: "wk", title: "旧的", ...bodyAt("artifacts/art_old.md", "b"), metadataJson: null,
      createdAt: AT, updatedAt: AT, workId: w.id,
    });
    // 同项目、同一作者、但**没有**挂到这条工作项上的工件(别的回合的产出)
    insertArtifact(db, {
      id: "art_loose", projectId: "p1", conversationId: null, kind: "evidence", status: "open",
      authorAgentId: "wk", title: "没挂边", ...bodyAt("artifacts/art_loose.md", "b"), metadataJson: null,
      createdAt: AT, updatedAt: AT,
    });
    const r = await run(w.id, fakeSession(() => {
      insertArtifact(db, {
        id: "art_new", projectId: "p1", conversationId: null, kind: "evidence", status: "open",
        authorAgentId: "wk", title: "新的", ...bodyAt("artifacts/art_new.md", "b"), metadataJson: null,
        createdAt: AT + 1, updatedAt: AT + 1, workId: w.id,
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
      emit({ type: "tool_start", toolCallId: "c1", toolName: "board_write", args: { kind: "note" } } as RuntimeEvent);
      emit({ type: "tool_end", toolCallId: "c1", toolName: "board_write",
        result: { content: [{ type: "text", text: "已写工件" }], details: { ok: true } }, isError: false,
      } as RuntimeEvent);
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
      status: "open", confirmedAt: 1, assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
      acceptanceCriteria: [],
    });
    expect(p).toContain("w1");
    expect(p).toContain("写接口");
    expect(p).toContain("加分页");
  });

  it("**明说工件就是交付物**,不需要另写总结来汇报(BC6 的核心变化)", () => {
    const p = composeWorkPrompt({
      id: "w1", projectId: "p1", parentWorkId: null, title: "t", goal: "g",
      status: "open", confirmedAt: 1, assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
      acceptanceCriteria: [],
    });
    expect(p).toContain("board_write");
    expect(p).toContain("工件就是你的交付物");
    expect(p).toContain("work.update");
    expect(p).toContain("blocker_open");
  });

  it("带上工作项级验收判据 —— 执行者在动手前就要看到「做成什么样算做成」(2026-11-27;此前只摆给质检看)", () => {
    const withCriteria = composeWorkPrompt({
      id: "w1", projectId: "p1", parentWorkId: null, title: "写接口", goal: "加分页",
      status: "open", confirmedAt: 1, assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
      acceptanceCriteria: ["翻页响应 < 200ms", "空页返回空数组而不是报错"],
    });
    expect(withCriteria).toContain("验收判据");
    expect(withCriteria).toContain("  1. 翻页响应 < 200ms");
    expect(withCriteria).toContain("  2. 空页返回空数组而不是报错");
    // 负样本:没给判据的工作项不摆一个空的「验收判据」标题(空标题比没有更糟)
    const none = composeWorkPrompt({
      id: "w1", projectId: "p1", parentWorkId: null, title: "写接口", goal: "加分页",
      status: "open", confirmedAt: 1, assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
      acceptanceCriteria: [],
    });
    expect(none).not.toContain("验收判据");
  });

  it("真跑一个带验收判据的工作项:任务正文里带着它(从库里读出来,不是测试塞进去的)", async () => {
    const w = mkWork({ acceptanceCriteria: ["响应里有 total 字段"] });
    let seen = "";
    const r = await run(w.id, fakeSession(({ emit, text }) => {
      seen = text;
      emit({ type: "message_update", message: {}, deltaKind: "text", delta: "好" } as RuntimeEvent);
    }));
    expect(r.outcome).not.toBe("refused");
    expect(seen).toContain("验收判据");
    expect(seen).toContain("  1. 响应里有 total 字段");
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
      emit({ type: "tool_start", toolCallId: "c1", toolName: "bash",
        args: { command: "curl https://help.aliyun.com/document_detail/..." },
      } as RuntimeEvent);
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
      emit({ type: "tool_start", toolCallId: "c1", toolName: "bash",
        args: { command: "curl 文档" },
      } as RuntimeEvent);
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

// ══════════════════════════════════════════════════════════════════
// 看门狗三道闸到点后的处置(2026-11-25)—— 与墙钟走同一条路
// ══════════════════════════════════════════════════════════════════
//
// 判的是「还在不在动」:无进展 / 单工具过长 / 工具次数到顶。下游处置**一个字不改**
// (记 failed、写出 work_failed、现场带得回来)—— 所以三道闸用同一份断言逐道过。

/** 跑一个工作项,只留**被测的那一道闸**(其余推到很远;不真等 10 分钟)。 */
async function runWithWatchdog(
  workId: string, session: AgentSession, gate: Partial<RunWorkOptions>,
): Promise<ExecutionResult> {
  return runWorkItem({
    session, db, workId, timeoutMs: 10_000, injectPending: false, abortGraceMs: 50,
    idleTimeoutMs: 60_000, toolTimeoutMs: 60_000, maxToolCalls: 1_000, ...gate,
  });
}

const GATES: ReadonlyArray<{
  cause: TurnTimeoutCause;
  gate: Partial<RunWorkOptions>;
  script: (ctx: { emit: (ev: AgentSessionEvent) => void; text: string }) => void;
}> = [
  { cause: "idle", gate: { idleTimeoutMs: 40 }, script: () => {} },
  {
    cause: "tool",
    gate: { toolTimeoutMs: 40 },
    script: ({ emit }) => {
      emit({ type: "tool_start", toolCallId: "c1", toolName: "bash", args: { command: "curl 文档" } } as RuntimeEvent);
    },
  },
  {
    cause: "tool_count",
    gate: { maxToolCalls: 1 },
    script: ({ emit }) => {
      emit({ type: "tool_start", toolCallId: "c1", toolName: "board_list", args: {} } as RuntimeEvent);
      emit({ type: "tool_end", toolCallId: "c1", toolName: "board_list", result: { content: [] }, isError: false } as RuntimeEvent);
      // 第 2 次开始 ⇒ 到顶(上限 1)。
      emit({ type: "tool_start", toolCallId: "c2", toolName: "board_read", args: { id: "a1" } } as RuntimeEvent);
    },
  },
];

describe("runWorkItem · 看门狗三道闸到点后的处置(与墙钟同一条路)", () => {
  for (const g of GATES) {
    it(`${g.cause} 到点 ⇒ 记 failed(终态)+ 写出 work_failed + 现场写明原因`, async () => {
      const w = mkWork();
      const s = hangingSession(g.script);
      const r = await runWithWatchdog(w.id, s.session, g.gate);

      expect(s.aborts, "abort() 必须真的被调到").toBe(1);
      expect(r.outcome).toBe("timed_out");
      expect(r.timeoutDisposition).toBe("marked_failed");
      expect(r.turn.timeout?.cause, "现场要说得出是哪一道闸").toBe(g.cause);
      expect(getWork(db, w.id)!.status).toBe("failed");
      // 下游事件照旧 —— 业务经理据此向甲方交代,与墙钟超时同一个落点。
      expect(listPendingDispatchEvents(db, "p1").map((e) => e.kind)).toEqual(["work_failed"]);
    });
  }

  it("到点前它自己已经到达终态 ⇒ **不覆盖**它的判定(看门狗不是改判的理由)", async () => {
    const w = mkWork();
    const s = hangingSession(() => updateWorkStatus(db, w.id, "done", AT + 5));
    const r = await runWithWatchdog(w.id, s.session, { idleTimeoutMs: 40 });
    expect(r.timeoutDisposition).toBe("left_terminal");
    expect(r.outcome).toBe("converged");
    expect(getWork(db, w.id)!.status).toBe("done");
  });

  it("报告首行写明是哪一道闸(事后分得清「跑得久」与「不动了」)", async () => {
    const w = mkWork();
    const s = hangingSession(GATES[0]!.script);
    const rep = renderExecutionReport(await runWithWatchdog(w.id, s.session, GATES[0]!.gate));
    expect(rep).toContain("无进展到点");
    expect(rep).toContain("记为 failed");
  });

  it("负样本:三道闸都没到点的回合不留下任何超时处置", async () => {
    const w = mkWork();
    const r = await run(w.id, saidDone("我做完了(但没改状态)"));
    expect(r.outcome).toBe("unconverged");
    expect(r.timeoutDisposition).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// 任务 1 · 产出采集接读方(014 的产出边)
//
// Wave 1 给 `artifacts` 加了 `work_id`,但 `runWorkItem` 还在用**项目级集合差**
// —— 它连 `author_agent_id` 都不读,同项目两回合交叠时会互相认领对方的产出。
// 下面这一组钉住新判据,以及那条边的**已知歧义**怎么被挡住。
// ══════════════════════════════════════════════════════════════════

describe("任务 1 · 产出采集走 014 的产出边", () => {
  it("**同项目另一条工作项的产出不会被认领**(修掉的正是这个 bug)", async () => {
    const mine = mkWork();
    const other = mkWork();
    const r = await run(mine.id, fakeSession(() => {
      // 交叠的另一个回合:它产出的是**它自己那条**工作项的工件
      insertArtifact(db, {
        id: "art_theirs", projectId: "p1", conversationId: null, kind: "evidence", status: "open",
        authorAgentId: "wk", title: "别人的", ...bodyAt("artifacts/art_theirs.md", "b"), metadataJson: null,
        createdAt: AT + 1, updatedAt: AT + 1, workId: other.id,
      });
      insertArtifact(db, {
        id: "art_mine", projectId: "p1", conversationId: null, kind: "evidence", status: "open",
        authorAgentId: "wk", title: "我的", ...bodyAt("artifacts/art_mine.md", "b"), metadataJson: null,
        createdAt: AT + 1, updatedAt: AT + 1, workId: mine.id,
      });
    }));
    expect(
      r.producedArtifacts.map((a) => a.id),
      "旧的集合差判据会把 art_theirs 也算成我的产出",
    ).toEqual(["art_mine"]);
  });

  it("质检意见**不算产出**,但它那条边**保留**(那是它唯一能记的链接)", async () => {
    insertAgent(db, {
      id: "qa", role: "quality_reviewer", specialization: null,
      displayName: "质检", createdAt: AT,
    });
    const w = mkWork();
    const r = await run(w.id, fakeSession(() => {
      // 真机第一跑就发生的形状:质检把 review_finding 挂到**被审的**工作项上。
      // 这里由另一个 agent 写(worker 的 writeKinds 里没有 review_finding),
      // 模拟「质检回合与 worker 回合交叠」—— 02 判据挡不住它,03 才挡得住。
      insertArtifact(db, {
        id: "art_finding", projectId: "p1", conversationId: null,
        kind: "review_finding", status: "open",
        authorAgentId: "qa", title: "审查意见", ...bodyAt("artifacts/art_finding.md", "b"), metadataJson: null,
        createdAt: AT + 1, updatedAt: AT + 1, workId: w.id,
      });
    }));
    expect(r.producedArtifacts.map((a) => a.id), "质检意见不是这条工作项的交付物").toEqual([]);
    expect(
      listArtifacts(db, "p1", { workId: w.id }).map((a) => a.kind),
      "⚠️ 那条边必须还在 —— `work_id` 是 review_finding 唯一能表达「关于哪条工作项」的地方",
    ).toEqual(["review_finding"]);
  });

  it("**别的人**挂在它上面的工件不算产出(边是「关于」,不是「产出」)", async () => {
    const w = mkWork();
    const r = await run(w.id, fakeSession(() => {
      insertArtifact(db, {
        id: "art_pm", projectId: "p1", conversationId: null, kind: "work_brief", status: "open",
        authorAgentId: "pm", title: "项目经理补充的简述", ...bodyAt("artifacts/art_pm.md", "b"), metadataJson: null,
        createdAt: AT + 1, updatedAt: AT + 1, workId: w.id,
      });
      insertArtifact(db, {
        id: "art_wk", projectId: "p1", conversationId: null, kind: "evidence", status: "open",
        authorAgentId: "wk", title: "我的证据", ...bodyAt("artifacts/art_wk.md", "b"), metadataJson: null,
        createdAt: AT + 1, updatedAt: AT + 1, workId: w.id,
      });
    }));
    expect(r.producedArtifacts.map((a) => a.id)).toEqual(["art_wk"]);
  });

  it("**没挂边**的工件不算产出(边是显式的,平台不猜「当前工作项」)", async () => {
    const w = mkWork();
    const r = await run(w.id, fakeSession(() => {
      insertArtifact(db, {
        id: "art_no_edge", projectId: "p1", conversationId: null, kind: "note", status: "open",
        authorAgentId: "wk", title: "忘了挂边", ...bodyAt("artifacts/art_no_edge.md", "b"), metadataJson: null,
        createdAt: AT + 1, updatedAt: AT + 1,
      });
    }));
    expect(r.producedArtifacts).toEqual([]);
    // 但工件本身在库里(丢的是「这一条工作项的产出」这条关系,不是数据)
    expect(listArtifacts(db, "p1").map((a) => a.id)).toEqual(["art_no_edge"]);
  });

  it("任务描述里**点名了**要挂边的那一句(边的写入侧:不叫它传,边就永远是空的)", () => {
    const p = composeWorkPrompt({
      id: "w1", projectId: "p1", parentWorkId: null, title: "t", goal: "g",
      status: "open", confirmedAt: 1, assigneeAgentId: "wk", createdAt: AT, updatedAt: AT,
      acceptanceCriteria: [],
    });
    expect(p).toContain("workId");
    expect(p).toContain('"w1"');
  });
});

// ── 用量归属(T3 的透传:工作项 / 会话 / 推送回调)──────────────────
//
// `turn_usage` 的三格(`work_id` / `session_id`)里,前者的真值**只在
// `runWorkItem` 手里** —— `runTurn` 不知道自己在干哪个工作项。所以这条透传
// 必须有机器形式:不传的话那一格永远是 NULL,而「这条活花了多少」在库里
// 就查不出来了(静默丢字段,不是报错)。

/** 一条带真 usage 的 assistant `message_end`。 */
const usageEnd = (input: number, output: number, cacheRead: number) =>
  ({
    type: "message_end",
    message: {
      role: "assistant", model: "claude-sonnet-4-20250514",
      usage: {
        input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  }) as RuntimeEvent;

describe("runWorkItem · 用量落库归属", () => {
  it("★ `workId` 透传进 `runTurn` ⇒ `turn_usage.work_id` 不是 NULL", async () => {
    const w = mkWork();
    const session = fakeSession(({ emit }) => {
      emit(usageEnd(100, 5, 3));
    });
    const r = await runWorkItem({ session, db, workId: w.id, timeoutMs: 1000, injectPending: false });

    const rows = listTurnUsage(db, "p1", { since: 0, until: Number.MAX_SAFE_INTEGER });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workId, "「这条活花了多少」必须在库里查得出来").toBe(w.id);
    expect([rows[0]!.inputTokens, rows[0]!.outputTokens, rows[0]!.cacheRead]).toEqual([100, 5, 3]);
    expect(r.turn.usage!.input).toBe(100);
  });

  it("`sessionId` 与 `onUsageRecorded` 也透传(两条执行路径都接)", async () => {
    insertSession(db, { id: "s_wk", projectId: "p1", createdAt: AT });
    const w = mkWork();
    const session = fakeSession(({ emit }) => {
      emit(usageEnd(7, 2, 1));
    });
    const seen: Array<{ id: string; sessionId: string | null }> = [];
    await runWorkItem({
      session, db, workId: w.id, timeoutMs: 1000, injectPending: false,
      sessionId: "s_wk",
      onUsageRecorded: (row) => seen.push({ id: row.id, sessionId: row.sessionId }),
    });

    const rows = listTurnUsage(db, "p1", { since: 0, until: Number.MAX_SAFE_INTEGER });
    expect(rows[0]!.sessionId).toBe("s_wk");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(rows[0]!.id);
    expect(seen[0]!.sessionId).toBe("s_wk");
  });

  it("refused(不该跑)的回合**不写账** —— 一行都没有", async () => {
    const w = mkWork({ status: "done" });
    const r = await run(w.id, saidDone());
    expect(r.outcome).toBe("refused");
    expect(listTurnUsage(db, "p1", { since: 0, until: Number.MAX_SAFE_INTEGER })).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════
// 活干完即停(2026-11-28 真模型实验之后)
// ══════════════════════════════════════════════════════════════════
//
// 真模型实验:工程师在 `work.update` 改成 done **之后**又花了几十次调用(读三生源码、
// 翻服务日志);研究员一轮跑了 88 次工具。活已经做完,后面的全是白烧。
// 现在工作项一到终态,平台就在那一步结束这一轮 —— 判据读库(不信参数),
// `runTurn` 只负责「判完了就停」(它自己的测试在 turn.test.ts)。

describe("活干完即停 · 判据 workFinishedByCall", () => {
  it("三条同时成立才算:「是 work_update」×「调用没失败」×「库里这条工作项已是终态」", () => {
    const w = mkWork({ status: "in_progress" });
    expect(workFinishedByCall(db, w.id, { name: "work_update", isError: false }),
      "还没到终态").toBeNull();
    expect(workFinishedByCall(db, w.id, { name: "board_write", isError: false }),
      "别的工具把活干完了也不算(判据只认状态写口)").toBeNull();
    updateWorkStatus(db, w.id, "done", AT + 1);
    expect(workFinishedByCall(db, w.id, { name: "board_write", isError: false }),
      "已到终态之后别的工具成功返回也不算(判据只认 work_update 那一次调用)").toBeNull();
    expect(workFinishedByCall(db, w.id, { name: "work_update", isError: true }),
      "调用失败不算办完").toBeNull();
    expect(workFinishedByCall(db, w.id, { name: "work_update", isError: false }))
      .toContain("(done)");
  });
});

describe("活干完即停 · runWorkItem 接线", () => {
  /** 假会话:发一次 work_update 的工具事件(库里真改成 done),然后模型还想接着调工具。 */
  function doneThenKeepsGoing(workId: string, onAbort: () => void): AgentSession {
    const listeners: Array<(ev: AgentSessionEvent) => void> = [];
    return {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.push(fn);
        return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
      },
      async prompt() {
        const emit = (ev: unknown) => { for (const l of [...listeners]) l(ev as AgentSessionEvent); };
        emit({ type: "tool_start", toolCallId: "t1", toolName: "work_update", args: { workId, status: "done" } });
        updateWorkStatus(db, workId, "done", AT + 1); // 工具的效果:库里的状态
        emit({ type: "tool_end", toolCallId: "t1", toolName: "work_update", result: { ok: true }, isError: false });
        // 模型没停:又调了一次工具(真机上它接着去读三生的源码、翻日志)
        emit({ type: "tool_start", toolCallId: "t2", toolName: "bash", args: { command: "ls" } });
        emit({ type: "tool_end", toolCallId: "t2", toolName: "bash", result: { ok: true }, isError: false });
        emit({ type: "agent_settled" });
      },
      abort() { onAbort(); },
      dispose() {},
      getActiveToolNames() { return []; },
    } as unknown as AgentSession;
  }

  it("工作项到终态 ⇒ 平台 abort 一次、`finishedBy` 带回、结局按库判 done —— 不是超时也不是中断", async () => {
    const w = mkWork({ status: "in_progress" });
    let aborts = 0;
    const r = await runWorkItem({
      session: doneThenKeepsGoing(w.id, () => { aborts += 1; }),
      db, workId: w.id, timeoutMs: 1000, injectPending: false,
    });
    expect(aborts, "活干完那一步就该 abort(不再买下一次模型调用)").toBe(1);
    expect(r.turn.finishedBy).toContain("(done)");
    expect(r.finishedBy).toBe(r.turn.finishedBy);
    expect(r.turn.timedOut).toBe(false);
    expect(r.turn.timeout, "不是被打断 / 超时").toBeUndefined();
    expect(r.outcome).toBe("converged");
    expect(renderExecutionReport(r)).toContain("平台在这一步结束了这一轮");
  });

  it("另一条工作项被标成 done 不算(只认本回合执行的那条)", async () => {
    const mine = mkWork({ status: "in_progress" });
    const other = mkWork({ status: "in_progress" });
    let aborts = 0;
    const listeners: Array<(ev: AgentSessionEvent) => void> = [];
    const session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) { listeners.push(fn); return () => {}; },
      async prompt() {
        const emit = (ev: unknown) => { for (const l of [...listeners]) l(ev as AgentSessionEvent); };
        emit({ type: "tool_start", toolCallId: "t1", toolName: "work_update", args: { workId: other.id, status: "done" } });
        updateWorkStatus(db, other.id, "done", AT + 1);
        emit({ type: "tool_end", toolCallId: "t1", toolName: "work_update", result: { ok: true }, isError: false });
        emit({ type: "agent_settled" });
      },
      abort() { aborts += 1; },
      dispose() {},
      getActiveToolNames() { return []; },
    } as unknown as AgentSession;
    const r = await runWorkItem({ session, db, workId: mine.id, timeoutMs: 1000, injectPending: false });
    expect(aborts).toBe(0);
    expect(r.turn.finishedBy).toBeUndefined();
    expect(r.outcome, "本回合那条还 in_progress ⇒ 如实未收敛").toBe("unconverged");
  });

  it("`stopWhenDone: false` 关掉它(演「标完 done 还继续折腾」的测试用)", async () => {
    const w = mkWork({ status: "in_progress" });
    let aborts = 0;
    const r = await runWorkItem({
      session: doneThenKeepsGoing(w.id, () => { aborts += 1; }),
      db, workId: w.id, timeoutMs: 1000, injectPending: false, stopWhenDone: false,
    });
    expect(aborts).toBe(0);
    expect(r.turn.finishedBy).toBeUndefined();
  });

  it("任务正文把顺序讲清:`work.update` 是这一轮的最后一个动作,工件与经验都在它之前", () => {
    const w = mkWork();
    const p = composeWorkPrompt(getWork(db, w.id)!);
    expect(p).toContain("**那是这一轮的最后一个动作**");
    expect(p).toContain("状态一变成终态,平台就在这一步结束这一轮");
    expect(p).toContain("要写的工件、要记的经验,都放在它**之前**做完");
    // 收工提醒(记经验)与这条顺序说的是同一件事
    expect(p).toContain("experience_save");
  });
});
