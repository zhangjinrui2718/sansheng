/**
 * A3 · **通道分离**:对话页 = 甲方 ↔ 业务经理(设计 1 §2.10 / §2.12 的 A3)
 *
 * 本文件钉三件事,每件都有**正负样本**(本项目纪律:一个必须命中的正样本 + 一个
 * 必须不命中的负样本,两个都对上才说明判据没坏):
 *
 *   1. **`agentId === null` 不等于「甲方」** —— `session_messages.agent_id` 的 null
 *      有两个作者:`kind='user'`(甲方)与 `kind='system'`(平台通知,
 *      `host/serve.ts` 的 `announceDrain`)。只看 `agentId` 会把平台通知当成甲方说的话
 *      (A1 在真机上实测到的坑)。
 *   2. **通道判据**:W2-④ 起主判据是「**这一轮为什么存在 / 这个封套是谁发的**」
 *      (`Turn.origin`),不是角色的 `clientFacing`:
 *        甲方消息(`agentId === null`)∪ `source:"broadcast"` 的播报
 *        ∪ `trigger.kind === "user"` 的回合正文 ⇒ 进;其余一律不进。
 *      ⚠️ **两跳(`agentId → role → clientFacing`)没有消失,它降级成了
 *      `origin === unknown` 那一支的回退** —— 而 `unknown` 今天等于
 *      **「刷新之后从 REST 回填回来的全部历史」**(`messageToTurn`),所以这条
 *      回退是**线上主路径的一半**,下面有专门的样本。
 *   3. **滤掉的条数必须显示出来**(§2.10.4:看不到就等于平台替甲方删了证据)。
 *
 * ── 为什么直测纯函数 + 一个纯组件 ──────────────────────────────────
 *
 * `MessageList` 从 zustand 取数,而 SSR 下 store 读的是 server snapshot
 * (`setState` 驱动不了,见 `tests/web/message-list.test.ts` 文件头的实测记录)——
 * 所以判据抽成 `lib/data.ts` 的纯函数,渲染抽成 `ConversationStream`(纯 props)。
 * 两者合起来覆盖的正是「哪一轮进哪条通道、渲染成什么样」。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberView, ProjectRole, TriggerTodoKind } from "@shared/types/platform";
import {
  channelContextOf,
  channelNoteText,
  partitionTurns,
  type ChannelContext,
} from "@/lib/data";
import { ConversationStream, contentSignalOf } from "@/components/chat/MessageList";
import type { Turn } from "@/stores/chat";

/**
 * 手搓的轮:`Turn` 的必填字段一个都不能少。
 *
 * ⚠️ `tests/` **不在** `tsconfig.web.json` / `tsconfig.server.json` 的 `include`
 * 里,所以漏填不会被 tsc 抓住 —— 这条注释是替补的守卫:`projectId` 漏成
 * `undefined` 时,这一轮在任何 `agent_end` 下都收不了口(`undefined !== null`,
 * 而 `delta` 只认 `messageId`)。所以这里如实给一个项目 id。
 *
 * ⚠️ **W2-④ 起 `origin` 也是必填**(`TurnOrigin`)。默认给
 * `{source:"turn", trigger:{kind:"user"}}`(「用户触发的那一轮」)—— 它是甲方
 * 通道三支里最常被手搓的;需要**内部轮**或 **unknown 轮**的样本显式传第二参,
 * 否则这条文件会退化成「一律按 user 判」,把新判据测没了。
 */
function turn(
  id: string,
  role: Turn["role"],
  agentId: string | null,
  text: string,
  origin: Turn["origin"] = { source: "turn", trigger: { kind: "user" } },
): Turn {
  return {
    id, projectId: "p-test", role, agentId,
    blocks: [{ kind: "text", text }],
    startedAt: 0,
    origin,
  };
}

/** 排空器按**待办**叫醒的一轮(`trigger.kind === "todo"`)—— 不进甲方通道。 */
function todoOrigin(todoKind: TriggerTodoKind): Turn["origin"] {
  // 取值域是闭合集(`TriggerTodoKind`,与 `runtime/dispatcher.ts` 的 `TodoKind`
  // 有编译期对账)—— 这里照抄契约的联合类型,不自己编一个字符串表。
  return { source: "turn", trigger: { kind: "todo", todoKind } };
}

/** 封套**没到**的一轮(只有 REST 回填 / `tool_start` 抢先建轮会产生)。 */
const UNKNOWN: Turn["origin"] = { source: "unknown" };

/** 真机库的四个 agent(见 `runtime/org.ts` 的 ORG)。 */
const MEMBERS: MemberView[] = [
  { id: "bm", role: "business_manager", displayName: "业务经理", specialization: null },
  { id: "pm", role: "project_manager", displayName: "项目经理", specialization: null },
  { id: "wk", role: "worker", displayName: "工程师", specialization: "engineering" },
  { id: "qa", role: "quality_reviewer", displayName: "质检", specialization: null },
];

/** 与 `ROLE_SPECS` 同形:`clientFacing` 只有业务经理为 true(代码内常量)。 */
const ROLES: Array<{ role: ProjectRole; clientFacing: boolean }> = [
  { role: "business_manager", clientFacing: true },
  { role: "project_manager", clientFacing: false },
  { role: "worker", clientFacing: false },
  { role: "quality_reviewer", clientFacing: false },
];

function ctx(over?: Partial<{ members: MemberView[]; roles: typeof ROLES; ready: boolean; intake: boolean }>): ChannelContext {
  return channelContextOf({
    members: over?.members ?? MEMBERS,
    roles: over?.roles ?? ROLES,
    ready: over?.ready ?? true,
    intake: over?.intake ?? false,
  });
}

describe("A3 · 对话页的通道判据", () => {
  it("甲方说的(kind=user, agentId=null)留下", () => {
    const { timeline, hidden } = partitionTurns([turn("u1", "user", null, "把登录做出来")], ctx());
    expect(timeline.map((x) => x.turn.id)).toEqual(["u1"]);
    expect(timeline[0]?.channel).toBe("client");
    expect(hidden).toBe(0);
  });

  it('**用户触发**的那一轮留下(判据是 `trigger.kind === "user"`,不是角色)', () => {
    const { timeline, hidden } = partitionTurns([turn("m1", "assistant", "bm", "好的")], ctx());
    expect(timeline.map((x) => x.turn.id)).toEqual(["m1"]);
    expect(hidden).toBe(0);
  });

  // ── W2-④ 的**核心转向**:同一个作者(bm),换成待办触发 ⇒ 不进 ──────────
  it("⚠️ **同一个业务经理**,被工件 / 待办叫醒的那一轮**不进**甲方通道", () => {
    const todo = turn("m-todo", "assistant", "bm", "下游有结果,我记一下", todoOrigin("report_downstream"));
    const { timeline, hidden } = partitionTurns([todo], ctx());
    expect(timeline, "作者是 clientFacing 也不再是判据").toEqual([]);
    expect(hidden).toBe(1);
  });

  it("播报封套(`source:\"broadcast\"`)**无条件**进 —— 即使它是工件触发那轮里发生的事", () => {
    // 同一条时间线上:工件触发的业务经理回合(不进)+ 它同轮的播报(进)
    const todo = turn("m-todo", "assistant", "bm", "内部交代", todoOrigin("report_downstream"));
    const broadcast: Turn = { ...turn("m-bc", "assistant", "bm", "对甲方说的话"), origin: { source: "broadcast" } };
    const { timeline, hidden } = partitionTurns([todo, broadcast], ctx());
    expect(timeline.map((x) => x.turn.id)).toEqual(["m-bc"]);
    expect(hidden).toBe(1);
  });

  it("其他三个角色(待办触发的回合)全部滤掉,且**条数**如实报出", () => {
    const turns = [
      turn("m1", "assistant", "bm", "好的"),
      turn("m2", "assistant", "pm", "我拆成 3 个工作项", todoOrigin("decompose_project")),
      turn("m3", "assistant", "wk", "第 1 项做完了", todoOrigin("execute_work")),
      turn("m4", "assistant", "qa", "审过了", todoOrigin("review_work")),
    ];
    const { timeline, hidden } = partitionTurns(turns, ctx());
    expect(timeline.map((x) => x.turn.id)).toEqual(["m1"]);
    expect(hidden, "pm/wk/qa 三条被滤掉").toBe(3);
  });

  // ── 这一条是本批次最容易写错的地方(A1 真机实测)───────────────
  it("⚠️ 系统通知(agentId=null + kind=system)**不是**甲方说的话", () => {
    const user = turn("u1", "user", null, "你好");
    const sys = turn("s1", "system", null, "排空在 max_rounds 处停下(8 回合)");

    // 正样本:同样是 agentId=null,甲方那条进甲方面
    expect(partitionTurns([user], ctx()).timeline[0]?.channel).toBe("client");
    // 负样本:系统通知**不进**甲方通道(2026-10-05 起也不进这条时间线 —— 全文与状态
    // 在「项目」页的「组织运行态」,这里只留条数;见 `notices` 与 `channelNoteText`)
    const sysOnly = partitionTurns([sys], ctx());
    expect(sysOnly.timeline, "平台通知不冒充甲方,也不在这页出现").toEqual([]);
    expect(sysOnly.notices).toBe(1);
    expect(sysOnly.hidden, "系统通知不该被当成内部角色而计入 hidden").toBe(0);
  });

  it("接待会话(没有项目 ⇒ 没有成员表)不误伤业务经理(走 unknown 回退那一支)", () => {
    // 接待会话里成员表是空的 —— 那时**拿不到两跳判据**,不该假装拿得到。
    // 这里显式用 UNKNOWN:带 trigger 的轮在接待会话里由第 2/4 支判,与成员表无关。
    const r = partitionTurns(
      [turn("m1", "assistant", "bm", "我们来对齐诉求", UNKNOWN)],
      ctx({ members: [], intake: true }),
    );
    expect(r.timeline.map((x) => x.turn.id)).toEqual(["m1"]);
    expect(r.hidden).toBe(0);
  });

  // ── W2-④:unknown 那一支的回退(它今天是「刷新后的全部历史」)─────────
  it("**unknown 轮**:成员表之外的 agent → fail-closed(滤掉并计数),不塞进甲方通道", () => {
    const r = partitionTurns([turn("m9", "assistant", "ag_ghost", "我是谁", UNKNOWN)], ctx());
    expect(r.timeline).toEqual([]);
    expect(r.hidden).toBe(1);
  });

  it("**unknown 轮**:成员表里认得的业务经理 → 仍按两跳回退进甲方通道(刷新后对话不该消失)", () => {
    // 这是「刷新一次与业务经理的整段对话就没了」那条缺口的回归守卫:
    // REST 回填出来的轮**永远**是 unknown(`SessionMessageView` 上没有
    // source / trigger),所以这一支必须把 bm 放行。
    const r = partitionTurns([turn("m-hist", "assistant", "bm", "刷新后仍在", UNKNOWN)], ctx());
    expect(r.timeline.map((x) => x.turn.id)).toEqual(["m-hist"]);
    expect(r.hidden).toBe(0);
  });

  it("**unknown 轮**:接待会话没有成员表 ⇒ 按 A3 的原规则放行", () => {
    const r = partitionTurns(
      [turn("m-intake", "assistant", "bm", "我们来对齐诉求", UNKNOWN)],
      ctx({ members: [], intake: true }),
    );
    expect(r.timeline.map((x) => x.turn.id)).toEqual(["m-intake"]);
    expect(r.hidden).toBe(0);
  });
});

describe("A3 · 渲染:只有甲方与业务经理,系统通知走独立带", () => {
  it("pm/wk/qa 的正文一个都不上屏,条数提示在", () => {
    const all = [
      turn("u1", "user", null, "把登录做出来"),
      turn("m1", "assistant", "bm", "好的,我给你拆一下"),
      turn("m2", "assistant", "pm", "PM内部拆解内容", todoOrigin("decompose_project")),
      turn("m3", "assistant", "qa", "QA内部结论", todoOrigin("review_work")),
    ];
    const part = partitionTurns(all, ctx());
    const html = renderToStaticMarkup(
      createElement(ConversationStream, {
        history: part.timeline,
        streaming: [],
        hiddenNote: part.hidden > 0 ? `另有 ${part.hidden} 条发言不在这条通道里` : null,
      }),
    );
    expect(html).toContain("把登录做出来");
    expect(html).toContain("好的,我给你拆一下");
    expect(html).not.toContain("PM内部拆解内容");
    expect(html).not.toContain("QA内部结论");
    expect(html).toContain("另有 2 条发言不在这条通道里");
  });

  it("**平台通知不进对话页**(2026-10-05):正文与它那条带都不在 DOM 里,条数在", () => {
    const all = [turn("u1", "user", null, "你好"), turn("s1", "system", null, "排空停在 max_rounds")];
    const part = partitionTurns(all, ctx());
    const note = channelNoteText({
      hidden: part.hidden,
      notices: part.notices,
      ready: true,
      harnessError: null,
    });
    const html = renderToStaticMarkup(
      createElement(ConversationStream, { history: part.timeline, streaming: [], hiddenNote: note }),
    );
    // 正样本:甲方那句话照旧上屏
    expect(html).toContain("你好");
    // 负样本:平台通知**一个字都不在这页**(既不是气泡,也不再是一条「系统带」)
    expect(html).not.toContain("排空停在 max_rounds");
    expect(html).not.toContain('data-channel="system"');
    // 但它**不是静默丢**:条数与去向必须写在屏幕上
    expect(html).toContain("1 条平台通知");
    expect(html).toContain("「项目」页「组织运行态」");
  });

  // ── 那一行提示的**文案**是纯函数产出的:判据在这里,不靠肉眼 ────────
  describe("channelNoteText · 「不在这条通道里的东西」怎么报出来", () => {
    it("负样本:什么都没滤掉 ⇒ null(不摆 0 占位)", () => {
      expect(channelNoteText({ hidden: 0, notices: 0, ready: true, harnessError: null })).toBeNull();
    });

    it("两类并存时**两段都在**,各自给落点", () => {
      const t = channelNoteText({ hidden: 2, notices: 1, ready: true, harnessError: null })!;
      expect(t).toContain("2 条回合不在这条通道里");
      expect(t).toContain("「成员」页");
      expect(t).toContain("1 条平台通知");
      expect(t).toContain("「项目」页「组织运行态」");
    });

    it("只有平台通知时也报出来(它不是静默丢弃,只是搬到项目页)", () => {
      const t = channelNoteText({ hidden: 0, notices: 3, ready: true, harnessError: null })!;
      expect(t).toContain("3 条平台通知");
      expect(t).not.toContain("「成员」页");
    });

    it("⚠️ 能力面还没读到 ⇒ 内部回合那一半**不许**按「不是由你触发」解释(读不到 ≠ 空闲)", () => {
      const t = channelNoteText({ hidden: 4, notices: 0, ready: false, harnessError: "boom" })!;
      expect(t).toContain("暂时无法归类");
      expect(t).toContain("boom");
      expect(t).not.toContain("不是由你触发");
    });
  });

  it("流式期间**两轮同时上屏**(A2 的接口被渲染层真的用上了)", () => {
    const streaming = [
      turn("msgA", "assistant", "bm", "AAA"),
      // 真实形状:msgB 就是 `tell_client` 的播报 ⇒ `source: "broadcast"`
      { ...turn("msgB", "assistant", "bm", "播报"), origin: { source: "broadcast" } },
    ];
    const part = partitionTurns(streaming, ctx());
    const html = renderToStaticMarkup(
      createElement(ConversationStream, { history: [], streaming: part.timeline, hiddenNote: null }),
    );
    expect(html).toContain("AAA");
    expect(html).toContain("播报");
  });
});

describe("A3 · 滚动信号必须吃列表(A2 留的第二处)", () => {
  it("第二轮在流式时,它的 delta 会改变信号", () => {
    const t1 = turn("msgA", "assistant", "bm", "AAA");
    const t2 = turn("msgB", "assistant", "bm", "播报");
    const before = contentSignalOf([], [t1, t2]);
    const after = contentSignalOf([], [t1, { ...t2, blocks: [{ kind: "text", text: "播报+1" }] }]);
    expect(after, "第二轮打字必须让信号变化,否则自动跟随会漏掉它").not.toBe(before);
    // 正负样本:两轮 vs 一轮的信号也不同(新轮出现同样要触发跟随)
    expect(contentSignalOf([], [t1])).not.toBe(before);
  });
});
