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
 *
 * ── 逐条写 + 收口行(2026-11-25)────────────────────────────────────
 *
 * 工具行在**那次调用结束时**就落库(回合还在跑也读得到),收口时补故障 / 标记,
 * 最后写一行 `turn_end` 当「已结束」的库里凭据。④–⑥ 钉这一组:
 * 进行中可读、先落库后广播、没有收口行的回合读成 `finished: false`、
 * 写失败过的回合不盖「已结束」的章。
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
  insertTurnEvents, listTurnEventsByAgent, listTurnEventsByTurn,
} from "../../src/platform/storage/repo/turnEvents.js";
import { agentTurnEvents, createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { AgentTurnEventsResponse } from "@shared/types/platform.js";
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

/** 只看工具行(收口行 `turn_end` 不是工具调用)。 */
const toolRows = (): ReturnType<typeof listTurnEventsByAgent> =>
  listTurnEventsByAgent(db, "p1", "bm").filter((r) => r.kind === "tool");

describe("turn_events · 工具调用逐条落库", () => {
  it("两次调用 = 两行工具行 + 一行收口行,seq 单调,名字/成败/时长都在", async () => {
    await turn((emit) => {
      emit(textDelta("我先查一下。"));
      emit(toolStart("t1", "memory_search", { query: "偏好" }));
      emit(toolEnd("t1", "memory_search", { content: [{ text: "命中 1 条" }] }));
      emit(toolStart("t2", "board_list", {}));
      emit(toolEnd("t2", "board_list", { content: [{ text: "3 条工件" }] }));
      emit(textDelta("查完了,结论是……"));
    });
    const all = listTurnEventsByAgent(db, "p1", "bm").sort((a, b) => a.seq - b.seq);
    const rows = toolRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.seq, r.tool])).toEqual([
      [1, "memory_search"],
      [2, "board_list"],
    ]);
    // 收口行接在最后:这一回合「已结束」的库里凭据。
    expect(all.map((r) => [r.seq, r.kind])).toEqual([
      [1, "tool"], [2, "tool"], [3, "turn_end"],
    ]);
    expect(all[2]!.isError).toBe(false);
    // 同一回合共用 turn_id —— 分组键存在,不是各行各一个。
    expect(new Set(all.map((r) => r.turnId)).size).toBe(1);
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
    const rows = toolRows();
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
    const rows = toolRows();
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

  it("看门狗到点(无进展)同样一行 marker,写明是哪一道闸(2026-11-25)", async () => {
    await turn(
      () => "never",
      { timeoutMs: 60_000, idleTimeoutMs: 30, abortGraceMs: 50 },
    );
    const markers = listTurnEventsByAgent(db, "p1", "bm").filter((r) => r.kind === "marker");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.resultSummary).toContain("无进展 30ms 到点打断");
    expect(markers[0]!.resultSummary).not.toContain("墙钟上界");
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
    // 两个回合都已收口;收口行不进事件(它只当凭据)。
    expect(view.turns.map((t) => t.finished)).toEqual([true, true]);
    expect(view.turns.every((t) => t.events.every((e) => e.kind !== "turn_end"))).toBe(true);

    // 单回合回放:任取一个 turnId,行序 = seq(库里连收口行一共 3 行)。
    const tid = view.turns[0]!.turnId;
    const single = listTurnEventsByTurn(db, tid);
    expect(single.map((r) => [r.seq, r.kind])).toEqual([
      [1, "tool"], [2, "tool"], [3, "turn_end"],
    ]);
  });

  it("没有轨迹的成员是空 turns,不是读不到(空与读不到不是一回事)", () => {
    const view = agentTurnEvents(db, "p1", "bm", 50);
    expect(view.turns).toEqual([]);
  });
});

// ── ④ 逐条写:回合还在跑就读得到 ─────────────────────────────────

/**
 * 一个「跑一半停住」的假会话:发完一次工具调用之后挂起,直到 `release()`。
 * 用来在**回合还没结束**的那一刻去读库。
 */
function holdableSession(): {
  session: AgentSession;
  /** 工具行已经发出去(此时回合仍在跑) */
  afterTool: Promise<void>;
  release: () => void;
} {
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  let markTool: () => void = () => {};
  const afterTool = new Promise<void>((res) => { markTool = res; });
  let release: () => void = () => {};
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt() {
      // 与本文件其余假会话同一条纪律:直接当**平台会话**用,发平台方言的事件。
      const emit = (ev: AgentSessionEvent) => { for (const l of [...listeners]) l(ev); };
      emit({ type: "tool_start", toolCallId: "t1", toolName: "board_list", args: {} });
      emit({
        type: "tool_end", toolCallId: "t1", toolName: "board_list",
        result: { content: [{ type: "text", text: "3 条工件" }] }, isError: false,
      });
      markTool();
      await new Promise<void>((res) => { release = res; });
      // 收尾时给一句正文 ⇒ 不产生「没有给出下文」的标记行,断言只盯工具行与收口行。
      emit({ type: "message_update", deltaKind: "text", delta: "查完了。" });
      emit({ type: "agent_settled" });
      return { messages: [] };
    },
    async abort() {},
    dispose() {},
  };
  return {
    session: session as unknown as AgentSession,
    afterTool,
    release: () => release(),
  };
}

describe("turn_events · 逐条写:回合还在跑就读得到", () => {
  it("④ 回合没结束,工具行已经在库里;读面如实标「未收口」,收口后才翻成已结束", async () => {
    const h = holdableSession();
    const running = runTurn({
      session: h.session, db, agentId: "bm", projectId: "p1",
      message: "做点事", timeoutMs: 60_000,
    });
    await h.afterTool;

    // 回合仍在跑 —— 行已经在。
    expect(toolRows().map((r) => r.tool)).toEqual(["board_list"]);
    const mid = agentTurnEvents(db, "p1", "bm", 50);
    expect(mid.turns).toHaveLength(1);
    expect(mid.turns[0]!.finished).toBe(false);
    expect(mid.turns[0]!.events.map((e) => e.tool)).toEqual(["board_list"]);

    h.release();
    await running;

    const done = agentTurnEvents(db, "p1", "bm", 50);
    expect(done.turns).toHaveLength(1);
    expect(done.turns[0]!.finished).toBe(true);
    expect(done.turns[0]!.events.map((e) => e.kind)).toEqual(["tool"]);
  }, 10_000);

  it("⑤ 先落库,后广播:观察者**每一次**收到 tool_end,那一行都已经在库里", async () => {
    /**
     * 观察者每次看到 tool_end 时库里已有的工具行数。
     * ⚠️ 记**每一次**而不是「最后一次」:变异若多加一次提前广播,只看最后一次会漏网。
     */
    const observed: number[] = [];
    await turn(
      (emit) => {
        emit(toolStart("t1", "board_list", {}));
        emit(toolEnd("t1", "board_list", { content: [] }));
        emit(toolStart("t2", "board_read", { id: "a1" }));
        emit(toolEnd("t2", "board_read", { content: [] }));
      },
      {
        onEvent: (ev: RuntimeEvent) => {
          if (ev.type === "tool_end") observed.push(toolRows().length);
        },
      },
    );
    expect(observed).toEqual([1, 2]);
  });

  it("⑤ 没有收口行的回合(进程在它结束前退出的形状)读成 finished: false", () => {
    // 直接往库里放一行没有 turn_end 的工具行 —— 与「跑一半进程没了」同形。
    insertTurnEvents(db, [{
      id: "te_half", turnId: "turn_half", projectId: "p1", sessionId: "s1",
      agentId: "bm", workId: null, seq: 1, kind: "tool", tool: "board_list",
      argsSummary: "", resultSummary: "夹具", isError: false, durationMs: 1, createdAt: 5,
    }]);
    const view = agentTurnEvents(db, "p1", "bm", 50);
    expect(view.turns).toHaveLength(1);
    expect(view.turns[0]!.finished).toBe(false);
  });

  it("⑤ seq 回合内连续:工具行 → provider 故障 → 收口行", async () => {
    await turn((emit) => {
      emit(toolStart("t1", "board_list", {}));
      emit(toolEnd("t1", "board_list", { content: [] }));
      emit(messageEnd({ role: "assistant", stopReason: "error", errorMessage: "429 too many requests" }));
    });
    const rows = listTurnEventsByTurn(db, toolRows()[0]!.turnId);
    expect(rows.map((r) => [r.seq, r.kind])).toEqual([
      [1, "tool"], [2, "provider_error"], [3, "turn_end"],
    ]);
  });

  it("⑥ 写入失败过的回合不盖「已结束」的章 —— 缺行的回合配上收口行会被读成全部", async () => {
    // 让工具行的写入失败(其余类别不受影响)。
    db.exec(`
      CREATE TRIGGER reject_tool_rows BEFORE INSERT ON turn_events
      WHEN NEW.kind = 'tool'
      BEGIN SELECT RAISE(ABORT, 'disk says no'); END;
    `);
    await turn((emit) => {
      emit(toolStart("t1", "board_list", {}));
      emit(toolEnd("t1", "board_list", { content: [] }));
      // 有正文 ⇒ 不会另外产生「没有给出下文」的标记行,断言只盯收口行。
      emit(textDelta("做完了。"));
    });
    // 一行都不该留下:工具行没写进去,收口行也不许写。
    expect(listTurnEventsByAgent(db, "p1", "bm")).toEqual([]);
  });

  it("⑥ 负样本:写入都成功的回合照常有收口行(上一条不是因为「永远不写」才绿)", async () => {
    await turn((emit) => {
      emit(toolStart("t1", "board_list", {}));
      emit(toolEnd("t1", "board_list", { content: [] }));
    });
    expect(agentTurnEvents(db, "p1", "bm", 50).turns[0]!.finished).toBe(true);
  });

  it("HTTP 读面原样带出 finished(端点不过滤进行中的回合)", async () => {
    await turn((emit) => {
      emit(toolStart("t1", "board_list", {}));
      emit(toolEnd("t1", "board_list", { content: [] }));
    });
    const deps: HttpDeps = {
      db,
      dataDir: "/tmp/turn-events-test",
      cwd: "/tmp",
      personaName: "三生",
      version: "test",
      modelId: null,
      provider: null,
      hasAnyProvider: false,
      now: () => Date.now(),
      newId: (prefix) => `${prefix}_${Math.random()}`,
      reset: () => ({ cleared: [], totalRows: 0 }),
      harnessDirs: { dataDir: "/tmp/turn-events-test", factoryDir: "/tmp/turn-events-test-factory" },
      settings: {
        read: () => ({}),
        write: async () => ({ ok: true as const, settings: {} }),
        providers: () => [],
      },
    };
    const res = await createPlatformApp(deps).request("/api/projects/p1/agents/bm/turn-events");
    expect(res.status).toBe(200);
    const body = (await res.json()) as AgentTurnEventsResponse;
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0]!.finished).toBe(true);
  });
});
