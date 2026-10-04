/**
 * 一个回合 · 测试
 *
 * ── 假会话是刻意的 ──────────────────────────────────────────────
 *
 * `runTurn` 的职责是**编排**(订阅事件、分发增量、收集现场、注入待办、处理超时),
 * 不是「跟模型说话」。所以测试用一个脚本化的假会话:它按剧本发事件,于是每一条
 * 分支都能被精确触发 —— 包括真模型几乎不可能稳定复现的那几条(超时、事件里
 * details 判失败、thinking 与 text 交错)。
 *
 * 真模型那条路由 `tests/platform/session.test.ts` 的契约测试与
 * `sansheng platform smoke` 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertAsk } from "../../src/platform/storage/repo/asks.js";
import {
  runTurn, composeTurnMessage, renderTurnReport, type TurnResult,
} from "../../src/platform/runtime/turn.js";

let db: Database.Database;

beforeEach(() => {
  db = openPlatformMemoryDb();
  insertAgent(db, { id: "pm", role: "project_manager", specialization: null, displayName: "项目经理", createdAt: 1 });
  insertAgent(db, { id: "wk", role: "worker", specialization: "engineering", displayName: "工程师", createdAt: 1 });
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: 1 });
  addMember(db, "p1", "pm", 1);
  addMember(db, "p1", "wk", 1);
});
afterEach(() => db.close());

// ── 脚本化假会话 ────────────────────────────────────────────────

interface FakeSession {
  session: AgentSession;
  /** 每次 prompt 收到的文本 */
  prompts: string[];
  disposed: boolean;
}

/**
 * 造一个假会话。`script` 在每次 prompt 时被调用,用来发事件。
 * 返回 `null` 表示「永不 settle」(用来测超时)。
 */
function fakeSession(
  script: (emit: (ev: AgentSessionEvent) => void, promptText: string) => void | "never",
  opts: { throwOnSubscribeFn?: boolean } = {},
): FakeSession {
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  const prompts: string[] = [];
  const state = { disposed: false };

  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(text: string) {
      prompts.push(text);
      const emit = (ev: AgentSessionEvent) => {
        for (const l of [...listeners]) l(ev);
      };
      if (opts.throwOnSubscribeFn === true) {
        // 观察者抛错不该毁掉回合 —— 由 onEvent 那条测试触发
      }
      const r = script(emit, text);
      if (r !== "never") {
        emit({ type: "agent_settled" });
      }
    },
    dispose() {
      state.disposed = true;
    },
    getActiveToolNames() {
      return [];
    },
  };

  return { session: session as unknown as AgentSession, prompts, get disposed() { return state.disposed; } } as FakeSession;
}

// 事件构造小工具(只填 runTurn 真正读的字段)
const textDelta = (delta: string) =>
  ({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta } }) as unknown as AgentSessionEvent;
const thinkDelta = (delta: string) =>
  ({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta } }) as unknown as AgentSessionEvent;
const toolStart = (id: string, name: string, args: unknown) =>
  ({ type: "tool_execution_start", toolCallId: id, toolName: name, args }) as unknown as AgentSessionEvent;
const toolEnd = (id: string, name: string, result: unknown, extras: { isError?: boolean } = {}) =>
  ({
    type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: extras.isError ?? false,
  }) as unknown as AgentSessionEvent;

async function turn(
  script: Parameters<typeof fakeSession>[0],
  over: Partial<Parameters<typeof runTurn>[0]> = {},
): Promise<{ result: TurnResult; fake: FakeSession }> {
  const fake = fakeSession(script);
  const result = await runTurn({
    session: fake.session, db, agentId: "pm", projectId: "p1",
    message: "做点事", timeoutMs: 2000,
    ...over,
  });
  return { result, fake };
}

// ── composeTurnMessage ──────────────────────────────────────────

describe("composeTurnMessage · 待办与任务的层次", () => {
  it("没有待办时原样返回", () => {
    expect(composeTurnMessage("", "做点事")).toBe("做点事");
    expect(composeTurnMessage("   \n ", "做点事")).toBe("做点事");
  });

  it("有待办时拼在前面,并用分隔线标出任务起点", () => {
    const m = composeTurnMessage("## 当前待办\n- 有人问你", "做点事");
    expect(m.indexOf("有人问你")).toBeLessThan(m.indexOf("做点事"));
    expect(m).toContain("---");
    // 模型必须能分清「系统替我列的」与「我该干的」
    expect(m).toContain("# 本次要做的事");
  });
});

// ── 文本与推理分流(7-I)──────────────────────────────────────────

describe("runTurn · 文本与推理**永不混流**(7-I)", () => {
  it("text_delta 进正文,thinking_delta 进 thinking", async () => {
    const { result } = await turn((emit) => {
      emit(thinkDelta("我在想"));
      emit(textDelta("答案是"));
      emit(thinkDelta("再想想"));
      emit(textDelta("42"));
    });
    expect(result.text).toBe("答案是42");
    expect(result.thinking).toBe("我在想再想想");
  });

  it("只有推理没有正文时 text 为空 —— 不会被当成回复展示", async () => {
    // 7-I 的现场:判据写成了不存在的 "thinking",所有 thinking 增量掉进
    // textDeltas → 落进 content → 当成正式回复展示给用户
    const { result } = await turn((emit) => {
      emit(thinkDelta("这是纯内部推理,不该给用户看"));
    });
    expect(result.text).toBe("");
    expect(result.thinking).toContain("纯内部推理");
  });

  it("报告里如实说明推理未混入正文", () => {
    const r: TurnResult = {
      text: "答", thinking: "想", toolCalls: [], openedProjectIds: [],
      pending: { injected: false, summary: "" }, settled: true, timedOut: false,
    };
    expect(renderTurnReport(r)).toContain("内部推理");
    expect(renderTurnReport(r)).toContain("未混入正文");
  });
});

// ── 现场(7-N)──────────────────────────────────────────────────

describe("runTurn · 工具调用现场", () => {
  it("收集名字、参数摘要、耗时与结果", async () => {
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "board_write", { kind: "note", title: "标题" }));
      emit(toolEnd("c1", "board_write", { content: [{ type: "text", text: "已写工件 art_1" }] }));
    });
    expect(result.toolCalls).toHaveLength(1);
    const t = result.toolCalls[0]!;
    expect(t.name).toBe("board_write");
    expect(t.argsSummary).toContain("kind=note");
    expect(t.argsSummary).toContain("title=标题");
    expect(t.resultSummary).toContain("已写工件 art_1");
    expect(t.isError).toBe(false);
  });

  it("**失败判定优先读 details.ok**,因为 isError 在文本失败时恒为 false", async () => {
    // 这正是首跑真机抓到的:board_write 撞外键失败,日志却标成了 ✓
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "board_write", {}));
      emit(toolEnd("c1", "board_write", {
        content: [{ type: "text", text: "[工具失败:internal] FOREIGN KEY constraint failed" }],
        details: { ok: false, code: "internal" },
      }, { isError: false }));
    });
    expect(result.toolCalls[0]!.isError, "details.ok=false 必须判为失败").toBe(true);
  });

  it("details 缺席时退化为读文本前缀", async () => {
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "x", {}));
      emit(toolEnd("c1", "x", { content: [{ type: "text", text: "[工具失败:denied] 上界不含" }] }));
    });
    expect(result.toolCalls[0]!.isError).toBe(true);
  });

  it("events 里的 isError:true 也算失败(execute 抛异常那条路)", async () => {
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "x", {}));
      emit(toolEnd("c1", "x", "炸了", { isError: true }));
    });
    expect(result.toolCalls[0]!.isError).toBe(true);
  });

  it("报告把失败标成 ✖ 并带参数 —— 见不到现场等于没有现场", () => {
    const r: TurnResult = {
      text: "", thinking: "",
      toolCalls: [{
        name: "board_write", argsSummary: "kind=note", isError: true,
        resultSummary: "[工具失败:internal] 外键", durationMs: 3,
      }],
      openedProjectIds: [],
      pending: { injected: false, summary: "" }, settled: true, timedOut: false,
    };
    const rep = renderTurnReport(r);
    expect(rep).toContain("✖ board_write");
    expect(rep).toContain("kind=note");
    expect(rep).toContain("外键");
  });
});

// ── 待办注入 ────────────────────────────────────────────────────

describe("runTurn · 待办注入", () => {
  it("有待办等它 → 拼进消息,并如实报 injected", async () => {
    insertAsk(db, {
      id: "a1", projectId: "p1", fromAgentId: "wk", toAgentId: "pm",
      question: "要不要改?", hypothesis: "我倾向改", createdAt: 1,
    });
    const { result, fake } = await turn((emit) => emit(textDelta("好")));
    expect(result.pending.injected).toBe(true);
    expect(result.pending.summary).toContain("1 条等你答");
    // 模型收到的那份文本里真有待办
    expect(fake.prompts[0]).toContain("等你的提问");
    expect(fake.prompts[0]).toContain("我倾向改");
    expect(fake.prompts[0]).toContain("做点事");
  });

  it("没有待办 → 不注入,消息就是原话", async () => {
    const { result, fake } = await turn((emit) => emit(textDelta("好")));
    expect(result.pending.injected).toBe(false);
    expect(fake.prompts[0]).toBe("做点事");
  });

  it("injectPending:false 时即便有待办也不注入", async () => {
    insertAsk(db, {
      id: "a1", projectId: "p1", fromAgentId: "wk", toAgentId: "pm",
      question: "q", hypothesis: "h", createdAt: 1,
    });
    const { result, fake } = await turn((emit) => emit(textDelta("好")), { injectPending: false });
    expect(result.pending.injected).toBe(false);
    expect(fake.prompts[0]).toBe("做点事");
  });
});

// ── 超时与生命周期 ──────────────────────────────────────────────

describe("runTurn · 超时与会话生命周期", () => {
  it("永不 settle → 超时收尾,timedOut=true,settled=false", async () => {
    const { result } = await turn(() => "never", { timeoutMs: 120 });
    expect(result.timedOut).toBe(true);
    expect(result.settled).toBe(false);
  });

  it("超时也带回**已经收到的**内容与工具调用(现场不丢)", async () => {
    const { result } = await turn((emit) => {
      emit(textDelta("说了一半"));
      emit(toolStart("c1", "board_write", { kind: "note" }));
      emit(toolEnd("c1", "board_write", { details: { ok: true } }));
      return "never";
    }, { timeoutMs: 120 });
    expect(result.timedOut).toBe(true);
    expect(result.text).toBe("说了一半");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("**不 dispose 会话** —— 一个回合只是会话的一次交互", async () => {
    const { fake } = await turn((emit) => emit(textDelta("x")));
    expect(fake.disposed).toBe(false);
  });

  it("回合结束后退订,不会重复计数", async () => {
    const fake = fakeSession((emit) => emit(textDelta("x")));
    await runTurn({ session: fake.session, db, agentId: "pm", projectId: "p1", message: "m", timeoutMs: 2000 });
    // 再跑一次:上一回合的订阅若没退,这次的事件会被记两遍
    const second = await runTurn({ session: fake.session, db, agentId: "pm", projectId: "p1", message: "m", timeoutMs: 2000 });
    expect(second.text).toBe("x");
  });

  it("onEvent 抛错不影响回合", async () => {
    // 观察者是外部代码(调试钩子/日志),它出错不该毁掉这一回合
    const { result } = await turn((emit) => {
      emit(textDelta("照常"));
      emit(toolStart("c1", "x", {}));
      emit(toolEnd("c1", "x", {}));
    }, {
      onEvent: () => {
        throw new Error("观察者炸了");
      },
    });
    expect(result.text).toBe("照常");
    expect(result.toolCalls, "后续事件仍要被处理").toHaveLength(1);
  });
});

// ── 立项的现场(openedProjectIds)─────────────────────────────────
//
// 宿主靠它做「接待会话 → 新项目」的切换:`project_open` 成功之后要把接待会话的
// 消息迁进新项目、让前端切过去、并丢掉那条接待会话。**读的是结构化 details,
// 不是解析给模型的文本** —— 文案改一个字就会让文本解析静默失效。

describe("runTurn · 立项现场(openedProjectIds)", () => {
  it("从 details.data.projectId 收集,按调用顺序", async () => {
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "project_open", { name: "甲" }));
      emit(toolEnd("c1", "project_open", {
        content: [{ type: "text", text: "已立项 pj_a「甲」" }],
        details: { ok: true, data: { projectId: "pj_a" } },
      }));
      emit(toolStart("c2", "project_open", { name: "乙" }));
      emit(toolEnd("c2", "project_open", {
        content: [{ type: "text", text: "已立项 pj_b「乙」" }],
        details: { ok: true, data: { projectId: "pj_b" } },
      }));
    });
    expect(result.openedProjectIds).toEqual(["pj_a", "pj_b"]);
  });

  it("失败的结果没有 data → 不进 openedProjectIds(不许把失败当成立项)", async () => {
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "project_open", {}));
      emit(toolEnd("c1", "project_open", {
        content: [{ type: "text", text: "[工具失败:invalid_args] 缺少必填参数 goal" }],
        details: { ok: false, code: "invalid_args" },
      }));
    });
    expect(result.openedProjectIds).toEqual([]);
    expect(result.toolCalls[0]!.isError).toBe(true);
  });

  it("**只认 project_open** —— 别的工具带 projectId 不算立项", async () => {
    // `ToolResult.data` 是通用逃逸口,别的工具完全可能带一个 projectId
    // (「我刚读的是哪个项目」)。放进 openedProjectIds 会让宿主**误迁移接待会话**,
    // 所以这里把工具名过滤钉住。
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "board_write", {}));
      emit(toolEnd("c1", "board_write", {
        content: [{ type: "text", text: "ok" }],
        details: { ok: true, data: { projectId: "pj_x" } },
      }));
    });
    expect(result.openedProjectIds).toEqual([]);
  });

  it("details 形状不认识时不抛,也不误判", async () => {
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "project_open", {}));
      emit(toolEnd("c1", "project_open", { details: { ok: true, data: "不是对象" } }));
      emit(toolStart("c2", "project_open", {}));
      emit(toolEnd("c2", "project_open", { details: { ok: true, data: { projectId: 42 } } }));
      emit(toolStart("c3", "project_open", {}));
      emit(toolEnd("c3", "project_open", "纯文本结果"));
    });
    expect(result.openedProjectIds).toEqual([]);
  });

  it("报告里如实写出本回合立了哪些项目", () => {
    const r: TurnResult = {
      text: "", thinking: "", toolCalls: [], openedProjectIds: ["pj_a"],
      pending: { injected: false, summary: "" }, settled: true, timedOut: false,
    };
    expect(renderTurnReport(r)).toContain("本回合立项: pj_a");
  });
});

// ── 接待会话的待办注入 ───────────────────────────────────────────

describe("runTurn · 接待会话(projectId null)", () => {
  it("不注入待办,并如实说明为什么(而不是拼一个空壳)", async () => {
    const { result } = await turn(() => {}, { projectId: null, agentId: "pm" });
    expect(result.pending.injected).toBe(false);
    expect(result.pending.summary).toContain("接待会话");
  });

  it("接待会话里也能跑完一个回合(不需要项目存在)", async () => {
    const { result } = await turn((emit) => {
      emit(textDelta("你想做什么?"));
    }, { projectId: null, agentId: "pm" });
    expect(result.text).toBe("你想做什么?");
    expect(result.settled).toBe(true);
  });
});
