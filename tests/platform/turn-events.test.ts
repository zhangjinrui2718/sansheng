/**
 * 执行日志(migration 035 · `turn_events`)· 回归
 *
 * ── 这个机制补的是什么 ──────────────────────────────────────────
 *
 * 「他做了什么」此前只在 stdout 里:`TurnResult.toolCalls` 抓得全,但只被
 * 渲染成散文报告随日志漂走。真机上排查 unanswered_turn / 墙钟超时 / 空转,
 * 全都只能翻日志。本文件钉住:那份现场**落库**了,按回合分组、组内 seq 单调,
 * 且「什么都没发生的回合一行不写」(不假装记过)。
 *
 * ── 三种粒度不混装(与 018 同一条纪律)────────────────────────────
 *
 * 正文在 `session_messages`、账在 `turn_usage`、轨迹在本表 —— 本文件只断言
 * 轨迹;`tests/platform/unanswered-turn.test.ts` 管正文判据,
 * 用量归 `tests/platform/` 的 usage 相关文件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertSession } from "../../src/platform/storage/repo/sessions.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import {
  listTurnEventsByAgent, listTurnEventsByTurn,
} from "../../src/platform/storage/repo/turnEvents.js";
import { agentTurnEvents } from "../../src/platform/transport/http.js";
import { runTurn } from "../../src/platform/runtime/turn.js";
import type { RuntimeEvent } from "../../src/platform/runtime/agentRuntime/types.js";

let db: Database.Database;

beforeEach(() => {
  db = openPlatformMemoryDb();
  insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: 1 });
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: 1 });
  addMember(db, "p1", "bm", 1);
  insertSession(db, { id: "s1", projectId: "p1", createdAt: 1, channel: "internal" });
  insertWork(db, {
    id: "wk1", projectId: "p1", parentWorkId: null,
    title: "调研", goal: "查清楚", status: "open",
    assigneeAgentId: "bm", createdAt: 1, updatedAt: 1,
  });
});
afterEach(() => db.close());

// ── 脚本化假会话(与 unanswered-turn.test.ts 同一套形状)──────────

function fakeSession(
  script: (emit: (ev: AgentSessionEvent) => void) => void | "never",
): AgentSession {
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt() {
      const emit = (ev: AgentSessionEvent) => { for (const l of [...listeners]) l(ev); };
      const r = script(emit);
      if (r !== "never") emit({ type: "agent_settled" });
      return { messages: [] };
    },
    async abort() {},
    dispose() {},
  };
  return session as unknown as AgentSession;
}

const textDelta = (delta: string) =>
  ({ type: "message_update", message: {}, deltaKind: "text", delta }) as RuntimeEvent;
const toolStart = (id: string, name: string, args: unknown) =>
  ({ type: "tool_start", toolCallId: id, toolName: name, args }) as RuntimeEvent;
const toolEnd = (id: string, name: string, result: unknown, isError = false) =>
  ({ type: "tool_end", toolCallId: id, toolName: name, result, isError }) as RuntimeEvent;
const messageEnd = (message: unknown) =>
  ({ type: "message_end", message }) as RuntimeEvent;

async function turn(
  script: Parameters<typeof fakeSession>[0],
  over: Partial<Parameters<typeof runTurn>[0]> = {},
): Promise<void> {
  await runTurn({
    session: fakeSession(script), db, agentId: "bm", projectId: "p1",
    message: "做点事", timeoutMs: 2000,
    ...over,
  });
}

// ── ① 工具轨迹 ──────────────────────────────────────────────────

describe("turn_events · 工具调用逐条落库", () => {
  it("两次调用 = 两行,seq 单调,名字/成败/时长都在", async () => {
    await turn((emit) => {
      emit(textDelta("我先查一下。"));
      emit(toolStart("t1", "memory_search", { query: "偏好" }));
      emit(toolEnd("t1", "memory_search", { content: [{ text: "命中 1 条" }] }));
      emit(toolStart("t2", "board_list", {}));
      emit(toolEnd("t2", "board_list", { content: [{ text: "3 条工件" }] }));
      emit(textDelta("查完了,结论是……"));
    });
    const rows = listTurnEventsByAgent(db, "p1", "bm");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "tool")).toBe(true);
    expect(rows.map((r) => [r.seq, r.tool])).toEqual([
      [1, "memory_search"],
      [2, "board_list"],
    ]);
    // 同一回合共用 turn_id —— 分组键存在,不是各行各一个。
    expect(new Set(rows.map((r) => r.turnId)).size).toBe(1);
    expect(rows[0]!.isError).toBe(false);
    expect(rows[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(rows[0]!.argsSummary).toContain("偏好");
    expect(rows[0]!.resultSummary).toContain("命中 1 条");
  });

  it("失败的工具调用 is_error=1 —— 「哪些失败过」是排查的第一问", async () => {
    await turn((emit) => {
      emit(toolStart("t1", "board_read", { id: "a1" }));
      emit(toolEnd("t1", "board_read", { content: [{ text: "没有这条工件" }] }, true));
      emit(textDelta("没读到,我换个思路。"));
    });
    const rows = listTurnEventsByAgent(db, "p1", "bm");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isError).toBe(true);
  });

  it("sessionId / workId 由调用方传入并如实落列", async () => {
    await turn(
      (emit) => {
        emit(toolStart("t1", "board_list", {}));
        emit(toolEnd("t1", "board_list", { content: [] }));
        emit(textDelta("好的。"));
      },
      { sessionId: "s1", workId: "wk1" },
    );
    const rows = listTurnEventsByAgent(db, "p1", "bm");
    expect(rows[0]!.sessionId).toBe("s1");
    expect(rows[0]!.workId).toBe("wk1");
  });

  it("什么都没发生的回合一行不写 —— 不假装记过", async () => {
    await turn((emit) => {
      emit(textDelta("这是一段正文,没有工具、没有故障。"));
    });
    expect(listTurnEventsByAgent(db, "p1", "bm")).toHaveLength(0);
  });
});

// ── ② provider 故障与回合级标记 ──────────────────────────────────

describe("turn_events · provider 故障与回合级标记", () => {
  it("provider 拒绝 ⇒ 一行 provider_error(分类 + 原文),不叠 unanswered 标记", async () => {
    await turn((emit) => {
      emit(messageEnd({
        role: "assistant", stopReason: "error",
        errorMessage: "429 too many requests",
      }));
    });
    const rows = listTurnEventsByAgent(db, "p1", "bm");
    const err = rows.filter((r) => r.kind === "provider_error");
    expect(err).toHaveLength(1);
    expect(err[0]!.resultSummary).toContain("rate_limit");
    expect(err[0]!.resultSummary).toContain("429");
    expect(err[0]!.isError).toBe(true);
    // provider 故障不走 unanswered 通道(报多了没人看)—— 标记行不存在。
    expect(rows.some((r) => r.resultSummary.includes("没有给出下文"))).toBe(false);
  });

  it("有下文之外无标记的普通回合,标记行零条(负样本)", async () => {
    await turn((emit) => {
      emit(toolStart("t1", "board_list", {}));
      emit(toolEnd("t1", "board_list", { content: [] }));
      emit(textDelta("说完了。"));
    });
    expect(
      listTurnEventsByAgent(db, "p1", "bm").filter((r) => r.kind === "marker"),
    ).toHaveLength(0);
  });

  it("墙钟上界打断 ⇒ 一行 marker,现场(打断瞬间在跑什么)在里面", async () => {
    await turn(
      () => "never",
      { timeoutMs: 60_000, wallClockTimeoutMs: 30, abortGraceMs: 50 },
    );
    const rows = listTurnEventsByAgent(db, "p1", "bm");
    const markers = rows.filter((r) => r.kind === "marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.resultSummary).toContain("墙钟上界");
    expect(markers[0]!.isError).toBe(true);
  }, 10_000);
});

// ── ③ 读面 ──────────────────────────────────────────────────────

describe("turn_events · 读面(agentTurnEvents / 单回合回放)", () => {
  it("按回合分组:两个回合两个 turnId,最新在前,组内 seq 升序", async () => {
    await turn((emit) => {
      emit(toolStart("t1", "board_list", {}));
      emit(toolEnd("t1", "board_list", { content: [] }));
      emit(textDelta("第一回合。"));
    });
    await new Promise((r) => setTimeout(r, 5));
    await turn((emit) => {
      emit(toolStart("t2", "memory_search", { query: "x" }));
      emit(toolEnd("t2", "memory_search", { content: [] }));
      emit(toolStart("t3", "board_read", { id: "a1" }));
      emit(toolEnd("t3", "board_read", { content: [] }));
      emit(textDelta("第二回合。"));
    });
    const view = agentTurnEvents(db, "p1", "bm", 50);
    expect(view.turns).toHaveLength(2);
    // 最新在前(第二回合两个工具在前)。
    expect(view.turns[0]!.events.map((e) => e.tool)).toEqual([
      "memory_search", "board_read",
    ]);
    expect(view.turns[0]!.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(view.turns[0]!.sessionId).toBeNull(); // 调用方没传就如实是 null

    // 单回合回放:任取一个 turnId,行序 = seq。
    const tid = view.turns[0]!.turnId;
    const single = listTurnEventsByTurn(db, tid);
    expect(single.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("没有轨迹的成员是空 turns,不是读不到(空与读不到不是一回事)", () => {
    const view = agentTurnEvents(db, "p1", "bm", 50);
    expect(view.turns).toEqual([]);
  });
});
