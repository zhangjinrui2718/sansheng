/**
 * bug② · **跨项目 flush 串扰**(A2 实测报的)
 *
 * ── 现场 ────────────────────────────────────────────────────────
 *
 * `appSocket.ts` 把一个 WS 连接上的**全部**事件无条件灌进 store:
 *
 *     sock.on((e) => useChatStore.getState().applyEvent(e))
 *
 * 而 `hub.broadcast()`(`transport/hub.ts:170`)是**向所有连接扇出、不按项目过滤**。
 * 于是「用户坐在项目 A 看它流」与「排空器在项目 B 跑 pm/qa」共用同一条事件流:
 *
 *     A message_start(a1) → A delta(a1,"前半")
 *     B message_start(b1) → B delta(b1,"B 的产出")
 *     B agent_end        ← **修前:把 A 的轮一起 flush 出表,并清空 inFlight**
 *     A delta(a1,"后半") ← **修前:表里没有 a1 ⇒ 整段丢字(A 被截断)**
 *     A agent_end
 *
 * 丢字发生在**数据层**(`delta` 按 `messageId` 认领,找不到就丢 —— 那是
 * §2.10.3「不猜角色」的同一条纪律),**不是渲染层能救的**:渲染层再聪明也看不到
 * 一个从没进过 `inFlight` 的 delta。
 *
 * ⚠️ **严重度**:修前**同样会截断** —— 单槽时代 `delta` 的守卫是
 * `const cur = get().currentTurn; if (!cur) return;`(`git show b5dac9b^:
 * web/src/stores/chat.ts` 第 363-364 行),B 的 `agent_end` 把 `currentTurn`
 * 置 null 之后,A 的迟到 delta 一样被丢。**所以这不是 A2 引入的**;A2 改变的是
 * 「一次 `agent_end` 能 flush 几轮」—— 那个 N 现在**可以跨项目**。
 *
 * ── 修法 ────────────────────────────────────────────────────────
 *
 * 轮本身就记着自己属于哪个上下文(`Turn.projectId`,与 `message_start` /
 * `tool_start` 信封上的 `projectId` 同义;`null` = 接待会话),`agent_end`
 * **只 flush 自己那个 `projectId` 的轮**。判据是**恒等比较**而不是
 * 「有没有 projectId」—— 接待会话(null)是一个真上下文,不是「通配」。
 *
 * ── 探针的正负样本(三类静默失败纪律)─────────────────────────────
 *
 * 每个诊断都要拿已知答案的样本自检,所以本文件既有**必须命中**的样本,也有
 * **必须不命中**的:
 *   - 负样本:`agent_end` 对自己项目的轮**必须照样 flush**(修复不许把
 *     `agent_end` 变成空操作)、`null`(接待)与项目之间不许互相清、
 *     `tool_start` 建出来的轮也必须带上下文(第二个建轮点最容易漏)。
 *   - 正样本:交错的 B `agent_end` **不许碰** A 的轮。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { inFlightTurns, useChatStore } from "../../web/src/stores/chat.js";

/** 两块地:PA = 用户正坐着的项目,PB = 排空器在后台跑的项目。 */
const PA = "p-alpha";
const PB = "p-beta";
const BM = "ag_bm";
const PM = "ag_pm";

beforeEach(() => {
  useChatStore.setState({
    projectId: PA,
    intakeActive: false,
    turns: [],
    inFlight: {},
    inFlightOrder: [],
    currentTurn: null,
    lastUserEchoId: null,
    currentUsage: { input: 0, output: 0 },
    status: "idle",
  });
});

const textsOf = (id: string): string[] =>
  (useChatStore.getState().turns.find((t) => t.id === id)?.blocks ?? [])
    .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
    .map((b) => b.text);

describe("bug② · 交错的两个项目:同一条 WS 上的 agent_end 不许跨项目 flush", () => {
  it("**正样本**:B 的 agent_end 清不动 A 正在流的轮,A 的迟到 delta 不丢字", () => {
    const s = () => useChatStore.getState();

    // ── A:用户正坐着的项目,一轮正在流 ──
    s().applyEvent({ type: "message_start", projectId: PA, messageId: "a1", role: "assistant", agentId: BM });
    s().applyEvent({ type: "delta", projectId: PA, messageId: "a1", text: "前半" });

    // ── B:排空器在后台跑出来的一个回合 ──
    s().applyEvent({ type: "message_start", projectId: PB, messageId: "b1", role: "assistant", agentId: PM });
    s().applyEvent({ type: "delta", projectId: PB, messageId: "b1", text: "B 的产出" });
    s().applyEvent({ type: "agent_end", projectId: PB, ts: 1 });

    // ① A 的轮**还在表里**(修复前:被 B 的 agent_end 一起 flush 掉 ⇒ undefined)
    expect(s().inFlight["a1"]).toBeDefined();
    // ② B 自己那一轮照常收口(修复不许把 agent_end 变成空操作)
    expect(s().inFlight["b1"]).toBeUndefined();
    expect(s().turns.map((t) => t.id)).toContain("b1");

    // ③ A 的迟到 delta 仍进它自己那一轮(修复前:表里没有 a1 ⇒ 整段丢字)
    s().applyEvent({ type: "delta", projectId: PA, messageId: "a1", text: "后半" });
    s().applyEvent({ type: "agent_end", projectId: PA, ts: 2 });

    // 修复前这里只有 ["前半"] —— 「后半」从没进过任何一轮(数据层截断)
    expect(textsOf("a1")).toEqual(["前半后半"]);
  });

  it("**正样本**:B 的 agent_end 不许把「A 还在推演」的状态改成 idle(那会让发送键提前解锁)", () => {
    const s = () => useChatStore.getState();
    s().applyEvent({ type: "message_start", projectId: PA, messageId: "a1", role: "assistant", agentId: BM });
    expect(s().status).toBe("streaming");

    s().applyEvent({ type: "message_start", projectId: PB, messageId: "b1", role: "assistant", agentId: PM });
    s().applyEvent({ type: "agent_end", projectId: PB, ts: 1 });

    // 修复前:idle —— 而 `ChatSurface.tsx` 的发送按钮正是 `status === "streaming"`
    // 才禁用,顶部「推演中」也吃同一个值 ⇒ 用户在 A 还在流的时候被允许再发一句
    expect(s().status).toBe("streaming");

    // 收口自己那一轮之后才回 idle
    s().applyEvent({ type: "agent_end", projectId: PA, ts: 2 });
    expect(s().status).toBe("idle");
  });

  it("**正样本**:`tool_start` 建出来的轮也带着自己的上下文(第二个建轮点)", () => {
    const s = () => useChatStore.getState();
    // B 的轮只由 tool_start 建出来(message_start 缺席 —— 那是允许的,§2.10.2)
    s().applyEvent({
      type: "tool_start", projectId: PB, messageId: "b-tool", agentId: PM,
      tool: { id: "t1", name: "decompose_project" },
    });
    // A 的 agent_end 不许碰它:A 在 B 之后收口
    s().applyEvent({ type: "message_start", projectId: PA, messageId: "a1", role: "assistant", agentId: BM });
    s().applyEvent({ type: "agent_end", projectId: PA, ts: 1 });
    expect(s().inFlight["b-tool"]).toBeDefined();

    // 反过来,B 自己的孩子自己收
    s().applyEvent({ type: "agent_end", projectId: PB, ts: 2 });
    expect(s().inFlight["b-tool"]).toBeUndefined();
    expect(s().turns.find((t) => t.id === "b-tool")?.agentId).toBe(PM);
  });

  it("**负样本/边界**:接待会话(`projectId: null`)是一个真上下文,不是「通配」", () => {
    const s = () => useChatStore.getState();
    // 接待会话正在流(null)+ 项目 A 正在流(PA)同时存在
    s().applyEvent({ type: "message_start", projectId: PA, messageId: "a1", role: "assistant", agentId: BM });
    s().applyEvent({ type: "message_start", projectId: null, messageId: "i1", role: "assistant", agentId: BM });
    s().applyEvent({ type: "agent_end", projectId: null, ts: 1 });

    // 接待的 agent_end 只收接待那一条
    expect(s().inFlight["i1"]).toBeUndefined();
    expect(s().inFlight["a1"]).toBeDefined();
    expect(s().turns.map((t) => t.id)).toEqual(["i1"]);

    // A 的 agent_end 只收 A 那一条
    s().applyEvent({ type: "agent_end", projectId: PA, ts: 2 });
    expect(s().inFlight).toEqual({});
    expect(s().inFlightOrder).toEqual([]);
  });

  it("**负样本**:同一个项目里两条消息照旧一起 flush(修复不许伤单项目路径)", () => {
    const s = () => useChatStore.getState();
    s().applyEvent({ type: "message_start", projectId: PA, messageId: "a1", role: "assistant", agentId: BM });
    s().applyEvent({ type: "message_start", projectId: PA, messageId: "a2", role: "assistant", agentId: BM });
    s().applyEvent({ type: "delta", projectId: PA, messageId: "a1", text: "AAA" });
    s().applyEvent({ type: "delta", projectId: PA, messageId: "a2", text: "BBB" });
    s().applyEvent({ type: "agent_end", projectId: PA, ts: 1 });

    // 同项目的整张表按开始顺序一起收口(A2 的原始语义,一字不改)
    expect(s().turns.map((t) => t.id)).toEqual(["a1", "a2"]);
    expect(s().inFlight).toEqual({});
    expect(s().inFlightOrder).toEqual([]);
    expect(s().currentTurn).toBeNull();
    expect(inFlightTurns(s())).toEqual([]);
  });

  it("**负样本**:别的项目的 agent_end 不许把 A 的 `currentTurn` 兼容指针打空", () => {
    const s = () => useChatStore.getState();
    s().applyEvent({ type: "message_start", projectId: PA, messageId: "a1", role: "assistant", agentId: BM });
    s().applyEvent({ type: "message_start", projectId: PB, messageId: "b1", role: "assistant", agentId: PM });
    // 指针此刻在 B 上(最后写入的是 B)——
    s().applyEvent({ type: "agent_end", projectId: PB, ts: 1 });
    // B 收口后指针必须落回**还活着的那一轮**,不能是 null / 也不能指向已收口的 b1
    expect(s().currentTurn?.id).toBe("a1");
    s().applyEvent({ type: "agent_end", projectId: PA, ts: 2 });
    expect(s().currentTurn).toBeNull();
  });
});
