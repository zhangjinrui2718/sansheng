/**
 * T3 · 用量落库(`runTurn` → `turn_usage`)—— **写入侧的机器形式**
 *
 * ── 这个文件守的是什么 ──────────────────────────────────────────
 *
 * `migrations/018` 守的是**表形状**;`tests/platform/usage-repo.test.ts` 守的是
 * **读**;这里守的是**写**:读点在哪、读的是什么、写了什么、写几行。
 * 这三层各有各的失效方式,而写这一层最难查 —— 它的坏法不是报错,是
 * **账上的数字看起来完全正常**。
 *
 * ── ★ 核心负样本:「事件时刻快照」≠「回合结束后读引用」──────────────
 *
 * 真机探针(T1)的实测:一次 LLM 调用的 `Usage` 是**一个对象**,被
 * `message_start` / N 条 `message_update` / `message_end` / `turn_end` /
 * `agent_end.messages` **共享**,并且在流的过程中被**就地改写**:
 *
 *     message_start      usage 键在,值全零     ← 早读 = 0
 *     message_update ×N  usage 键在,值全零
 *     message_end        ★ 事件时刻即终值
 *     turn_end           ★ 第二次投递(同一个对象)
 *     agent_end.messages ★ 第三次投递(同一个对象)
 *
 * 于是「记住最后一次 partial 的消息引用、回合结束后再读 usage」**看起来能跑通** ——
 * 它读到的是**终值**(因为对象被改写了),和正确实现**值上完全一样**。
 * T1 的探针 v1 就是这么坏掉的:它存 `{path, value}` 时存的是引用,打印时回合早已
 * 结束,于是 `message_start` 那一行显示 `output=61`,看起来「usage 从第一个事件起
 * 就是完整的」。**那是假的。**
 *
 * 所以下面有三条互补的测试:
 *
 *   · **「事件时刻快照 = 0,回合结束后读引用 = 终值」**(`对同一个对象问两次`)
 *     —— 把两者的差别**打出来**;
 *   · **「持引用的实现值与正确实现相同」**(第三形态)
 *     —— 证明**只断言数字的测试抓不到它**;
 *   · **「message_end 之后再改写同一个对象 ⇒ 落库的值不许跟着变」**
 *     —— 这条对「持引用」是**红的**(见测试里的注释:那是合成的最坏情形,
 *        不是观测到的 SDK 行为;钉住它是为了让「今天碰巧正确」变成「机械正确」)。
 *
 * ── 真模型不在这里 ──────────────────────────────────────────────
 *
 * 与 `turn.test.ts` 同一条分工:这里用**脚本化假会话**精确触发每一条分支
 * (包括真模型几乎不可能稳定复现的「同一个 usage 对象被反复改写」),
 * 真 provider 那条路由 `.probe/t3-t4-usage-live.mjs` 与批次报告覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { runTurn, renderTurnReport, type TurnResult } from "../../src/platform/runtime/turn.js";
import { listTurnUsage } from "../../src/platform/storage/repo/usage.js";

let db: Database.Database;

beforeEach(() => {
  db = openPlatformMemoryDb();
  insertAgent(db, { id: "wk", role: "research_worker", specialization: "engineering", displayName: "研究员", createdAt: 1 });
  insertAgent(db, { id: "pm", role: "project_manager", specialization: null, displayName: "项目经理", createdAt: 1 });
  insertProject(db, { id: "p1", name: "项目一", client: "甲", goal: "g", status: "active", createdAt: 1 });
  insertProject(db, { id: "p2", name: "项目二", client: "乙", goal: "g", status: "active", createdAt: 1 });
  addMember(db, "p1", "wk", 1);
  addMember(db, "p2", "wk", 1);
  insertWork(db, {
    id: "w1", projectId: "p1", parentWorkId: null, title: "活", goal: "g",
    status: "in_progress", assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
  });
});
afterEach(() => db.close());

// ── 假会话(与 turn.test.ts 同形,但本文件只需要「按剧本发事件」)────

type Emit = (ev: AgentSessionEvent) => void;

/**
 * 脚本化假会话。
 *
 * `script` 在 `prompt()` 里被调用一次,拿到 `emit` —— **它是同步的**,所以
 * 「在两次 emit 之间改写同一个 usage 对象」可以精确地写出来(这正是本文件
 * 要复现的 SDK 行为)。
 */
function fakeSession(
  script: (emit: Emit) => void,
  opts: { promptRejects?: Error } = {},
): { session: AgentSession; prompts: string[] } {
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  const prompts: string[] = [];
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
      const emit: Emit = (ev) => {
        for (const l of [...listeners]) l(ev);
      };
      script(emit);
      if (opts.promptRejects !== undefined) throw opts.promptRejects;
      emit({ type: "agent_settled" } as unknown as AgentSessionEvent);
    },
    async abort() {},
    dispose() {},
    getActiveToolNames() {
      return [];
    },
  };
  return { session: session as unknown as AgentSession, prompts };
}

// ── 事件构造(只填 runTurn 真正读的字段;其余按 SDK 的形状补齐)──────

/** SDK `Usage` 的形状(含 `cost` —— 证明它**没有**被读进库)。 */
interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** 一次 LLM 调用的「活的」usage 对象(会被就地改写,所以用 let 管理的可变字面量)。 */
function liveUsage(): RawUsage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 把一条调用的 usage「定稿」—— 模拟 SDK 在 message_end 之前把它改成终值。 */
function finish(u: RawUsage, v: { input: number; output: number; cacheRead: number }): void {
  u.input = v.input;
  u.output = v.output;
  u.cacheRead = v.cacheRead;
  u.totalTokens = v.input + v.output + v.cacheRead;
  u.cost = {
    input: v.input * 1e-6, output: v.output * 1e-5,
    cacheRead: v.cacheRead * 1e-7, cacheWrite: 0,
    total: (v.input + v.output + v.cacheRead) * 1e-6,
  };
}

const assistantMessage = (usage: RawUsage, model = "claude-sonnet-4-20250514") => ({
  role: "assistant" as const,
  usage,
  model,
  content: [],
  timestamp: 1,
});

const msgStart = (usage: RawUsage, model?: string): AgentSessionEvent =>
  ({ type: "message_start", message: assistantMessage(usage, model) }) as unknown as AgentSessionEvent;
const msgUpdate = (usage: RawUsage, delta: string, model?: string): AgentSessionEvent =>
  ({
    type: "message_update",
    message: assistantMessage(usage, model),
    // 真事件上 partial 也带同一份 usage(实测);这里一并复现,免得「读点挪到
    // message_update 也拿得到值」这种假象被漏掉。
    assistantMessageEvent: { type: "text_delta", delta, partial: assistantMessage(usage, model) },
  }) as unknown as AgentSessionEvent;
const msgEnd = (usage: RawUsage, model?: string): AgentSessionEvent =>
  ({ type: "message_end", message: assistantMessage(usage, model) }) as unknown as AgentSessionEvent;
/** 第二 / 第三次投递:**同一个对象**。 */
const turnEnd = (usage: RawUsage): AgentSessionEvent =>
  ({ type: "turn_end", turnIndex: 0, message: assistantMessage(usage), toolResults: [], messageEntryId: "e1", toolResultEntryIds: [] }) as unknown as AgentSessionEvent;
const agentEnd = (usage: RawUsage): AgentSessionEvent =>
  ({ type: "agent_end", messages: [assistantMessage(usage)] }) as unknown as AgentSessionEvent;

// ── 读库小工具 ──────────────────────────────────────────────────

function rows(projectId: string | null) {
  return listTurnUsage(db, projectId, { since: 0, until: Number.MAX_SAFE_INTEGER });
}

async function turn(
  script: (emit: Emit) => void,
  over: Partial<Parameters<typeof runTurn>[0]> = {},
  opts: { promptRejects?: Error } = {},
): Promise<TurnResult> {
  const fake = fakeSession(script, opts);
  return runTurn({
    session: fake.session, db, agentId: "wk", projectId: "p1",
    message: "做点事", timeoutMs: 2000,
    newId: (p) => `${p}_fixed`,
    ...over,
  });
}

// ════════════════════════════════════════════════════════════════

describe("T3 正样本 · 真回合落一行,数值与 SDK 报的逐项一致", () => {
  it("★ 单次调用:input/output/cacheRead 三项逐项相等(不是估算)", async () => {
    const result = await turn((emit) => {
      const u = liveUsage();
      emit(msgStart(u));
      emit(msgUpdate(u, "我在"));
      finish(u, { input: 10063, output: 133, cacheRead: 128 });
      emit(msgEnd(u));
      // 同一条消息的第二 / 第三次投递 —— 累加它们会把这份钱收两遍
      emit(turnEnd(u));
      emit(agentEnd(u));
    });

    const all = rows("p1");
    expect(all, "一个回合应当只写**一行**").toHaveLength(1);
    const r = all[0]!;
    expect(r.inputTokens).toBe(10063);
    expect(r.outputTokens).toBe(133);
    expect(r.cacheRead).toBe(128);
    expect(r.agentId).toBe("wk");
    expect(r.projectId).toBe("p1");
    expect(r.model).toBe("claude-sonnet-4-20250514");

    // TurnResult 里的现场与库里那一行**同源**
    expect(result.usage).toBeDefined();
    expect(result.usage!.input).toBe(r.inputTokens);
    expect(result.usage!.output).toBe(r.outputTokens);
    expect(result.usage!.cacheRead).toBe(r.cacheRead);
    expect(result.usage!.calls, "只有 message_end 一条路被算进来").toBe(1);
    expect(result.usage!.rowId).toBe(r.id);
  });

  it("`cost` **不落库、不进报告**(用户已定:只显示 token 数)", async () => {
    const result = await turn((emit) => {
      const u = liveUsage();
      finish(u, { input: 1000, output: 10, cacheRead: 5 });
      emit(msgEnd(u));
    });
    // 表里没有能装金额的列(形状由 018 钉死)—— 这里核对的是**没有别的路漏进去**
    const cols = (db.pragma("table_info(turn_usage)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols.filter((c) => /cost|price|money|usd/i.test(c))).toEqual([]);
    const report = renderTurnReport(result);
    expect(report).toContain("cacheRead 5");
    expect(report.toLowerCase()).not.toContain("cost");
    expect(report).not.toMatch(/[¥$]/);
  });
});

describe("T3 ★ 核心负样本 · 「事件时刻快照」与「回合结束后读引用」", () => {
  it("对同一个 usage 对象问两次:早读 = 0,回合结束后读引用 = 终值", async () => {
    // 两个「观察者」,都写在剧本里 —— 它们模拟的是两种**实现**,不是被测代码。
    //   · `snapshotAtStart`  = 在事件时刻拷值(正确做法的时机,但读点错了)
    //   · `heldRef`          = 持引用,回合结束后再读
    let snapshotAtStart: { input: number; output: number; cacheRead: number } | null = null;
    let heldRef: RawUsage | null = null;

    await turn((emit) => {
      const u = liveUsage();
      emit(msgStart(u));
      snapshotAtStart = { input: u.input, output: u.output, cacheRead: u.cacheRead };
      emit(msgUpdate(u, "想"));
      heldRef = u; // ← 只记引用,不拷值
      finish(u, { input: 10063, output: 133, cacheRead: 128 });
      emit(msgEnd(u));
      emit(turnEnd(u));
      emit(agentEnd(u));
    });

    const row = rows("p1")[0]!;
    const held = heldRef as RawUsage | null;
    expect(held).not.toBeNull();

    // ① 事件时刻的快照(在 message_start 上)= **0**,而库里是终值
    expect(snapshotAtStart).toEqual({ input: 0, output: 0, cacheRead: 0 });
    expect(row.inputTokens).toBe(10063);

    // ② 回合结束后读引用 = **终值** —— 与库里那一行**逐项相同**
    expect(held!.input).toBe(row.inputTokens);
    expect(held!.output).toBe(row.outputTokens);
    expect(held!.cacheRead).toBe(row.cacheRead);

    // ③ 两者**结果不同** —— 这就是「早读」与「持引用读」的差别本身
    expect(snapshotAtStart!.input).not.toBe(held!.input);

    // ④ ★ **第三形态**:一个「持引用」的实现(从 message_start 起持引用、
    //    回合结束后读)会把这份用量算成 10063/133/128 —— 与正确实现**一模一样**。
    //    ⇒ **任何只断言落库数字的测试都抓不到它。**
    const naiveRefImplementation = { input: held!.input, output: held!.output, cacheRead: held!.cacheRead };
    expect(naiveRefImplementation).toEqual({
      input: row.inputTokens, output: row.outputTokens, cacheRead: row.cacheRead,
    });
  });

  it("★ message_end 之后再改写同一个对象 ⇒ 落库的值**不许跟着变**(持引用 = 红)", async () => {
    // ⚠️ 这一条是**合成的最坏情形**,不是观测到的 SDK 行为:实测 `message_end`
    //    就是终值,`turn_end` / `agent_end` 只是同一条消息的再次投递。
    //    钉住它的理由:**今天持引用「碰巧正确」,那正是它危险的地方** ——
    //    下一个把 usage 对象池化 / 复用的实现会**静默**写错账,而所有断言数字的
    //    测试都还是绿的。快照(拷值)让正确性不依赖这个巧合。
    let afterEnd: RawUsage | null = null;
    await turn((emit) => {
      const u = liveUsage();
      emit(msgStart(u));
      finish(u, { input: 10063, output: 133, cacheRead: 128 });
      emit(msgEnd(u)); // ← 正确实现在这一刻拷值
      // 同一个对象又被改写(合成的):持引用者会把它当成这次调用的用量
      finish(u, { input: 999_999, output: 999_999, cacheRead: 999_999 });
      afterEnd = u;
      emit(turnEnd(u)); // 第二 / 第三次投递
      emit(agentEnd(u));
    });

    const row = rows("p1")[0]!;
    expect([row.inputTokens, row.outputTokens, row.cacheRead]).toEqual([10063, 133, 128]);
    // 一个「持 message_end 引用」的实现会读到什么:999999 —— **与库里不同**
    const refHeld = afterEnd as RawUsage | null;
    expect(refHeld!.input).toBe(999_999);
    expect(refHeld!.input).not.toBe(row.inputTokens);
  });

  it("负样本:没有任何 usage 键的 assistant message_end **不记一笔 0**", async () => {
    await turn((emit) => {
      // provider 连 usage 键都没给(与「给了但全零」不同 —— 后者见下一条)
      emit({ type: "message_end", message: { role: "assistant", model: "m" } } as unknown as AgentSessionEvent);
    });
    expect(rows("p1")).toHaveLength(0);
  });

  it("「usage 键在但全零」**记一行 0** 并留一条 WARN 现场(字段名变了要看得出来)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await turn((emit) => {
        const u = liveUsage(); // 全零,一直没被 finish
        emit(msgStart(u));
        emit(msgUpdate(u, "x"));
        emit(msgEnd(u));
      });
      const all = rows("p1");
      expect(all, "provider 没报用量时也留痕(018 的 DEFAULT 0 就是为这个写的)").toHaveLength(1);
      expect([all[0]!.inputTokens, all[0]!.outputTokens, all[0]!.cacheRead]).toEqual([0, 0, 0]);
      const logged = spy.mock.calls.map((c) => String(c.join(" "))).join("\n");
      expect(logged).toContain("全为 0");
      expect(logged, "WARN 里要说清读的是哪几个字段名").toContain("cacheRead");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("T3 多轮工具调用 · 一个回合只写一行,数值是各次之和", () => {
  it("★ 2 次 LLM 调用 ⇒ **仍只有 1 行**,且是两条之和(不是只最后一条)", async () => {
    const result = await turn((emit) => {
      // ── LLM 调用 #1:调了一次工具,input 大、cacheRead 小 ──
      const u1 = liveUsage();
      emit(msgStart(u1));
      finish(u1, { input: 10063, output: 133, cacheRead: 128 });
      emit(msgEnd(u1));
      emit(turnEnd(u1));
      // ── LLM 调用 #2:工具结果回来了,cacheRead 是 input 的 30 倍 ──
      const u2 = liveUsage();
      emit(msgStart(u2));
      finish(u2, { input: 335, output: 40, cacheRead: 10112 });
      emit(msgEnd(u2));
      emit(turnEnd(u2));
      // 同一条消息第三次投递(agent_end 把这一回合的整串 messages 再给一遍)
      emit(agentEnd(u1));
      emit(agentEnd(u2));
    });

    const all = rows("p1");
    expect(all, "两次调用写在**同一行**(表是回合级的)").toHaveLength(1);
    const r = all[0]!;
    expect(r.inputTokens).toBe(10063 + 335);
    expect(r.outputTokens).toBe(133 + 40);
    expect(r.cacheRead).toBe(128 + 10112);
    expect(result.usage!.calls).toBe(2);
    // **不是只最后一条**:最后一条是 335/40/10112
    expect(r.inputTokens).not.toBe(335);
    expect(r.cacheRead).not.toBe(10112);
  });

  it("负样本:把三条投递路全加起来会得到 3 倍 —— 只认 message_end 才对", async () => {
    // 这三条路逐项相等(T1 实测),所以「累加两条」= 重复计数。
    // 这里用**同一份用量被投递三次**来钉住「只算一次」:
    const result = await turn((emit) => {
      const u = liveUsage();
      finish(u, { input: 100, output: 10, cacheRead: 1 });
      emit(msgStart(u)); // message_start 上也是同一个对象(全零时刻已过,这里是终值)
      emit(msgEnd(u)); // ← 唯一算数的
      emit(turnEnd(u));
      emit(agentEnd(u));
    });
    expect(result.usage!.calls).toBe(1);
    expect(rows("p1")[0]!.inputTokens).toBe(100);
  });
});

describe("T3 接待会话 · `project_id = NULL` 那行真的写进去了", () => {
  it("projectId 传 null ⇒ 落一行 `project_id IS NULL`(不丢、不编 id)", async () => {
    const fake = fakeSession((emit) => {
      const u = liveUsage();
      finish(u, { input: 500, output: 20, cacheRead: 0 });
      emit(msgEnd(u));
    });
    const result = await runTurn({
      session: fake.session, db, agentId: "pm", projectId: null,
      message: "你好", timeoutMs: 2000, newId: (p) => `${p}_intake`,
    });

    const all = rows(null);
    expect(all, "接待会话那笔账必须读得到(`IS NULL`)").toHaveLength(1);
    expect(all[0]!.projectId).toBeNull();
    expect(all[0]!.inputTokens).toBe(500);
    expect(result.usage).toBeDefined();

    // **负样本**:它**不在**任何项目下 —— 别把 null 与 p1 混成一回事
    expect(rows("p1")).toHaveLength(0);
    expect(all[0]!.projectId).not.toBe("p1");
  });
});

describe("T3 项目隔离 · 两个项目的账不互相污染", () => {
  it("★ p1 读到的**只有 p1 的行**(负样本:不含 p2 的任何一行)", async () => {
    const write = async (projectId: string, input: number) => {
      const fake = fakeSession((emit) => {
        const u = liveUsage();
        finish(u, { input, output: 1, cacheRead: 0 });
        emit(msgEnd(u));
      });
      await runTurn({
        session: fake.session, db, agentId: "wk", projectId,
        message: "做", timeoutMs: 2000, newId: (p) => `${p}_${projectId}`,
      });
    };
    await write("p1", 111);
    await write("p2", 222);

    const a = rows("p1");
    const b = rows("p2");
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.inputTokens).toBe(111);
    expect(b[0]!.inputTokens).toBe(222);
    // 逐行核对:不含另一个项目的任何一行(不是「总数对得上」就够了)
    expect(a.every((r) => r.projectId === "p1")).toBe(true);
    expect(b.every((r) => r.projectId === "p2")).toBe(true);
    expect(a.map((r) => r.id)).not.toContain(b[0]!.id);
  });
});

describe("T3 会话 / 工作项 / 模型 的落库", () => {
  it("sessionId / workId 传了就落进去;不传是 NULL(不编 id)", async () => {
    const withIds = await turn((emit) => {
      const u = liveUsage();
      finish(u, { input: 1, output: 2, cacheRead: 3 });
      emit(msgEnd(u));
    }, { sessionId: "s_1", workId: "w1", agentId: "wk", newId: () => "tu_a" });
    expect(withIds.usage!.rowId).toBe("tu_a");
    const r = rows("p1")[0]!;
    expect(r.sessionId).toBe("s_1");
    expect(r.workId).toBe("w1");

    db.prepare(`DELETE FROM turn_usage`).run();
    await turn((emit) => {
      const u = liveUsage();
      finish(u, { input: 1, output: 2, cacheRead: 3 });
      emit(msgEnd(u));
    });
    const r2 = rows("p1")[0]!;
    expect(r2.sessionId).toBeNull();
    expect(r2.workId).toBeNull();
  });

  it("一回合内混用了两个模型 ⇒ `model` 写 NULL(一列装不下两个,不假归属)", async () => {
    await turn((emit) => {
      const u1 = liveUsage();
      finish(u1, { input: 10, output: 1, cacheRead: 0 });
      emit(msgEnd(u1, "model-a"));
      const u2 = liveUsage();
      finish(u2, { input: 10, output: 1, cacheRead: 0 });
      emit(msgEnd(u2, "model-b"));
    });
    const r = rows("p1")[0]!;
    expect(r.model).toBeNull();
    expect(r.inputTokens).toBe(20);
  });

  it("`workId` 指向不存在的工作项 ⇒ **响亮失败**,但不毁回合(账记不上要留 ERROR)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await turn((emit) => {
        const u = liveUsage();
        finish(u, { input: 7, output: 1, cacheRead: 0 });
        emit(msgEnd(u));
      }, { workId: "w_不存在" });
      // 外键拒了这次写入 —— 那就**不能说落了**(usage 缺席),回合本身照常返回
      expect(rows("p1")).toHaveLength(0);
      expect(result.usage).toBeUndefined();
      expect(result.settled).toBe(true);
      const logged = spy.mock.calls.map((c) => String(c.join(" "))).join("\n");
      expect(logged).toContain("用量落库失败");
      expect(logged).toContain("7"); // 现场里带着这一次的量
    } finally {
      spy.mockRestore();
    }
  });
});

describe("T3 不写账的两条路", () => {
  it("整个回合没有一次 LLM 输出 ⇒ **一行都不写**(不假装花了 0)", async () => {
    const result = await turn(() => {
      /* 什么都没发生 */
    });
    expect(rows("p1")).toHaveLength(0);
    expect(result.usage).toBeUndefined();
  });

  it("★ `prompt()` 抛错,但**已经买到了** LLM 输出 ⇒ 仍然写一行(finally 的价值)", async () => {
    // 没有这一条的话,「前几次调用成功、后面某次失败」的回合会**静默少账**:
    // 钱花了、账上没有。`finally` 是唯一同时覆盖「正常返回」与「抛错」两条出口
    // 的调度点(而且它仍然只跑一次 —— 单点写入)。
    await expect(
      turn((emit) => {
        const u = liveUsage();
        finish(u, { input: 4096, output: 64, cacheRead: 1024 });
        emit(msgEnd(u));
      }, {}, { promptRejects: new Error("provider 炸了") }),
    ).rejects.toThrow("provider 炸了");

    const all = rows("p1");
    expect(all, "抛错路径上的用量**也必须落库**").toHaveLength(1);
    expect(all[0]!.inputTokens).toBe(4096);
    expect(all[0]!.cacheRead).toBe(1024);
  });
});

describe("T3 推送接缝(onUsageRecorded)", () => {
  it("落库之后回调一次,给的是**已经落库的那一行**", async () => {
    const seen: Array<{ id: string; projectId: string | null; input: number }> = [];
    await turn((emit) => {
      const u = liveUsage();
      finish(u, { input: 42, output: 2, cacheRead: 3 });
      emit(msgEnd(u));
    }, { onUsageRecorded: (row) => seen.push({ id: row.id, projectId: row.projectId, input: row.inputTokens }) });

    expect(seen).toEqual([{ id: "tu_fixed", projectId: "p1", input: 42 }]);
    // 「已经落库」是字面意思:回调跑的时候库里那一行**在**
    expect(rows("p1").map((r) => r.id)).toEqual(["tu_fixed"]);
  });

  it("回调抛错**不影响回合**,也不影响已落的账(但留 ERROR 现场)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await turn((emit) => {
        const u = liveUsage();
        finish(u, { input: 9, output: 1, cacheRead: 0 });
        emit(msgEnd(u));
      }, { onUsageRecorded: () => { throw new Error("推送炸了"); } });
      expect(rows("p1")).toHaveLength(1);
      expect(result.usage!.input).toBe(9);
      const logged = spy.mock.calls.map((c) => String(c.join(" "))).join("\n");
      expect(logged).toContain("onUsageRecorded 抛错");
    } finally {
      spy.mockRestore();
    }
  });

  it("写账失败时**不回调** —— 没落进去就不能说落了", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const seen: string[] = [];
      await turn((emit) => {
        const u = liveUsage();
        finish(u, { input: 1, output: 1, cacheRead: 0 });
        emit(msgEnd(u));
      }, { workId: "w_不存在", onUsageRecorded: (row) => seen.push(row.id) });
      expect(seen).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("T3 幂等策略的机器形式:单点写入 + 不重试", () => {
  it("同一个回合跑两次(runTurn 被调两次)= **两行**,而不是一行(重跑 = 又花了钱)", async () => {
    const script = (emit: Emit) => {
      const u = liveUsage();
      finish(u, { input: 100, output: 10, cacheRead: 0 });
      emit(msgEnd(u));
    };
    await turn(script, { newId: (p) => `${p}_1` });
    await turn(script, { newId: (p) => `${p}_2` });
    // 表里**没有**识别「同一个回合」的天然键(018 已定),所以幂等靠「写一次、
    // 不重试」;调用方重跑一个回合就是新的一回合 —— 那确实是新花掉的钱。
    expect(rows("p1").map((r) => r.id).sort()).toEqual(["tu_1", "tu_2"]);
  });

  it("一次 runTurn 只写一次(即便事件流里有多条 assistant message_end)", async () => {
    await turn((emit) => {
      for (const v of [
        { input: 1, output: 1, cacheRead: 0 },
        { input: 2, output: 2, cacheRead: 0 },
        { input: 4, output: 4, cacheRead: 0 },
      ]) {
        const u = liveUsage();
        finish(u, v);
        emit(msgEnd(u));
      }
    });
    const all = rows("p1");
    expect(all).toHaveLength(1);
    expect(all[0]!.inputTokens).toBe(7);
  });
});
