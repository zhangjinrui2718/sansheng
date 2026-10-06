/**
 * A2 · **按 `messageId` 的轮表**取代单一 `currentTurn` 槽(设计 1 §2.10.3)
 *
 * ── 缺陷现场(实测的,不是推断)────────────────────────────────────
 *
 * 一个回合里可以**并发存在多条消息**:业务经理「先说话 → 调 `tell_client` 播报 →
 * 再说话」时,播报在回合**内部**发一整套独立信封(`hub.ts` 的
 * `message_start(msgB)` + `delta` + `message_end`)。只有**一个** `currentTurn` 槽时,
 * `message_start(msgB)` 把它覆盖掉,随后回来的 `delta(msgA, 后半段)` 因为**不校验
 * `messageId`** 被追加到 `msgB` 上 ⇒ 前半段正文从没进过任何一轮,而刷新后 REST
 * 又给出两条独立消息 ⇒ **流式视图与刷新后视图不一致,且少了半段在界面上看不出来**。
 *
 * 修复前本文件第 1 条的输出(实测,探针原样):
 *
 *     turns = [{"id":"msgB","blocks":[{"kind":"text","text":"播报BBB"}]}]
 *
 * 修复后:
 *
 *     turns = [{"id":"msgA","blocks":[{"kind":"text","text":"AAABBB"}]},
 *              {"id":"msgB","blocks":[{"kind":"text","text":"播报"}]}]
 *
 * ── 为什么直测 store 而不是渲染层 ─────────────────────────────────
 *
 * `applyEvent` 是 store 上的纯逻辑,直测它最贴近 bug 现场;渲染层在 node 下走
 * zustand 的 server snapshot,`setState` 驱动不了(同 `tests/web/ghost-echo.test.ts`
 * 的已知边界)。**流式期间「同时看到两轮」是 A3 的渲染改动** —— 本文件只钉数据层。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inFlightTurns, useChatStore } from "../../web/src/stores/chat.js";

const P = "p-turn-table";
/** 业务经理 / 项目经理 —— 两个不同作者,用来验 `agentId` 真的分得开(§2.10.2)。 */
const BM = "ag_bm";
const PM = "ag_pm";

beforeEach(() => {
  useChatStore.setState({
    turns: [],
    inFlight: {},
    inFlightOrder: [],
    currentTurn: null,
    lastUserEchoId: null,
    currentUsage: { input: 0, output: 0 },
  });
});

/** 只取断言关心的三样:轮的身份、谁说的、块。 */
function shape(turns: ReadonlyArray<{ id: string; agentId: string | null; blocks: unknown }>) {
  return turns.map((t) => ({ id: t.id, agentId: t.agentId, blocks: t.blocks }));
}

describe("A2 · §2.10.3 那段序列必须产出两轮", () => {
  it("msgA 的正文 + msgB 的播报各自独立,不再是合并的一条", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "msgA", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({ type: "delta", projectId: P, messageId: "msgA", text: "AAA" });
    // 回合中途的播报:一整套独立信封
    s.applyEvent({ type: "message_start", projectId: P, messageId: "msgB", role: "assistant", agentId: BM , source: "broadcast"});
    s.applyEvent({ type: "delta", projectId: P, messageId: "msgB", text: "播报" });
    s.applyEvent({ type: "message_end", projectId: P, messageId: "msgB" });
    // 播报之后,msgA 的正文继续流
    s.applyEvent({ type: "delta", projectId: P, messageId: "msgA", text: "BBB" });
    s.applyEvent({ type: "agent_end", projectId: P, ts: 0 });

    expect(shape(useChatStore.getState().turns)).toEqual([
      { id: "msgA", agentId: BM, blocks: [{ kind: "text", text: "AAABBB" }] },
      { id: "msgB", agentId: BM, blocks: [{ kind: "text", text: "播报" }] },
    ]);
  });

  it("流式期间两轮**同时**在轮表里(数据层不丢字;屏幕上同时看到两轮 = A3)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "msgA", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({ type: "delta", projectId: P, messageId: "msgA", text: "AAA" });
    s.applyEvent({ type: "message_start", projectId: P, messageId: "msgB", role: "assistant", agentId: BM , source: "broadcast"});
    s.applyEvent({ type: "delta", projectId: P, messageId: "msgB", text: "播报" });

    expect(shape(inFlightTurns(useChatStore.getState()))).toEqual([
      { id: "msgA", agentId: BM, blocks: [{ kind: "text", text: "AAA" }] },
      { id: "msgB", agentId: BM, blocks: [{ kind: "text", text: "播报" }] },
    ]);
    // 还没收口 —— 一条都不该提前进 turns
    expect(useChatStore.getState().turns).toEqual([]);
  });
});

describe("A2 · 同一 messageId 连续追加 / 不同 messageId 交错互不污染", () => {
  it("同一 messageId 的 delta 连续追加到同一轮", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m1", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({ type: "delta", projectId: P, messageId: "m1", text: "一" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m1", text: "二" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m1", text: "三" });

    expect(useChatStore.getState().inFlight["m1"]?.blocks).toEqual([
      { kind: "text", text: "一二三" },
    ]);
  });

  it("两条消息交错到达:各自只进自己那一轮", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m1", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m2", role: "assistant", agentId: PM , source: "turn", trigger: { kind: "todo", todoKind: "execute_work" }});
    s.applyEvent({ type: "delta", projectId: P, messageId: "m1", text: "1" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m2", text: "2" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m1", text: "3" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m2", text: "4" });

    const st = useChatStore.getState();
    expect(st.inFlight["m1"]?.blocks).toEqual([{ kind: "text", text: "13" }]);
    expect(st.inFlight["m2"]?.blocks).toEqual([{ kind: "text", text: "24" }]);
    // 交错不改变**开始顺序**(agent_end flush 时靠它,不能用 startedAt 推)
    expect(st.inFlightOrder).toEqual(["m1", "m2"]);
    // 各自的作者没被邻居改写
    expect(st.inFlight["m1"]?.agentId).toBe(BM);
    expect(st.inFlight["m2"]?.agentId).toBe(PM);
  });

  it("思考流与正文流交错时也各自分轮(7-I:两条流永不混流)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m1", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({ type: "thinking_delta", projectId: P, messageId: "m1", text: "想1" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m1", text: "说1" });
    s.applyEvent({ type: "thinking_delta", projectId: P, messageId: "m1", text: "想2" });
    s.applyEvent({ type: "delta", projectId: P, messageId: "m1", text: "说2" });

    expect(useChatStore.getState().inFlight["m1"]?.blocks).toEqual([
      { kind: "thinking", text: "想1" },
      { kind: "text", text: "说1" },
      { kind: "thinking", text: "想2" },
      { kind: "text", text: "说2" },
    ]);
  });
});

describe("A2 · message_end 只收口它自己那一轮", () => {
  it("收口 m2 时 m1 仍在流,且 m1 的迟到 delta 只进 m1", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m1", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m2", role: "assistant", agentId: BM , source: "broadcast"});
    s.applyEvent({ type: "delta", projectId: P, messageId: "m2", text: "播报" });
    s.applyEvent({ type: "message_end", projectId: P, messageId: "m2" });

    const st = useChatStore.getState();
    expect(st.inFlight["m2"]?.isStreaming).toBe(false);
    // **m1 没被顺手收口**
    expect(st.inFlight["m1"]?.isStreaming).toBe(true);

    // 收口之后 m1 的正文照旧进它自己那一轮,m2 一个字都不该多
    s.applyEvent({ type: "delta", projectId: P, messageId: "m1", text: "后半段" });
    const st2 = useChatStore.getState();
    expect(st2.inFlight["m1"]?.blocks).toEqual([{ kind: "text", text: "后半段" }]);
    expect(st2.inFlight["m2"]?.blocks).toEqual([{ kind: "text", text: "播报" }]);
  });

  it("没人宣布过的 messageId:delta / thinking_delta / message_end 一律丢弃(不猜角色)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-ghost", text: "无主正文" });
    s.applyEvent({ type: "thinking_delta", projectId: P, messageId: "m-ghost", text: "无主推理" });
    s.applyEvent({
      type: "message_end",
      projectId: P,
      messageId: "m-ghost",
      usage: { input: 7, output: 7 },
    });

    const st = useChatStore.getState();
    expect(st.turns).toEqual([]);
    expect(st.inFlight).toEqual({});
    expect(st.inFlightOrder).toEqual([]);
    expect(st.currentTurn).toBeNull();
    // 连 usage 都不记 —— 没有那一轮就没有可收的口(§2.10.3 的「收口」是逐轮的)
    expect(st.currentUsage).toEqual({ input: 0, output: 0 });
  });
});

describe("A2 · agentId 存进轮里(A3 用它过滤与标注,A2 不做过滤)", () => {
  it("两个能建轮的事件都带上作者;agent_end flush 之后仍在", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m-bm", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({ type: "delta", projectId: P, messageId: "m-bm", text: "我来收敛" });
    // tool_start 自己也能建轮 —— 它是 agentId 的另一个构造点(§2.10.2)
    s.applyEvent({
      type: "tool_start",
      projectId: P,
      messageId: "m-pm",
      agentId: PM,
      tool: { id: "t1", name: "decompose_project" },
    });
    s.applyEvent({ type: "agent_end", projectId: P, ts: 0 });

    expect(useChatStore.getState().turns.map((t) => [t.id, t.agentId])).toEqual([
      ["m-bm", BM],
      ["m-pm", PM],
    ]);
  });

  it("tool_start **不改写**已有轮的作者(身份在建轮那一刻就定了)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m1", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({
      type: "tool_start",
      projectId: P,
      messageId: "m1",
      // 信封上永远是同一个作者;这里故意给一个不同的值,钉住「以建轮那一刻为准」
      agentId: PM,
      tool: { id: "t1", name: "board_write" },
    });

    expect(useChatStore.getState().inFlight["m1"]?.agentId).toBe(BM);
  });

  it("tool_end 只改它自己那个 messageId 的工具卡", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: P, messageId: "m1", role: "assistant", agentId: BM , source: "turn", trigger: { kind: "user" }});
    s.applyEvent({
      type: "tool_start", projectId: P, messageId: "m1", agentId: BM,
      tool: { id: "t1", name: "board_write" },
    });
    s.applyEvent({
      type: "message_start", projectId: P, messageId: "m2", role: "assistant", agentId: PM, source: "turn", trigger: { kind: "todo", todoKind: "execute_work" },
    });
    s.applyEvent({
      type: "tool_start", projectId: P, messageId: "m2", agentId: PM,
      tool: { id: "t2", name: "board_read" },
    });
    s.applyEvent({
      type: "tool_end", projectId: P, messageId: "m1",
      tool: { id: "t1", name: "board_write", result: "ok" },
    });

    const st = useChatStore.getState();
    expect(st.inFlight["m1"]?.blocks).toEqual([
      { kind: "tool", tool: { id: "t1", name: "board_write", result: "ok" } },
    ]);
    // m2 的工具卡**不被别人的 tool_end 顺手改掉**
    expect(st.inFlight["m2"]?.blocks).toEqual([
      { kind: "tool", tool: { id: "t2", name: "board_read" } },
    ]);
  });
});

// ── REST 回填那条路径(§2.10.1:「`messageToTurn` 拿到又丢掉」)──────────
//
// `agentId` 有两个来源:WS 建轮(上面)+ 刷新时的 REST 回填(`selectProject` /
// `loadIntakeMessages`)。只补前者的话,**刷新一次作者就没了** —— 而 A3 要靠它标注。
describe("A2 · REST 回填也把 agentId 带进轮里", () => {
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("selectProject 拉回的消息按 SessionMessageView.agentId 落轮(null = 甲方)", async () => {
    // ⚠️ `/projects/:id/sessions` **必须也在夹具里**(migration 024):`selectProject`
    // 现在先列会话、挑一条线,再拉那条线的消息。少了这一条,`listProjectSessions`
    // 拿 404 ⇒ `sessions` 空 ⇒ 没有线可选 ⇒ **一条消息都不回填** ——
    // 而那个表现像「REST 回填坏了」,其实是夹具缺了一条路由。
    const routes: Record<string, unknown> = {
      "/projects/p-rest/sessions": {
        projectId: "p-rest",
        sessions: [
          {
            id: "s_main", kind: "main", title: null, channel: "internal",
            deliverableArtifactId: null, createdAt: 0, lastMessageAt: 2,
          },
        ],
      },
      "/projects/p-rest/messages?sessionId=s_main": {
        projectId: "p-rest",
        messages: [
          // ⚠️ `origin` 是 `SessionMessageView` 的**必填**字段(W3-①,migration 019):
          // REST 回填现在照抄库里的封套。漏了它 `channelOf` 会抛一个看不出是哪条
          // 字段漏了的 TypeError(`tests/` 不受 tsc 约束)—— 由
          // `fixture-envelope-fields.test.ts` 的规则 3 扫着。
          { id: "m1", sessionId: "s_main", projectId: "p-rest", agentId: "ag_wk", agentName: "wk", kind: "assistant", content: "我来做", createdAt: 1, origin: { source: "turn", trigger: { kind: "todo" } } },
          { id: "m2", sessionId: "s_main", projectId: "p-rest", agentId: null, agentName: null, kind: "user", content: "好", createdAt: 2, origin: { source: "turn", trigger: { kind: "user" } } },
        ],
      },
    };
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("/api", "");
      if (!(path in routes)) {
        return { ok: false, status: 404, statusText: "Not Found", text: async () => "{}" };
      }
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(routes[path]) };
    });

    await useChatStore.getState().selectProject("p-rest");

    expect(useChatStore.getState().turns.map((t) => [t.id, t.agentId])).toEqual([
      ["m1", "ag_wk"],
      ["m2", null],
    ]);
    // ⚠️ 正样本自检:每条轮都记着**它落在哪条线**上(migration 024)。
    // 不写这一条,「模型在 A 线说的话出现在 B 线面板」就会长得像一段正常回复。
    expect(useChatStore.getState().turns.map((t) => t.sessionId)).toEqual(["s_main", "s_main"]);
  });
});
