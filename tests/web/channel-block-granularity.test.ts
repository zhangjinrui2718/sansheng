/**
 * 通道判据的**粒度**:按**轮**判通道、按**块**折内部过程(W2-④ 改写,2026-10-06)
 *
 * ── 这份文件的前身,与它为什么必须跟着改 ──────────────────────────
 *
 * 2026-10-05 这份文件钉的是**一个缺口**、不是一条设计:用户报告「这些对话过程不需要
 * 展示在和我对话的框里面」,他贴出的那串 `⚙ meeting_read → meeting_respond →
 * ask_client → blocker_read ×2 → project_read → tell_client → board_write` 全部是
 * 业务经理自己调的工具;而当时的 `channelOf` 只看**作者**(`agentId` → 角色
 * → `clientFacing`)⇒ 判成 client 之后**整轮所有块**一起进甲方时间线
 * (思考条 + 三张工具卡 + 正文)。文件头当时写明:
 *
 *   > 谁把粒度改细(按块 / 按工具 / 按回合触发来源),就必须同时改这份文件
 *
 * W2-④ 把粒度改细了,**两处**一起改:
 *
 *  ① **通道判据换成「这一轮为什么存在」**(`Turn.origin`):工件 / 待办触发的
 *     业务经理回合**整轮不进**(判据①)—— 它若真对甲方说了话,那话在
 *     `source: "broadcast"` 的播报里;
 *  ② **块级过滤**:用户触发那一轮仍然进,但 `thinking` / `tool` 折进一行
 *     「内部过程 N 步」(`layerBlocks` + `InternalProcessDisclosure`)。
 *
 * 数据层的这一半仍然是「**判据里没有块**」:块换成什么都不改变**通道**。块级过滤
 * 发生在**渲染层**(那是 `a4-worklog-thinking.test.ts` 与本文件的渲染段在管的),
 * 不在 `channelOf` 里 —— 把它塞进通道判据会让「这一轮属于谁」与「这一块给谁看」
 * 两个问题混成一个。
 *
 * 正负样本(本项目纪律):
 *   · 正样本 —— **用户触发**的业务经理轮(带工具卡)进 timeline,块原样留着;
 *   · 正样本 —— **待办触发**的业务经理轮(同样带工具卡)**整轮被滤掉**;
 *   · 正样本 —— worker 的轮(同样带工具卡)被滤掉;
 *   · 负样本 —— **把 blocks 换掉不改变通道**:判据里没有块的位置。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberView, ProjectRole, TriggerTodoKind } from "@shared/types/platform";
import { channelContextOf, channelOf, partitionTurns, type ChannelContext } from "@/lib/data";
import { InternalProcessDisclosure, layerBlocks, TurnView } from "@/components/chat/MessageList";
import type { Turn } from "@/stores/chat";

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

const CTX: ChannelContext = channelContextOf({
  members: MEMBERS,
  roles: ROLES,
  ready: true,
  intake: false,
});

const USER_TRIGGER: Turn["origin"] = { source: "turn", trigger: { kind: "user" } };
function todoOrigin(todoKind: TriggerTodoKind): Turn["origin"] {
  return { source: "turn", trigger: { kind: "todo", todoKind } };
}

/**
 * 一轮 = 思考块 + N 张工具卡 + 正文,与 `bridge()` 真实装配出的形状同形
 * (`host/serve.ts`:`tool_start` 带的是**本回合那个 messageId**,所以工具卡落进
 * 同一个 `Turn` 的 `blocks`;`thinking_delta` 同理)。
 */
function toolTurn(id: string, agentId: string, tools: readonly string[], origin: Turn["origin"]): Turn {
  return {
    id,
    projectId: "p-test",
    role: "assistant",
    agentId,
    blocks: [
      { kind: "thinking", text: "让我先看一下这个会议的详情" },
      ...tools.map((name, i) => ({
        kind: "tool" as const,
        tool: { id: `${id}-t${i}`, name },
      })),
      { kind: "text", text: "已处理:…" },
    ],
    startedAt: 0,
    origin,
  };
}

/** 用户真机上看到的那两轮(工具名逐字来自真转录)—— 那一轮是**用户触发**的。 */
const BM_TURN_1 = toolTurn("msg_bm_1", "bm", ["meeting_read", "meeting_respond", "ask_client"], USER_TRIGGER);
const BM_TURN_2 = toolTurn(
  "msg_bm_2",
  "bm",
  ["blocker_read", "blocker_read", "project_read", "tell_client", "board_write"],
  USER_TRIGGER,
);
/** **同一个业务经理**、被待办叫醒的一轮(工具名相同,触发来源不同)。 */
const BM_TURN_TODO = toolTurn(
  "msg_bm_todo",
  "bm",
  ["blocker_read", "project_read", "board_write"],
  // ⚠️ 样本用 `close_project`(2026-10-06 之前这里是 `report_downstream`):
  // `handover` / `report_downstream` / `resume_client` 三类的正文**现在自动进
  // 甲方通道**(`CLIENT_FACING_TODO_KINDS`),拿它们当「整轮不进」的样本就是假断言。
  // 这条用例验的是**内部**待办回合的块粒度,`close_project` 正是业务经理的
  // 内部判断(关掉不可逆 ⇒ 拿不准就别关,那句话是给他的)。
  todoOrigin("close_project"),
);
/** worker 的一轮(真转录 `2026-10-05T01-14-23-653Z_*.jsonl` 的同形)。 */
const WK_TURN = toolTurn("msg_wk_1", "wk", ["project_read", "blocker_open", "board_write"], todoOrigin("execute_work"));

describe("通道判据的粒度:按轮判通道,不按块判(判据里没有块)", () => {
  it("**用户触发**的业务经理轮(含 5 张工具卡)整轮进 timeline —— 数据层不预先丢块", () => {
    const { timeline, hidden } = partitionTurns([BM_TURN_1, BM_TURN_2], CTX);
    expect(hidden).toBe(0);
    expect(timeline.map((x) => x.turn.id)).toEqual(["msg_bm_1", "msg_bm_2"]);
    // ⚠️ 进 timeline 的那一轮,`blocks` 里**仍然**有工具卡与思考块 —— 这是**数据层**
    // 的事实,块级过滤在**渲染层**(下面「块级过滤」那一段),不在这里。把过滤塞进
    // `channelOf` 会让「这一轮属于谁」与「这一块给谁看」两个问题混成一个。
    const kinds = timeline[0]!.turn.blocks.map((b) => b.kind);
    expect(kinds).toEqual(["thinking", "tool", "tool", "tool", "text"]);
  });

  it("⚠️ **待办触发**的业务经理轮(同样带工具卡)**整轮不进** —— 作者不再救它", () => {
    const { timeline, hidden } = partitionTurns([BM_TURN_TODO], CTX);
    expect(timeline, "业务经理是 clientFacing,但这不是判据了").toEqual([]);
    expect(hidden).toBe(1);
    expect(channelOf(BM_TURN_TODO, CTX)).toBe("internal");
  });

  it("worker 的轮(同样含工具卡)整轮被滤掉 —— 落在 hidden 那一侧", () => {
    const { timeline, hidden } = partitionTurns([WK_TURN], CTX);
    expect(timeline).toEqual([]);
    expect(hidden).toBe(1);
    expect(channelOf(WK_TURN, CTX)).toBe("internal");
  });

  it("负样本:blocks 换成什么,都不改变通道 —— 判据里没有块", () => {
    const bare: Turn = { ...BM_TURN_2, blocks: [{ kind: "text", text: "只有正文" }] };
    const withTools = BM_TURN_2;
    expect(channelOf(withTools, CTX)).toBe(channelOf(bare, CTX));
    // 反向:同一个 agent 的轮不会因为「有工具卡」而降级成 internal。
    expect(channelOf(withTools, CTX)).toBe("client");
    // 且 `partitionTurns` 的计数只看轮数,不看块数。
    expect(partitionTurns([withTools], CTX).hidden).toBe(partitionTurns([bare], CTX).hidden);
    // 负样本的另一半:**待办**那一轮的通道也不受块影响(整轮被滤,与块无关)。
    const todoBare: Turn = { ...BM_TURN_TODO, blocks: [] };
    expect(channelOf(todoBare, CTX)).toBe(channelOf(BM_TURN_TODO, CTX));
  });
});

describe("块级过滤:思考与工具卡折成一行「内部过程 N 步」,可展开、不是删", () => {
  /** 那一轮里**真正被折起来**的块(思考 + 3 张工具卡)。 */
  const internal = layerBlocks(BM_TURN_1.blocks).internal;
  const REASONING = "让我先看一下这个会议的详情";

  it("数据层只分摞、不丢块:三摞合起来 === 原来的 blocks", () => {
    const { before, internal: folded, after } = layerBlocks(BM_TURN_1.blocks);
    expect([...before, ...folded, ...after]).toEqual(BM_TURN_1.blocks);
    expect(folded.map((b) => b.kind)).toEqual(["thinking", "tool", "tool", "tool"]);
    expect(after.map((b) => b.kind)).toEqual(["text"]);
  });

  it("默认折叠:折叠行在、推理正文与工具名都**不在**渲染产物里", () => {
    const html = renderToStaticMarkup(createElement(TurnView, { turn: BM_TURN_1 }));
    expect(html, "折叠行必须真的渲染出来").toContain('data-channel="internal-process"');
    expect(html).toContain("内部过程 4 步");
    expect(html).toContain('aria-expanded="false"');
    // 判据①的那三样:7594 字的思考条、三张工具卡 —— 一个都不在折叠态里
    expect(html).not.toContain(REASONING);
    expect(html).not.toContain("meeting_read");
    expect(html).not.toContain("ask_client");
    // 而正文照旧在(折叠的是内部过程,不是这一轮)
    expect(html).toContain("已处理:…");
  });

  it("**可展开**:展开后工具卡与思考块都回到 DOM(证据不是丢了)", () => {
    const html = renderToStaticMarkup(
      createElement(InternalProcessDisclosure, { blocks: internal, open: true, onToggle: () => {} }),
    );
    expect(html).toContain('aria-expanded="true"');
    // 工具卡原样交给 `ToolCallCard`(名字在折叠态看不到,展开就有)
    expect(html).toContain("meeting_read");
    expect(html).toContain("meeting_respond");
    expect(html).toContain("ask_client");
    // 思考块交给 `ThinkingBlock`:它自己**仍默认折叠**(§2.10.4 的裁决是
    // 「思考留,但默认折叠」)⇒ 展开「内部过程」不把 7594 字推理直接倒到屏幕上。
    expect(html).toContain("思考");
    expect(html).toContain('aria-expanded="false"');
    expect(html, "推理正文要再点一层(ThinkingBlock 那一层)才进 DOM").not.toContain(REASONING);
  });

  it("折叠行落在**第一个内部块**原来的位置(先想、再做、最后说)", () => {
    const mixed: Turn = {
      ...BM_TURN_1,
      blocks: [
        { kind: "text", text: "先说一句" },
        { kind: "tool", tool: { id: "t1", name: "meeting_read" } },
        { kind: "text", text: "接着说" },
      ],
    };
    const html = renderToStaticMarkup(createElement(TurnView, { turn: mixed }));
    const first = html.indexOf("先说一句");
    const fold = html.indexOf('data-channel="internal-process"');
    const last = html.indexOf("接着说");
    expect(first).toBeGreaterThan(-1);
    expect(fold).toBeGreaterThan(first);
    expect(last).toBeGreaterThan(fold);
    // 只有**一行**折叠行(按连续段切会在这种形状里产生两条,屏幕上更吵)
    expect(html.match(/data-channel="internal-process"/g)?.length).toBe(1);
  });
});
