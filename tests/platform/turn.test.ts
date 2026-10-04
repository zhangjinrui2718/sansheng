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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  /** 每次 `abort()` 的调用 —— 序号即「第几次」,序内位置见 `calls` */
  aborts: number;
  /** 调用顺序日志(`prompt:start` / `prompt:end` / `abort`)—— 用来钉住「登记在 await 之前」 */
  calls: string[];
  disposed: boolean;
}

/**
 * 造一个假会话。`script` 在每次 prompt 时被调用,用来发事件。
 * 返回 `null` 表示「永不 settle」(用来测超时)。
 */
function fakeSession(
  script: (emit: (ev: AgentSessionEvent) => void, promptText: string) => void | "never",
  opts: {
    throwOnSubscribeFn?: boolean;
    /** `prompt()` 会一直挂着,直到 `abort()` 被调到(死接线在这条剧本下永不结束) */
    holdPromptUntilAbort?: boolean;
    /** `prompt()` 永远不返回,`abort()` 也放不掉它(测「宽限到点就不再等」) */
    holdPromptForever?: boolean;
    /** 被 abort 放掉之后 `prompt()` 抛错(测「打断时抛错不是回合故障」) */
    throwAfterAbort?: boolean;
    /** `abort()` 自己抛错(测「abort 失败不静默」) */
    abortThrows?: boolean;
  } = {},
): FakeSession {
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  const prompts: string[] = [];
  const calls: string[] = [];
  const state = { disposed: false, aborts: 0 };
  let release: (() => void) | null = null;

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
      calls.push("prompt:start");
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
      if (opts.holdPromptForever === true) {
        await new Promise<void>(() => {});
      } else if (opts.holdPromptUntilAbort === true) {
        await new Promise<void>((res) => { release = res; });
      }
      calls.push("prompt:end");
      if (opts.throwAfterAbort === true && state.aborts > 0) {
        throw new Error("aborted by platform");
      }
    },
    async abort() {
      state.aborts += 1;
      calls.push("abort");
      release?.();
      if (opts.abortThrows === true) throw new Error("abort 炸了");
    },
    dispose() {
      state.disposed = true;
    },
    getActiveToolNames() {
      return [];
    },
  };

  return {
    session: session as unknown as AgentSession,
    prompts,
    calls,
    get aborts() { return state.aborts; },
    get disposed() { return state.disposed; },
  } as FakeSession;
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

  it("没有待办 → 不注入待办段,任务原话在末尾", async () => {
    // 用 worker 而不是 fixture 默认的 pm:p1 里一个工作项都没有,而「项目还没拆解」
    // 现在**是**项目经理的一条待办(见 pendingWork.ts 的 needsDecomposition)。
    // 这条测试要验的是「一条待办都没有时不注入」,所以挑一个手上真的空的角色。
    const { result, fake } = await turn((emit) => emit(textDelta("好")), { agentId: "wk" });
    expect(result.pending.injected).toBe(false);
    // 项目上下文(A)现在**每回合都注入** —— 它不属于「待办」,所以这里断言的是
    // 「没有待办段」而不是「整条消息只有原话」(见 runtime/projectContext.ts)。
    expect(fake.prompts[0]).not.toContain("## 当前待办");
    expect(fake.prompts[0]?.endsWith("做点事")).toBe(true);
  });

  it("injectPending:false 时即便有待办也不注入", async () => {
    insertAsk(db, {
      id: "a1", projectId: "p1", fromAgentId: "wk", toAgentId: "pm",
      question: "q", hypothesis: "h", createdAt: 1,
    });
    const { result, fake } = await turn((emit) => emit(textDelta("好")), { injectPending: false });
    expect(result.pending.injected).toBe(false);
    expect(fake.prompts[0]).not.toContain("## 当前待办");
    expect(fake.prompts[0]?.endsWith("做点事")).toBe(true);
  });

  it("项目会话里**每回合都注入项目上下文** —— 它必须知道自己在哪个项目", async () => {
    const { result, fake } = await turn((emit) => emit(textDelta("好")));
    expect(result.projectContext?.injected).toBe(true);
    expect(result.projectContext?.summary).toContain("p1");
    expect(fake.prompts[0]).toContain("## 你所在的项目");
    expect(fake.prompts[0]).toContain("测试");
    expect(fake.prompts[0]).toContain("项目经理");
    expect(fake.prompts[0]).toContain("`pm`");
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

// ── 墙钟上界:超时必须**真的打断**回合 ────────────────────────────
//
// 缺陷现场(真机):一个 worker 回合跑了 **16 分钟**还没完,watcher 15 分钟窗口
// 里它一直在 `bash` curl 阿里云文档。`timeoutMs` 完全没拦住它 —— 那个定时器
// 只置 `settled`,而 `settled` 只在 `await session.prompt()` resolve 之后被读到,
// `prompt()` 自己不会被打断。后果不只是花钱:排空器下它一直占着该项目的 busy 闩。
//
// 这一组测试钉住三件事:**abort 真的被调到** / **登记在第一次 await 之前** /
// **现场带得回来**。全部用假会话 + 短上界(百毫秒级)驱动,不真等 10 分钟。

describe("runTurn · 墙钟上界真的打断回合", () => {
  it("到点调用 session.abort() —— 不是继续等一个不会收敛的 prompt()", async () => {
    const { result, fake } = await turn(() => "never", {
      timeoutMs: 10_000, wallClockTimeoutMs: 120,
    });
    expect(fake.aborts, "abort() 必须真的被调到").toBe(1);
    expect(result.timedOut).toBe(true);
    expect(result.timeout?.abortRequested).toBe(true);
    expect(result.timeout?.limitMs).toBe(120);
  });

  it("**登记在第一次 await 之前** —— prompt 还挂着时 abort 已经到了(死接线的反面)", async () => {
    // 批次 19 的教训:登记放在 `await runTurn(...)` 之后等于永远登记不上。
    // 这条剧本里 `prompt()` 一直挂着,只有 abort 能放它走 —— 如果定时器是在
    // prompt 之后才登记的,这个回合**永远不会结束**(而死接线看起来一切正常)。
    const fake = fakeSession(() => "never", { holdPromptUntilAbort: true });
    const result = await runTurn({
      session: fake.session, db, agentId: "pm", projectId: "p1",
      message: "做点事", timeoutMs: 10_000, wallClockTimeoutMs: 100,
    });
    expect(fake.aborts).toBe(1);
    expect(fake.calls, "abort 必须发生在 prompt 返回之前").toEqual([
      "prompt:start", "abort", "prompt:end",
    ]);
    expect(result.timeout?.promptReturned, "abort 之后 prompt 收尾了").toBe(true);
  });

  it("打断瞬间**正在跑的工具**进现场(7-N:只写「超时了」等于没有现场)", async () => {
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "bash", { command: "curl https://help.aliyun.com/..." }));
      return "never";
    }, { timeoutMs: 10_000, wallClockTimeoutMs: 120 });

    expect(result.timeout?.interruptedTool?.name).toBe("bash");
    expect(result.timeout?.interruptedTool?.argsSummary).toContain("curl https://help.aliyun.com");
    expect(result.timeout?.completedToolCalls, "它还没结束,不算已完成").toBe(0);
  });

  it("打断前已经收到的正文与已完成的工具照样带回(现场不丢)", async () => {
    const { result } = await turn((emit) => {
      emit(textDelta("说了一半"));
      emit(toolStart("c1", "board_write", { kind: "note" }));
      emit(toolEnd("c1", "board_write", { details: { ok: true } }));
      emit(toolStart("c2", "bash", { command: "curl 文档" }));
      return "never";
    }, { timeoutMs: 10_000, wallClockTimeoutMs: 120 });

    expect(result.text).toBe("说了一半");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.timeout?.completedToolCalls).toBe(1);
    expect(result.timeout?.interruptedTool?.name).toBe("bash");
    expect(result.timeout?.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it("abort 之后 prompt 仍不返回 —— 宽限到点就不再等它(排空器不被一个回合钉住)", async () => {
    const fake = fakeSession(() => "never", { holdPromptForever: true });
    const t0 = Date.now();
    const result = await runTurn({
      session: fake.session, db, agentId: "pm", projectId: "p1",
      message: "做点事", timeoutMs: 10_000, wallClockTimeoutMs: 80, abortGraceMs: 60,
    });
    const took = Date.now() - t0;

    expect(fake.aborts).toBe(1);
    expect(result.timeout?.promptReturned, "如实报「abort 之后没收敛」").toBe(false);
    expect(took, "宽限到点必须返回,不许无限等").toBeLessThan(2000);
  });

  it("打断让 prompt() 抛错**不是回合故障** —— 不抛给调用方,但错误进现场", async () => {
    const fake = fakeSession(() => "never", {
      holdPromptUntilAbort: true, throwAfterAbort: true,
    });
    const result = await runTurn({
      session: fake.session, db, agentId: "pm", projectId: "p1",
      message: "做点事", timeoutMs: 10_000, wallClockTimeoutMs: 80,
    });
    expect(result.timedOut).toBe(true);
    expect(result.timeout?.promptReturned).toBe(true);
    expect(result.timeout?.promptError).toContain("aborted by platform");
  });

  it("报告里带得出墙钟现场(上界 / abort / 打断瞬间在跑什么)", async () => {
    const { result } = await turn((emit) => {
      emit(toolStart("c1", "bash", { command: "curl 文档" }));
      return "never";
    }, { timeoutMs: 10_000, wallClockTimeoutMs: 120 });
    const rep = renderTurnReport(result);
    expect(rep).toContain("墙钟上界");
    expect(rep).toContain("session.abort()");
    expect(rep).toContain("打断瞬间在跑:bash");
    expect(rep).toContain("curl 文档");
  });

  it("超时**不静默**:WARN 级日志带上界、耗时与打断瞬间在跑什么", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    });
    try {
      await turn((emit) => {
        emit(toolStart("c1", "bash", { command: "curl 文档" }));
        return "never";
      }, { timeoutMs: 10_000, wallClockTimeoutMs: 100 });
    } finally {
      spy.mockRestore();
    }
    const warn = lines.find((l) => l.includes("墙钟上界"));
    expect(warn, "必须有一条超时日志(不许静默)").toBeDefined();
    expect(warn).toContain("warn");
    expect(warn).toContain("bash");
    expect(warn).toContain("curl 文档");
  });

  it("abort() 自己失败也留现场(不静默)—— 错误进现场,回合照常收尾", async () => {
    const fake = fakeSession(() => "never", {
      holdPromptUntilAbort: true, abortThrows: true,
    });
    const result = await runTurn({
      session: fake.session, db, agentId: "pm", projectId: "p1",
      message: "做点事", timeoutMs: 10_000, wallClockTimeoutMs: 80,
    });
    expect(fake.aborts).toBe(1);
    expect(result.timeout?.abortError, "abort 的失败必须能看见").toContain("abort 炸了");
  });
});

// ── 两个上界是两件事:旧语义不许被改坏 ───────────────────────────
//
// `timeoutMs` 护的是「`prompt()` resolve 之后等 agent_settled 那段收尾等待」,
// 它**不打断**任何东西;`wallClockTimeoutMs` 才是回合时长上界。
// 这两条测试钉住「新上界没有把旧语义顶掉」。

describe("runTurn · timeoutMs 的旧语义(收尾等待)没有被改坏", () => {
  it("prompt 正常返回但永不 settle → 旧定时器收尾,**不 abort**、也没有墙钟现场", async () => {
    const { result, fake } = await turn(() => "never", {
      timeoutMs: 120, wallClockTimeoutMs: 10_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.settled).toBe(false);
    expect(fake.aborts, "收尾等待超时不该打断会话").toBe(0);
    expect(result.timeout, "没有墙钟现场 = 不是墙钟打断的").toBeUndefined();
  });

  it("非正数的墙钟上界不生效,退回默认(坏值取默认,而不是「0 = 不设上界」)", async () => {
    const { result, fake } = await turn((emit) => emit(textDelta("正常")), {
      wallClockTimeoutMs: 0,
    });
    expect(result.text).toBe("正常");
    expect(result.timedOut).toBe(false);
    expect(result.timeout).toBeUndefined();
    expect(fake.aborts).toBe(0);
  });

  it("普通失败照旧抛给调用方(新上界不许把真错误吞掉)", async () => {
    const fake = fakeSession(() => {
      throw new Error("provider 炸了");
    });
    await expect(
      runTurn({
        session: fake.session, db, agentId: "pm", projectId: "p1",
        message: "做点事", timeoutMs: 10_000, wallClockTimeoutMs: 10_000,
      }),
    ).rejects.toThrow("provider 炸了");
  });
});
