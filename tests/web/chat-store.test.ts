/**
 * Sansheng 前端 chat store 单测(批次 3 B10 组)
 *
 * 覆盖(纯 store 逻辑,node 环境即可 —— zustand vanilla,无需 DOM;
 * chat.ts 的 @shared/* 全是 `import type` 运行时擦除,唯一运行时依赖 zustand):
 *   F2 (B10-1):bus_event 按 message.id 去重;loadConversation 清空 busStream;
 *                ready 后发 bus_replay。
 *   F3 (B10-2):ready 携带不同 conversationId 时 —— 本地有 turns → 发
 *                load_conversation(本地id) 且不覆盖;本地无 turns → 采用 server id;
 *                ready 清 pendingQuestions。
 *   F4 (B10-3):sendAnswerQuestion/sendCancelQuestion 乐观移除对应 questionId;
 *                收到 no_pending_question error 也移除。
 *
 * RED:以上均为当前 chat.ts 未实现的行为(现状:直接 append、ready 无条件覆盖、
 * pendingQuestions 只增不减、无 bus_replay)。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "../../web/src/stores/chat.js";
import type { BusMessage } from "@shared/types/agents";

function busMsg(id: string, conversationId: string, ts: number, payload = id): BusMessage {
  return {
    id,
    ts,
    direction: "comm→user",
    fromRole: "communicator",
    toRole: "user",
    conversationId,
    kind: "broadcast",
    payload,
  };
}

interface FakeSocket {
  send(cmd: unknown): void;
  readonly sent: unknown[];
}

let sent: unknown[] = [];
function makeSocket(): FakeSocket {
  sent = [];
  return {
    sent,
    send(cmd: unknown) {
      sent.push(cmd);
    },
  };
}

function lastCmdOfType(t: string): Record<string, unknown> | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const c = sent[i] as Record<string, unknown>;
    if (c && c.type === t) return c;
  }
  return undefined;
}

beforeEach(() => {
  // 复位到干净的初始 store 状态
  useChatStore.setState({
    conversationId: null,
    modelId: null,
    provider: null,
    status: "connecting",
    kernelReady: false,
    historyRefreshTrigger: 0,
    busStream: [],
    communicatorStatus: "idle",
    pendingQuestions: [],
    answerDraft: new Map<string, string>(),
    turns: [],
    currentTurn: null,
    currentUsage: { input: 0, output: 0, costUsd: 0 },
    totalUsage: { input: 0, output: 0, costUsd: 0 },
    error: null,
    socket: null,
  });
});

describe("chat store · F2 (B10-1) bus 去重 / 清空 / replay", () => {
  it("bus_event 按 message.id 去重(重复 id 只保留一条)", () => {
    const st = useChatStore.getState();
    st.applyEvent({ type: "bus_event", message: busMsg("m1", "c1", 100) });
    st.applyEvent({ type: "bus_event", message: busMsg("m1", "c1", 100) }); // 重复(replay 重发)
    st.applyEvent({ type: "bus_event", message: busMsg("m2", "c1", 200) });
    const stream = useChatStore.getState().busStream;
    expect(stream.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("loadConversation 清空 busStream(切会话不残留上一会话事件)", () => {
    const st = useChatStore.getState();
    st.applyEvent({ type: "bus_event", message: busMsg("m1", "c1", 100) });
    expect(useChatStore.getState().busStream.length).toBe(1);
    st.loadConversation({
      conversation: {
        id: "c2",
        title: null,
        cwd: null,
        modelId: null,
        provider: null,
        createdAt: 0,
        lastActiveAt: 0,
        messageCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
      },
      messages: [],
    });
    const s2 = useChatStore.getState();
    expect(s2.conversationId).toBe("c2");
    expect(s2.busStream).toEqual([]);
  });

  it("ready 后发 bus_replay(conversationId + fromTs)", () => {
    const sock = makeSocket();
    useChatStore.getState().attachSocket(sock);
    useChatStore.getState().applyEvent({
      type: "ready",
      conversationId: "c1",
      modelId: "m",
      provider: "p",
    });
    const replay = lastCmdOfType("bus_replay");
    expect(replay).toBeTruthy();
    expect(replay!.conversationId).toBe("c1");
    expect(typeof replay!.fromTs).toBe("number");
  });
});

describe("chat store · F3 (B10-2) ready conversationId 对齐", () => {
  it("本地有 turns 且 id 不匹配 → 发 load_conversation(本地id),不覆盖 conversationId", () => {
    const sock = makeSocket();
    const st = useChatStore.getState();
    st.attachSocket(sock);
    // 本地已有会话 + turns
    useChatStore.setState({
      conversationId: "local-conv",
      turns: [
        { id: "t1", role: "user", blocks: [{ kind: "text", text: "hi" }], startedAt: 1 },
      ],
    });
    st.applyEvent({
      type: "ready",
      conversationId: "server-fresh-conv", // server 重启后的新 id
      modelId: "m",
      provider: "p",
    });
    // 不覆盖本地 id
    expect(useChatStore.getState().conversationId).toBe("local-conv");
    // 发出 load_conversation 让 server resume 到本地 id
    const lc = lastCmdOfType("load_conversation");
    expect(lc).toBeTruthy();
    expect(lc!.conversationId).toBe("local-conv");
  });

  it("本地无 turns 且 id 不匹配 → 采用 server conversationId", () => {
    const sock = makeSocket();
    const st = useChatStore.getState();
    st.attachSocket(sock);
    useChatStore.setState({ conversationId: "stale-conv", turns: [] });
    st.applyEvent({
      type: "ready",
      conversationId: "server-conv",
      modelId: "m",
      provider: "p",
    });
    expect(useChatStore.getState().conversationId).toBe("server-conv");
    // 无 turns → 不需要 load_conversation
    expect(lastCmdOfType("load_conversation")).toBeUndefined();
  });

  it("ready 清空 pendingQuestions(旧会话遗留的提问不残留)", () => {
    const sock = makeSocket();
    useChatStore.getState().attachSocket(sock);
    useChatStore.setState({
      conversationId: "c1",
      pendingQuestions: [
        { questionId: "q1", payload: "?", fromRole: "executor", ts: 1 },
      ],
    });
    useChatStore.getState().applyEvent({
      type: "ready",
      conversationId: "c1",
      modelId: "m",
      provider: "p",
    });
    expect(useChatStore.getState().pendingQuestions).toEqual([]);
  });
});

describe("chat store · F4 (B10-3) pendingQuestions 移除", () => {
  function seedQuestions() {
    useChatStore.setState({
      conversationId: "c1",
      pendingQuestions: [
        { questionId: "q1", payload: "?", fromRole: "executor", ts: 1 },
        { questionId: "q2", payload: "?", fromRole: "executor", ts: 2 },
      ],
    });
  }

  it("sendAnswerQuestion 乐观移除对应 questionId + 发命令", () => {
    const sock = makeSocket();
    const st = useChatStore.getState();
    st.attachSocket(sock);
    seedQuestions();
    st.sendAnswerQuestion("q1", "我的回答");
    const qs = useChatStore.getState().pendingQuestions.map((q) => q.questionId);
    expect(qs).toEqual(["q2"]);
    const ans = lastCmdOfType("answer_question");
    expect(ans).toBeTruthy();
    expect(ans!.questionId).toBe("q1");
  });

  it("sendCancelQuestion 乐观移除对应 questionId + 发命令", () => {
    const sock = makeSocket();
    const st = useChatStore.getState();
    st.attachSocket(sock);
    seedQuestions();
    st.sendCancelQuestion("q2");
    const qs = useChatStore.getState().pendingQuestions.map((q) => q.questionId);
    expect(qs).toEqual(["q1"]);
    const cancel = lastCmdOfType("cancel_question");
    expect(cancel).toBeTruthy();
    expect(cancel!.questionId).toBe("q2");
  });

  it("收到 no_pending_question error → 移除消息中提及的 questionId", () => {
    seedQuestions();
    useChatStore.getState().applyEvent({
      type: "error",
      conversationId: "c1",
      error: { code: "no_pending_question", message: "question q1 不在 pending" },
    });
    const qs = useChatStore.getState().pendingQuestions.map((q) => q.questionId);
    expect(qs).toEqual(["q2"]);
  });
});

/* ── 批次 7-I(B):plan_done 的交付物必须渲染成可见块 ──────────────────────
 *
 * B 缺陷的正面解。7-I 之前 `plan_done` 的处理是
 *   `blocks: [{ kind: "text", text: e.summary }]`
 * —— 协议上事件早就带着整个 artifacts,前端却只渲染一行 summary,于是执行者
 * 做出来的产物(可能是一份几千字的技术方案)只躺在 blackboard 里,要用户自己去
 * 「工件」tab 翻。这条测试守住「deliveries 必须变成 turn 里可见的 block」。
 */
describe("7-I 交付物 · plan_done → 可见的 delivery block", () => {
  const base = {
    type: "plan_done" as const,
    conversationId: "c-del",
    intentId: "intent-1",
    summary: '计划 "外呼方案" 完成 1/1',
  };

  it("带 deliveries → turn 里出现 delivery block,正文原样保留", () => {
    const st = useChatStore.getState();
    st.applyEvent({
      ...base,
      deliveries: [
        { id: "ev-1", kind: "evidence", title: "外呼电销技术方案", body: "# 方案\n\n## 架构\nASR + LLM + TTS" },
      ],
    });
    const turn = useChatStore.getState().turns.at(-1);
    expect(turn?.blocks[0]).toEqual({ kind: "text", text: base.summary });
    const delivery = turn?.blocks[1];
    expect(delivery?.kind).toBe("delivery");
    if (delivery?.kind === "delivery") {
      expect(delivery.items).toHaveLength(1);
      expect(delivery.items[0]?.title).toBe("外呼电销技术方案");
      // 正文不能被摘要掉 —— 这正是 B 要修的东西
      expect(delivery.items[0]?.body).toContain("ASR + LLM + TTS");
    }
  });

  it("多篇交付全部保留(不是只取第一篇)", () => {
    const st = useChatStore.getState();
    st.applyEvent({
      ...base,
      deliveries: [
        { id: "ev-1", kind: "evidence", title: "方案一", body: "A" },
        { id: "ev-2", kind: "evidence", title: "方案二", body: "B" },
      ],
    });
    const delivery = useChatStore.getState().turns.at(-1)?.blocks[1];
    if (delivery?.kind === "delivery") expect(delivery.items.map((i) => i.id)).toEqual(["ev-1", "ev-2"]);
    else throw new Error("delivery block 缺失");
  });

  it("无 deliveries → 不产生空块(只有 summary,与 7-I 之前行为一致)", () => {
    const st = useChatStore.getState();
    st.applyEvent(base);
    expect(useChatStore.getState().turns.at(-1)?.blocks).toEqual([{ kind: "text", text: base.summary }]);
  });

  it("deliveries 为空数组 → 同样不产生空块", () => {
    const st = useChatStore.getState();
    st.applyEvent({ ...base, deliveries: [] });
    expect(useChatStore.getState().turns.at(-1)?.blocks).toHaveLength(1);
  });
});
