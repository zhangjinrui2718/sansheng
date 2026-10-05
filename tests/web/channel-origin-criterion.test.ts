/**
 * W2-④ · **新显示判据**(封套级)+ 块级过滤 —— 六条验收判据的实测(2026-10-06)
 *
 * ── 判据(设计定型,不在这里重新论证)─────────────────────────────
 *
 *     进甲方通道 ⟺ 用户消息(`agentId === null`)
 *                ∨ `source === "broadcast"`(tell_client 的播报,**无条件**显示)
 *                ∨ `trigger.kind === "user"` 的回合正文
 *     其余一律不进 —— 无论它由谁触发、是哪个角色
 *
 * ⇒ **`clientFacing`(角色级)不再是判据**:业务经理**被工件叫醒的那一轮正文也不进**
 * —— 它若真对甲方说了话,那话在 `tell_client` 的播报里(**那条会显示**)。
 *
 * ── 为什么这一份从 `applyEvent` 出发(而不是手搓 `Turn`)────────────────
 *
 * 判据的输入是 `Turn.origin`,而它**只能**由建轮事件带进来(`message_start` 的
 * `source` / `trigger`;`delta` / `message_end` 不带)。手搓 `Turn` 能测判据本身
 * (`channel-filter.test.ts` 在做),但测不出**「这两维真的从线上落到轮里了吗」**
 * —— 而那正是 W1-① 点名的坑(42 个手搓夹具漏填 ⇒ 运行期 TypeError)。
 * 所以这里走真事件:`applyEvent` → `turns` → `channelOf` → 渲染。
 *
 * ── 与「刷新之后」那条缺口的关系(W3-① 已闭合,2026-10-06)───────────
 *
 * 这一段此前写的是**缺口**:`SessionMessageView` 上既没有 `source` 也没有
 * `trigger`(库里没落这两维)⇒ REST 回填出来的轮 `origin` 只能是 `unknown`
 * ⇒ 判据**回退**到角色的两跳 ⇒ **刷新一次,工件触发的业务经理回合又出现在对话页**。
 *
 * 现在两维落库了(`session_messages.origin_source` / `trigger_kind`,
 * migration 019),`SessionMessageView.origin` **就是** `MessageOrigin`
 * (`shared/types/platform.ts`)⇒ 刷新那条路与流式那条路**产出的形状完全相同**:
 *   - 判据①②③在**流式**这条路上逐条成立(下面每一条都有样本);
 *   - **刷新之后同样成立** —— 见下面 `REST 回填` 那一段的两组样本:
 *     ① 带封套的行(019 之后)按判据分流;② **不带封套的行(019 之前的存量行)**
 *     仍是 `unknown`,回退判据对它们继续有效(那是**旧数据的兜底**,不是主判据)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberView, ProjectRole, ServerEvent, TurnTrigger } from "@shared/types/platform";
import {
  channelActivityOf,
  channelContextOf,
  channelOf,
  partitionTurns,
  surfaceStatusOf,
  type ChannelContext,
} from "@/lib/data";
import {
  ConversationStream,
  InternalProcessDisclosure,
  INTERNAL_PROCESS_DEFAULT_OPEN,
  layerBlocks,
} from "@/components/chat/MessageList";
import { inFlightTurns, useChatStore, type Turn } from "@/stores/chat";

const P = "p-w2";
const BM = "bm";
const WK = "wk";

const MEMBERS: MemberView[] = [
  { id: "bm", role: "business_manager", displayName: "业务经理", specialization: null },
  { id: "pm", role: "project_manager", displayName: "项目经理", specialization: null },
  { id: "wk", role: "worker", displayName: "工程师", specialization: "engineering" },
  { id: "qa", role: "quality_reviewer", displayName: "质检", specialization: null },
];

const ROLES: Array<{ role: ProjectRole; clientFacing: boolean }> = [
  { role: "business_manager", clientFacing: true },
  { role: "project_manager", clientFacing: false },
  { role: "worker", clientFacing: false },
  { role: "quality_reviewer", clientFacing: false },
];

const CTX: ChannelContext = channelContextOf({ members: MEMBERS, roles: ROLES, ready: true, intake: false });

const REASONING = "甲方要的是交付,但下游还有 3 条阻塞 —— 我先跟项目经理对一下再决定要不要打扰他。";
const TOOL_NAME = "blocker_read";
const BODY = "收到,我看了一遍。";

beforeEach(() => {
  useChatStore.setState({
    projectId: P,
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

const s = () => useChatStore.getState();
const landed = (): Turn[] => s().turns;

/**
 * 建轮封套的两维(契约 `TurnMessageStart` / `BroadcastMessageStart`)。
 * 播报那一支**结构上就没有** `trigger` —— 这里照抄契约,不自己造一个可选的形状。
 */
type Envelope = { source: "turn"; trigger: TurnTrigger } | { source: "broadcast" };

/** 真机形状:一轮 = `message_start` → thinking → tool → 正文 → `agent_end`。 */
function runTurn(
  messageId: string,
  agentId: string,
  envelope: Envelope,
  opts: { reasoning?: string; tool?: string; text?: string } = {},
): void {
  s().applyEvent({
    // fixture-lint: allow —— `source` / `trigger` 由 `...envelope`(上面那个
    // `Envelope` 联合)**展开**进来,源码扫描看不见;它们确实在(runTurn 的每个
    // 调用点都必须给出其中一支)。
    type: "message_start", projectId: P, messageId, role: "assistant", agentId,
    ...envelope,
  });
  if (opts.reasoning !== undefined) {
    s().applyEvent({ type: "thinking_delta", projectId: P, messageId, text: opts.reasoning });
  }
  if (opts.tool !== undefined) {
    s().applyEvent({
      type: "tool_start", projectId: P, messageId, agentId,
      tool: { id: `${messageId}-t1`, name: opts.tool },
    });
    s().applyEvent({
      type: "tool_end", projectId: P, messageId,
      tool: { id: `${messageId}-t1`, name: opts.tool, result: "ok" },
    });
  }
  if (opts.text !== undefined) {
    s().applyEvent({ type: "delta", projectId: P, messageId, text: opts.text });
  }
}

function renderTimeline(turns: readonly Turn[]): string {
  const { timeline } = partitionTurns(turns, CTX);
  return renderToStaticMarkup(
    createElement(ConversationStream, { history: timeline, streaming: [], hiddenNote: null }),
  );
}

// ── ① 工件触发的业务经理回合:正文 + 工具卡 + 思考块,**都不进** ──────────
describe("① 工件 / 待办触发的业务经理回合不进甲方时间线(作者不再是判据)", () => {
  it("**整轮被滤掉**:正文、工具卡、思考块一个都不上屏", () => {
    runTurn("m-todo", BM, { source: "turn", trigger: { kind: "todo", todoKind: "report_downstream" } }, {
      reasoning: REASONING, tool: TOOL_NAME, text: BODY,
    });
    s().applyEvent({ type: "agent_end", projectId: P, ts: 1 });

    const turns = landed();
    expect(turns).toHaveLength(1);
    // 轮确实建出来了(数据层不丢),判据把它挡在通道外
    // ⚠️ **只带 `kind`**(W3-① 起前端那条 origin 收窄到 `TurnTriggerKind`):
    // `todoKind` 不参与判定,落库那条路也拿不到它 —— 两条路必须同形。
    expect(turns[0]?.origin).toEqual({ source: "turn", trigger: { kind: "todo" } });
    const { timeline, hidden } = partitionTurns(turns, CTX);
    expect(timeline, "业务经理是 clientFacing,但这不是判据了").toEqual([]);
    expect(hidden).toBe(1);

    const html = renderTimeline(turns);
    expect(html).not.toContain(REASONING);
    expect(html).not.toContain(TOOL_NAME);
    expect(html).not.toContain(BODY);
  });

  it("**变异方向**:同样一轮,把它改成 `trigger.kind === \"user\"` ⇒ 立刻进(证明红的是判据不是夹具)", () => {
    runTurn("m-user", BM, { source: "turn", trigger: { kind: "user" } }, {
      reasoning: REASONING, tool: TOOL_NAME, text: BODY,
    });
    s().applyEvent({ type: "agent_end", projectId: P, ts: 1 });
    const { timeline, hidden } = partitionTurns(landed(), CTX);
    expect(hidden).toBe(0);
    expect(timeline.map((x) => x.turn.id)).toEqual(["m-user"]);
  });
});

// ── ② 播报(即使发生在工件触发的那一轮里)**进** ────────────────────────
describe("② `tell_client` 的播报无条件进(负样本方向:不许一刀切)", () => {
  it("工件触发回合**内部**的播报照常进甲方时间线", () => {
    // 真机形状:业务经理被 report_downstream 叫醒,回合**内部** await 了一次
    // `tell_client` ⇒ 播报是**另一条**封套(`hub.ts` 的 clientChannel.tell)。
    runTurn("m-todo", BM, { source: "turn", trigger: { kind: "todo", todoKind: "report_downstream" } }, {
      reasoning: REASONING, tool: TOOL_NAME, text: "内部交代",
    });
    runTurn("m-broadcast", BM, { source: "broadcast" }, { text: "这次新增 2 个阻塞,预计晚 1 天。" });
    s().applyEvent({ type: "agent_end", projectId: P, ts: 1 });

    const turns = landed();
    expect(turns.map((t) => t.id)).toEqual(["m-todo", "m-broadcast"]);
    const { timeline, hidden } = partitionTurns(turns, CTX);
    expect(timeline.map((x) => x.turn.id), "只有播报那条进").toEqual(["m-broadcast"]);
    expect(timeline[0]?.channel).toBe("client");
    expect(hidden, "工件触发的那一轮仍被挡在外面").toBe(1);

    const html = renderTimeline(turns);
    expect(html).toContain("这次新增 2 个阻塞");
    expect(html, "同轮的内部正文不许跟着进来").not.toContain("内部交代");
    expect(html).not.toContain(REASONING);
  });
});

// ── ③ 用户消息 + `trigger.kind === "user"` 的回合正文 **进** ─────────────
describe("③ 用户触发的通道进(甲方消息 + user 触发的助手正文)", () => {
  it("甲方自己的消息进(server 回显那条 + 乐观上屏那条),且助手正文跟着进", () => {
    // server 对用户消息也发一整套信封(协议是统一信封)
    s().applyEvent({
      type: "message_start", projectId: P, messageId: "m-echo", role: "user", agentId: null,
      source: "turn", trigger: { kind: "user" },
    });
    s().applyEvent({ type: "delta", projectId: P, messageId: "m-echo", text: "把登录做出来" });
    s().applyEvent({ type: "message_end", projectId: P, messageId: "m-echo" });
    runTurn("m-reply", BM, { source: "turn", trigger: { kind: "user" } }, { reasoning: REASONING, text: "好,我来拆。" });
    s().applyEvent({ type: "agent_end", projectId: P, ts: 1 });

    const { timeline, hidden } = partitionTurns(landed(), CTX);
    expect(hidden).toBe(0);
    expect(timeline.map((x) => x.turn.id)).toEqual(["m-reply"]);
    // 用户那条回显不建轮(乐观上屏已有)—— 这是既有的幽灵轮纪律,没被改动
    expect(landed().map((t) => t.id)).toEqual(["m-reply"]);
    expect(renderTimeline(landed())).toContain("好,我来拆。");
  });
});

// ── ④ 块级过滤**可展开**,不是丢 ──────────────────────────────────────
describe("④ 块级过滤:折叠一行可展开,证据一个都不丢", () => {
  it("流式那轮(用户触发)里,思考 + 工具卡折成一行;展开后原样交回", () => {
    runTurn("m-tools", BM, { source: "turn", trigger: { kind: "user" } }, {
      reasoning: REASONING, tool: TOOL_NAME, text: BODY,
    });
    s().applyEvent({ type: "agent_end", projectId: P, ts: 1 });
    const turn = landed()[0]!;

    // 折叠行默认收起(常量可断言),正文照旧
    expect(INTERNAL_PROCESS_DEFAULT_OPEN).toBe(false);
    const html = renderTimeline(landed());
    expect(html).toContain('data-channel="internal-process"');
    expect(html).toContain("内部过程 2 步");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(BODY);
    expect(html, "折叠态不许把推理正文放进渲染产物").not.toContain(REASONING);
    expect(html, "折叠态不许把工具名放进渲染产物").not.toContain(TOOL_NAME);

    // **不是丢**:展开后工具卡回来,思考块回到它自己的折叠壳里(§2.10.4)
    const folded = layerBlocks(turn.blocks).internal;
    const opened = renderToStaticMarkup(
      createElement(InternalProcessDisclosure, { blocks: folded, open: true, onToggle: () => {} }),
    );
    expect(opened).toContain(TOOL_NAME);
    expect(opened).toContain("思考");
    expect(opened).toContain('aria-expanded="false"');
    // 数据层三摞合起来 === 原来的 blocks(一块都没被丢掉)
    const { before, after } = layerBlocks(turn.blocks);
    expect([...before, ...folded, ...after]).toEqual(turn.blocks);
  });
});

// ── ⑤ 输入框禁用与显示**同一个判据** ────────────────────────────────
describe("⑤ `surfaceStatusOf` / 输入框禁用不许给出第二个答案", () => {
  /** 在飞的轮逐个对照:客户端活动那一侧 ⟺ `channelOf === "client"`。 */
  function assertSameCriterion(): void {
    const live = inFlightTurns(s());
    const act = channelActivityOf(live, CTX, P);
    const byCriterion = live.filter((t) => channelOf(t, CTX) === "client").map((t) => t.id);
    expect(act.client.map((t) => t.id), "输入框判据必须与显示判据逐轮一致").toEqual(byCriterion);
    // 两个方向的另一侧:internal 那一摞也与判据一致
    expect(act.internal.map((t) => t.id)).toEqual(
      live.filter((t) => channelOf(t, CTX) === "internal").map((t) => t.id),
    );
  }

  it("工件触发的业务经理在跑 ⇒ 顶部 `internal`(输入框可用),而它在屏幕上也不显示", () => {
    runTurn("m-todo", BM, { source: "turn", trigger: { kind: "todo", todoKind: "report_downstream" } }, { text: BODY });
    assertSameCriterion();
    const act = channelActivityOf(inFlightTurns(s()), CTX, P);
    expect(surfaceStatusOf(s().status, act)).toBe("internal");
    expect(act.client).toEqual([]);
    // 屏幕上确实没有它 —— 两个答案一致
    expect(renderTimeline(inFlightTurns(s()))).not.toContain(BODY);
  });

  it("用户触发那一轮在跑 ⇒ 顶部 `streaming`(输入框禁用),而它在屏幕上显示", () => {
    runTurn("m-user", BM, { source: "turn", trigger: { kind: "user" } }, { text: BODY });
    assertSameCriterion();
    const act = channelActivityOf(inFlightTurns(s()), CTX, P);
    expect(surfaceStatusOf(s().status, act)).toBe("streaming");
    expect(renderTimeline(inFlightTurns(s()))).toContain(BODY);
  });

  it("播报在跑(工件触发那一轮的内部)⇒ `streaming`,而屏幕上就是那条播报", () => {
    runTurn("m-todo", BM, { source: "turn", trigger: { kind: "todo", todoKind: "report_downstream" } }, { text: "内部交代不许出现" });
    runTurn("m-bc", BM, { source: "broadcast" }, { text: "对甲方说的话" });
    assertSameCriterion();
    const act = channelActivityOf(inFlightTurns(s()), CTX, P);
    expect(act.client.map((t) => t.id), "只有播报那一轮算甲方通道").toEqual(["m-bc"]);
    expect(surfaceStatusOf(s().status, act)).toBe("streaming");
    const html = renderTimeline(inFlightTurns(s()));
    expect(html).toContain("对甲方说的话");
    expect(html, "同轮工件触发的内部正文不许跟着进来").not.toContain("内部交代不许出现");
  });

  it("别的项目里在跑的业务经理不许锁住这里的输入框(上下文仍然是恒等比较)", () => {
    s().applyEvent({
      type: "message_start", projectId: "p-other", messageId: "x", role: "assistant", agentId: BM,
      source: "turn", trigger: { kind: "todo", todoKind: "report_downstream" },
    });
    const act = channelActivityOf(inFlightTurns(s()), CTX, P);
    expect(act.client).toEqual([]);
    expect(surfaceStatusOf(s().status, act)).toBe("idle");
  });
});

// ── 建轮封套的两维:**漏填必须响亮**(W1-① 点名的那个运行期 TypeError)────
describe("契约守卫:`message_start` 漏填 source / trigger ⇒ 抛,不静默降级", () => {
  // ⚠️ 下面三条**故意**喂不合法封套(手搓夹具 / 探针的形状),所以必须绕过 tsc 的
  // 契约检查 —— 一处显式的 `as ServerEvent`,不是 `as any`(AGENTS.md 硬规则)。
  const malformed = (e: Record<string, unknown>): ServerEvent => e as unknown as ServerEvent;

  it("漏 `trigger` 的回合封套抛错,且错误信息说清缺了什么", () => {
    expect(() =>
      s().applyEvent(malformed({
        // fixture-lint: allow —— 这一条**故意**喂不合法封套(它守的就是 store 的抛)
        type: "message_start", projectId: P, messageId: "m-bad", role: "assistant", agentId: BM,
        source: "turn",
      })),
    ).toThrow(/缺 source \/ trigger/);
    expect(s().inFlight, "抛了就不该留下半条轮").toEqual({});
  });

  it("漏 `source`(旧夹具的形状)同样抛 —— 不许猜成 `turn`", () => {
    expect(() =>
      s().applyEvent(malformed({
        // fixture-lint: allow —— 同上:旧夹具的形状(缺 source)就是要喂的东西
        type: "message_start", projectId: P, messageId: "m-old", role: "assistant", agentId: BM,
        trigger: { kind: "user" },
      })),
    ).toThrow(/缺 source \/ trigger/);
  });

  it("**负样本**:播报封套(`source: \"broadcast\"`)本来就不带 trigger,不许抛", () => {
    expect(() =>
      s().applyEvent(malformed({
        type: "message_start", projectId: P, messageId: "m-bc", role: "assistant", agentId: BM,
        source: "broadcast",
      })),
    ).not.toThrow();
    expect(s().inFlight["m-bc"]?.origin).toEqual({ source: "broadcast" });
  });
});

// ── 刷新那条路:封套从库里回来(W3-① 的闭合判据)─────────────────────
//
// 这一组是**这次改动的验收判据**:REST 回填出来的轮,`origin` 必须**照抄**
// `SessionMessageView.origin`,与流式那条路同形。两组样本:
//
//   ① 带封套的行(migration 019 之后写的)⇒ 判据与流式**逐条一致**
//      ——「工件触发的业务经理回合」刷新后**不再**出现在对话页;
//   ② 不带封套的行(019 之前的存量行)⇒ `unknown` ⇒ 回退判据照旧。
describe("REST 回填:封套随行回来 ⇒ 刷新与流式同一条判据(W3-①)", () => {
  /** 把 `/projects/:id/messages` 的响应钉死,然后走一遍 `selectProject`。 */
  async function loadWithMessages(
    messages: Array<Record<string, unknown>>,
  ): Promise<Turn[]> {
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("/api", "");
      const body =
        path === `/projects/${P}/messages` ? { projectId: P, messages } : {};
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) };
    });
    try {
      await s().selectProject(P);
    } finally {
      vi.unstubAllGlobals();
    }
    return landed();
  }

  it("① **工件触发的业务经理回合刷新后不再出现** —— 缺口闭合的正样本", async () => {
    const turns = await loadWithMessages([
      {
        id: "h-bm-todo", projectId: P, agentId: BM, agentName: "业务经理",
        kind: "assistant", content: "工件触发的内部交代(不该给甲方看)", createdAt: 1,
        origin: { source: "turn", trigger: { kind: "todo" } },
      },
      {
        id: "h-bm-user", projectId: P, agentId: BM, agentName: "业务经理",
        kind: "assistant", content: "甲方亲口问的那一轮回答", createdAt: 2,
        origin: { source: "turn", trigger: { kind: "user" } },
      },
      {
        id: "h-bc", projectId: P, agentId: BM, agentName: "业务经理",
        kind: "assistant", content: "播报:第三条路线已交付", createdAt: 3,
        origin: { source: "broadcast" },
      },
      {
        id: "h-wk", projectId: P, agentId: WK, agentName: "工程师",
        kind: "assistant", content: "worker 的内部产出", createdAt: 4,
        origin: { source: "turn", trigger: { kind: "todo" } },
      },
    ]);

    // 判据**照抄**封套,不再有 `unknown` —— 这是本次改动的核心断言
    expect(turns.map((t) => t.origin)).toEqual([
      { source: "turn", trigger: { kind: "todo" } },
      { source: "turn", trigger: { kind: "user" } },
      { source: "broadcast" },
      { source: "turn", trigger: { kind: "todo" } },
    ]);

    const { timeline, hidden } = partitionTurns(turns, CTX);
    // 进甲方通道的只有三条:甲方触发的那一轮正文 + 播报(无条件)+ ... 见下
    // ⚠️ **`h-bm-todo` 不在里面** —— 这正是缺口存在时**会**出现的那一条。
    expect(timeline.map((x) => x.turn.id)).toEqual(["h-bm-user", "h-bc"]);
    expect(hidden).toBe(2); // h-bm-todo + h-wk
  });

  it("② **019 之前的存量行仍是 `unknown`** ⇒ 回退判据对旧数据继续有效", async () => {
    const turns = await loadWithMessages([
      {
        id: "h-bm", projectId: P, agentId: BM, agentName: "业务经理",
        kind: "assistant", content: "刷新后仍在", createdAt: 1,
        origin: { source: "unknown" },
      },
      {
        id: "h-wk", projectId: P, agentId: WK, agentName: "工程师",
        kind: "assistant", content: "worker 的产出", createdAt: 2,
        origin: { source: "unknown" },
      },
    ]);
    expect(turns.map((t) => t.origin)).toEqual([{ source: "unknown" }, { source: "unknown" }]);
    const { timeline, hidden } = partitionTurns(turns, CTX);
    // 回退判据认的是角色:业务经理(clientFacing)放行,worker 滤掉。
    // **这是旧数据的兜底** —— 它保住了「刷新之后与业务经理的对话还在」,
    // 代价是旧数据分不出「工件触发的那一轮」(那条信息当时根本没被记录)。
    expect(timeline.map((x) => x.turn.id)).toEqual(["h-bm"]);
    expect(hidden).toBe(1);
    expect(timeline[0]?.turn.origin).toEqual({ source: "unknown" });
  });
});
