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
 *   2. **两跳判据**:`agentId → MemberView.role → HarnessView.clientFacing`。
 *      pm / wk / qa 的角色 `clientFacing = false` ⇒ 不在对话页。
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
import type { MemberView, ProjectRole } from "@shared/types/platform";
import {
  channelContextOf,
  partitionTurns,
  type ChannelContext,
} from "@/lib/data";
import { ConversationStream, contentSignalOf } from "@/components/chat/MessageList";
import type { Turn } from "@/stores/chat";

function turn(
  id: string,
  role: Turn["role"],
  agentId: string | null,
  text: string,
): Turn {
  return { id, role, agentId, blocks: [{ kind: "text", text }], startedAt: 0 };
}

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

  it("业务经理说的留下(两跳:bm → business_manager → clientFacing)", () => {
    const { timeline, hidden } = partitionTurns([turn("m1", "assistant", "bm", "好的")], ctx());
    expect(timeline.map((x) => x.turn.id)).toEqual(["m1"]);
    expect(hidden).toBe(0);
  });

  it("其他三个角色全部滤掉,且**条数**如实报出", () => {
    const turns = [
      turn("m1", "assistant", "bm", "好的"),
      turn("m2", "assistant", "pm", "我拆成 3 个工作项"),
      turn("m3", "assistant", "wk", "第 1 项做完了"),
      turn("m4", "assistant", "qa", "审过了"),
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
    // 负样本:系统通知**不进**甲方通道,而是走独立的系统带
    const sysOnly = partitionTurns([sys], ctx());
    expect(sysOnly.timeline[0]?.channel).toBe("system");
    expect(sysOnly.hidden, "系统通知不该被当成内部角色而计入 hidden").toBe(0);
  });

  it("接待会话(没有项目 ⇒ 没有成员表)不误伤业务经理", () => {
    // 接待会话里成员表是空的 —— 那时**拿不到判据**,不该假装拿得到
    const r = partitionTurns([turn("m1", "assistant", "bm", "我们来对齐诉求")], ctx({ members: [], intake: true }));
    expect(r.timeline.map((x) => x.turn.id)).toEqual(["m1"]);
    expect(r.hidden).toBe(0);
  });

  it("项目里出现成员表之外的 agent → fail-closed(滤掉并计数),不塞进甲方通道", () => {
    const r = partitionTurns([turn("m9", "assistant", "ag_ghost", "我是谁")], ctx());
    expect(r.timeline).toEqual([]);
    expect(r.hidden).toBe(1);
  });
});

describe("A3 · 渲染:只有甲方与业务经理,系统通知走独立带", () => {
  it("pm/wk/qa 的正文一个都不上屏,条数提示在", () => {
    const all = [
      turn("u1", "user", null, "把登录做出来"),
      turn("m1", "assistant", "bm", "好的,我给你拆一下"),
      turn("m2", "assistant", "pm", "PM内部拆解内容"),
      turn("m3", "assistant", "qa", "QA内部结论"),
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

  it("系统通知渲染在 data-channel=system 的带里(不在任何气泡内)", () => {
    const all = [turn("u1", "user", null, "你好"), turn("s1", "system", null, "排空停在 max_rounds")];
    const part = partitionTurns(all, ctx());
    const html = renderToStaticMarkup(
      createElement(ConversationStream, { history: part.timeline, streaming: [], hiddenNote: null }),
    );
    const at = html.indexOf('data-channel="system"');
    expect(at, "系统带必须在 DOM 里").toBeGreaterThan(-1);
    // 正文出现在系统带**之后** ⇒ 它在那条带里,而不是被塞进了某个气泡
    expect(html.indexOf("排空停在 max_rounds")).toBeGreaterThan(at);
    // 负样本:它没有走助手气泡的那套样式
    expect(html).not.toContain("三生 · 推演中");
  });

  it("流式期间**两轮同时上屏**(A2 的接口被渲染层真的用上了)", () => {
    const streaming = [
      turn("msgA", "assistant", "bm", "AAA"),
      turn("msgB", "assistant", "bm", "播报"),
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
