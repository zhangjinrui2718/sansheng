/**
 * 成员屏的**按时态分栏 + 「正在做什么」**(2026-10-06)—— 可读性与「现在」的判据
 *
 * ── 为什么要这份测试 ────────────────────────────────────────────
 *
 * 改的是两件最容易**悄悄退回去**的事:
 *
 *   ① **摆放** —— 上一版四份内容同时铺开(成员 KV + 4 个人的对话卡 +
 *      4 个角色的能力面)。没有断言的话,下次有人把 `MemberPane` 换回
 *      「所有成员 inline」也不会有任何东西红,而页面上看起来只是「又变长了」。
 *   ② **时态与「不知道」** —— 用户的原话是「我担心系统已经挂了,而实际还在运行」。
 *      这一版给了三种状态:**在跑** / **此刻没有回合在跑**(host 快照说的)/
 *      **读不到**(unavailable)/ **还不知道**(还没拿到快照)。它们**看起来必须不一样**,
 *      而退化的方向永远是「都长得像一切正常」。所以负样本写得比正样本硬。
 *
 * 组件是纯 props 的(`MemberRoleTabs` / `MemberPane`),与 `HarnessRolePane`
 * / `ConversationCard` / `TurnView` 同一处置 —— 导出给测试,不起服务、不 stub fetch。
 *
 * ── 一个渲染细节(写断言时必须知道)────────────────────────────
 *
 * `renderToStaticMarkup` 会在**相邻文本节点**之间插 `<!-- -->`
 * (例如 `已叫醒 {2}/{3} 次` → `已叫醒 <!-- -->2<!-- -->/<!-- -->3<!-- --> 次`)。
 * 所以断言**正文**一律先过 `visible()`(它同时剥掉标签里的属性 —— 页面上故意
 * 把判断依据写进了 `title=`,那是用户看不见的字,不能算进正文);
 * 断言**属性**(`data-tone` / `data-state` / `aria-selected`)才用原始 html。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ArtifactView,
  MemberActivityView,
  MemberConversationView,
  MemberView,
  ProjectLiveView,
  ProjectRole,
  RoleHarnessView,
  SessionMessageView,
} from "@shared/types/platform";
import {
  MemberPane,
  MemberRoleTabs,
  debtFacts,
  elapsedSinceFetch,
  formatAge,
  memberDebt,
} from "@/routes/Members";

/**
 * 只留**可见正文**:去掉标签(属性跟在里面一起走)与 SSR 插的 `<!-- -->`。
 *
 * ⚠️ 为什么必须去掉属性,而不是直接在原始 html 上断言「不许出现某句话」——
 * 这一版页面上**故意**把「读不到不等于空闲」「预算用尽不再叫醒 N 件」这类
 * 判断依据写进了 `title=`。直接在 html 上断言会被自己的说明文字打红,
 * 而那种红是假故障(判据写错方向:用户**看不见** title 里的字)。
 * 所以负样本一律断在**可见正文**上,正样本也是 —— 两边口径一致。
 */
const visible = (html: string): string =>
  html
    .replace(/ title="[^"]*"/g, "")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]*>/g, "");

// ── 夹具 ────────────────────────────────────────────────────────

const BM_ID = "agent-bm";
const WK_ID = "agent-wk";

const BM: MemberView = {
  id: BM_ID,
  role: "business_manager",
  displayName: "业务经理",
  specialization: null,
};

const WK: MemberView = {
  id: WK_ID,
  role: "worker",
  displayName: "工程师",
  specialization: "engineering",
};

/** 业务经理**独有**的三样东西 —— 负样本就靠它们(传 worker 时一个都不许出现)。 */
const BM_TODO_LABEL = "把这一批下游结果合并成一次汇报";
const BM_ARTIFACT_TITLE = "甲方交付验收报告";
const BM_MSG_EXCERPT = "我已经把本轮结论汇报给甲方";

/** 工程师自己的三样(正样本)。 */
const WK_TODO_LABEL = "执行工作项:把导出接口写完";
const WK_ARTIFACT_TITLE = "导出接口的实现说明";
const WK_MSG_EXCERPT = "我把导出接口写完";

const msg = (id: string, agentId: string, kind: SessionMessageView["kind"], content: string): SessionMessageView => ({
  id,
  projectId: "p1",
  agentId,
  agentName: null,
  kind,
  content,
  createdAt: 1_700_000_000_000,
  origin: { source: "turn", trigger: { kind: "todo" } },
});

function conversation(
  agentId: string | null,
  over: Partial<MemberConversationView> = {},
): MemberConversationView {
  return {
    agentId,
    agentName: null,
    role: null,
    total: 0,
    byKind: {},
    messages: [],
    truncated: false,
    ...over,
  };
}

const WK_CONVERSATION = conversation(WK_ID, {
  total: 2,
  byKind: { assistant: 2 },
  messages: [msg("m2", WK_ID, "assistant", WK_MSG_EXCERPT), msg("m1", WK_ID, "assistant", "先看现有接口")],
});

const BM_CONVERSATION = conversation(BM_ID, {
  total: 1,
  byKind: { assistant: 1 },
  messages: [msg("m3", BM_ID, "assistant", BM_MSG_EXCERPT)],
});

function artifact(id: string, over: Partial<ArtifactView> = {}): ArtifactView {
  return {
    id,
    projectId: "p1",
    kind: "evidence",
    status: "open",
    title: `工件 ${id}`,
    body: "",
    authorAgentId: WK_ID,
    authorName: "工程师",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    links: [],
    workId: null,
    ...over,
  };
}

const WK_ARTIFACTS: ArtifactView[] = [
  artifact("a1", { title: WK_ARTIFACT_TITLE }),
  artifact("a2", { title: "接口压测结果", kind: "note", status: "accepted" }),
];

const BM_ARTIFACTS: ArtifactView[] = [artifact("b1", { title: BM_ARTIFACT_TITLE, authorAgentId: BM_ID })];

function harnessRole(
  role: ProjectRole,
  displayName: string,
  over: Partial<RoleHarnessView> = {},
): RoleHarnessView {
  return {
    role,
    displayName,
    clientFacing: role === "business_manager",
    ceiling: ["board_list", "board_read"],
    writeKinds: [],
    boundaryDeny: [],
    promptUnits: [],
    tools: ["board_list"],
    toolsSolved: true,
    blockedByCeiling: [],
    unknownTools: [],
    toolSet: {
      path: `/data/harness/tools/${role}.json`,
      state: "absent",
      allow: [],
      deny: [],
      removedByToolSet: [],
    },
    ...over,
  };
}

const WK_ROLE = harnessRole("worker", "工程师");

/** 只有一份快照能给的东西:`runtime` 与排空器心跳。 */
const DISPATCH: ProjectLiveView["dispatch"] = {
  intervalMs: 10_000,
  lastRunAgeMs: 4_000,
  draining: false,
};

function activity(agentId: string, over: Partial<MemberActivityView> = {}): MemberActivityView {
  return {
    agentId,
    turn: null,
    currentWorks: [],
    readyWorks: 0,
    waitingWorks: 0,
    todos: [],
    exhaustedTodos: 0,
    lastMessage: null,
    ...over,
  };
}

/** 工程师那一份「正在做什么」:有回合在跑、手上有活、排空器有两条待办。 */
const WK_ACTIVITY = activity(WK_ID, {
  turn: { elapsedMs: 65_000, trigger: { kind: "todo", todoKind: "execute_work" } },
  currentWorks: [{ id: "w1", title: "把导出接口写完", status: "in_progress", ageMs: 120_000 }],
  readyWorks: 2,
  todos: [{ kind: "review_work", label: WK_TODO_LABEL, attempts: 2, maxAttempts: 3, target: "w9" }],
  lastMessage: { kind: "assistant", excerpt: WK_MSG_EXCERPT, ageMs: 5_000 },
});

/** 业务经理那一份 —— 只在「传谁就渲染谁」的负样本里用到。 */
const BM_ACTIVITY = activity(BM_ID, {
  readyWorks: 1,
  todos: [{ kind: "report_downstream", label: BM_TODO_LABEL, attempts: 0, maxAttempts: 3, target: null }],
});

const renderPane = (over: {
  member: MemberView;
  activity: MemberActivityView | null;
  conversation: MemberConversationView | null;
  harnessRole: RoleHarnessView | null;
  artifacts: readonly ArtifactView[];
  runtime: ProjectLiveView["runtime"] | null;
  dispatch: ProjectLiveView["dispatch"] | null;
  fetchedAt: number | null;
  now: number;
}) => renderToStaticMarkup(createElement(MemberPane, over));

/** 最常用的那一次渲染:host 快照、无本地漂移(fetchedAt === now)。 */
const renderWorker = (over: Partial<Parameters<typeof renderPane>[0]> = {}) =>
  renderPane({
    member: WK,
    activity: WK_ACTIVITY,
    conversation: WK_CONVERSATION,
    harnessRole: WK_ROLE,
    artifacts: WK_ARTIFACTS,
    runtime: "host",
    dispatch: DISPATCH,
    fetchedAt: 1_000,
    now: 1_000,
    ...over,
  });

// ── 判据 1:一次只渲染一个成员 ──────────────────────────────────

describe("① 一次只渲染一个成员(这一版要修的正是「四个人的内容同时铺开」)", () => {
  it("传工程师 ⇒ 业务经理**独有**的内容一个都不许出现(负样本)", () => {
    const text = visible(renderWorker({ activity: WK_ACTIVITY }));
    expect(text, "工程师面板里出现了业务经理的显示名").not.toContain("业务经理");
    expect(text, "出现了业务经理独有的待办").not.toContain(BM_TODO_LABEL);
    expect(text, "出现了业务经理独有的工件").not.toContain(BM_ARTIFACT_TITLE);
    expect(text, "出现了业务经理独有的发言").not.toContain(BM_MSG_EXCERPT);

    // 正样本:工程师自己的三样都在(证明上面的负样本不是「整页啥都没渲染」)
    expect(text, "角色名(与 harness 页同一个词)").toContain("工程师");
    expect(text).toContain(WK_TODO_LABEL);
    expect(text).toContain(WK_ARTIFACT_TITLE);
    expect(text).toContain(WK_MSG_EXCERPT);
  });

  it("传业务经理 ⇒ 工程师独有的内容不许出现(反方向)", () => {
    const text = visible(
      renderPane({
        member: BM,
        activity: BM_ACTIVITY,
        conversation: BM_CONVERSATION,
        harnessRole: harnessRole("business_manager", "业务经理"),
        artifacts: BM_ARTIFACTS,
        runtime: "host",
        dispatch: DISPATCH,
        fetchedAt: 1_000,
        now: 1_000,
      }),
    );
    expect(text).not.toContain(WK_TODO_LABEL);
    expect(text).not.toContain(WK_ARTIFACT_TITLE);
    expect(text).not.toContain(WK_MSG_EXCERPT);
    expect(text).toContain(BM_TODO_LABEL);
    expect(text).toContain(BM_ARTIFACT_TITLE);
  });

  it("页签:每个成员一个 tab,只有选中的那个 aria-selected=true", () => {
    const html = renderToStaticMarkup(
      createElement(MemberRoleTabs, {
        members: [BM, WK],
        active: WK_ID,
        onSelect: vi.fn(),
        activityOf: (id: string) => (id === WK_ID ? WK_ACTIVITY : BM_ACTIVITY),
        runtime: "host",
      }),
    );
    expect((html.match(/role="tab"/g) ?? []).length, "两个成员 ⇒ 两个 tab").toBe(2);
    expect((html.match(/aria-selected="true"/g) ?? []).length, "只有一个选中").toBe(1);
    const text = visible(html);
    expect(text).toContain("业务经理");
    expect(text).toContain("工程师");
    // ⚠️ 页签上**只有角色名**(2026-10-06):以前页签是「人 + 角色 Pill」两段,
    // 而在「一人一角色」的组织里那两个词一模一样 ⇒ 屏幕上成了「工程师 执行者」。
    // 现在主体就是角色名(与 harness 页逐字相同),人的名字进 tooltip。
    expect(text, "角色名只出现一次语义,不再有第二个说法").not.toContain("执行者");
    expect(text).not.toContain("质检审查员");
  });

  it("面板里的折叠块默认都不展开(否则一屏又被消息与常量刷满)", () => {
    const html = renderWorker();
    expect((html.match(/<details/g) ?? []).length, "折叠块存在(details 渲染出来了)").toBeGreaterThan(0);
    expect(/<details[^>]*\sopen/.test(html), "有 details 是展开的 —— 默认折叠的承诺破了").toBe(false);
  });
});

// ── 判据 2:「正在做什么」真的显示出来 ────────────────────────────

describe("② 「正在做什么」:在跑的回合 / 手里的活 / 排空器的待办", () => {
  it("有在跑的回合 ⇒ 「已跑 <年龄>」+ 为什么在跑", () => {
    const text = visible(renderWorker());
    expect(text).toContain("在跑 · 已跑 1分5s");
    expect(text).toContain("排空器按待办叫醒");
    expect(text).toContain("执行工作项"); // todoKind 的中文读法
  });

  it("trigger 是 user ⇒ 「你亲口发起」", () => {
    const text = visible(
      renderWorker({ activity: activity(WK_ID, { turn: { elapsedMs: 12_000, trigger: { kind: "user" } } }) }),
    );
    expect(text).toContain("在跑 · 已跑 12s");
    expect(text).toContain("你亲口发起");
    expect(text).not.toContain("排空器按待办叫醒");
  });

  it("currentWorks ⇒ 状态 Pill(中文)+ 标题 + 「更新于 <年龄>」", () => {
    const text = visible(renderWorker());
    expect(text).toContain("进行中"); // workStatusLabel('in_progress')
    expect(text).toContain("把导出接口写完");
    expect(text).toContain("更新于 2分0s"); // 120_000ms
  });

  it("blocked 的活也在这一块里,而且状态是红的那个词", () => {
    const text = visible(
      renderWorker({
        activity: activity(WK_ID, {
          currentWorks: [{ id: "w2", title: "等甲方定接口字段", status: "blocked", ageMs: 3_000 }],
        }),
      }),
    );
    expect(text).toContain("被卡住");
    expect(text).toContain("等甲方定接口字段");
  });

  it("todos ⇒ label + 「已叫醒 attempts/maxAttempts 次」", () => {
    const text = visible(renderWorker());
    expect(text).toContain(WK_TODO_LABEL);
    expect(text).toContain("已叫醒 2/3 次");
  });

  it("排空器心跳(项目级):周期 + 上一次 + draining 时的那句话", () => {
    const text = visible(renderWorker());
    expect(text).toContain("平台兜底每 10s 查一次");
    expect(text).toContain("上一次 4s");
    expect(text).not.toContain("正在排空这个项目");

    const draining = visible(
      renderWorker({ dispatch: { intervalMs: 10_000, lastRunAgeMs: 4_000, draining: true } }),
    );
    expect(draining).toContain("正在排空这个项目");
  });

  it("host 快照 + lastRunAgeMs=null ⇒ 「本进程还没跑过兜底检查」(不是「没在跑」)", () => {
    const text = visible(
      renderWorker({ dispatch: { intervalMs: 10_000, lastRunAgeMs: null, draining: false } }),
    );
    expect(text).toContain("本进程还没跑过兜底检查");
    expect(text).not.toContain("空闲");
  });

  it("最近的落库痕迹:「最后一次动:<kind 中文> <摘要> · <年龄>」", () => {
    const text = visible(renderWorker());
    expect(text).toContain("最后一次动:");
    expect(text).toContain("发言"); // KIND_LABEL.assistant
    expect(text).toContain(WK_MSG_EXCERPT);
  });

  it("host 快照 + turn=null ⇒ **才**允许说「此刻没有回合在跑」", () => {
    const text = visible(renderWorker({ activity: activity(WK_ID, { readyWorks: 1 }) }));
    expect(text).toContain("此刻没有回合在跑");
    expect(text).not.toContain("已跑");
    expect(text).not.toContain("运行态读不到");
  });

  it("待办为空且预算没用尽 ⇒ 「排空器现在没有该它跑的待办」(真的有快照才敢说)", () => {
    const text = visible(renderWorker({ activity: activity(WK_ID, { readyWorks: 0 }) }));
    expect(text).toContain("排空器现在没有该它跑的待办");
  });

  it("待办为空但预算已用尽 ⇒ 说清「不会再被叫醒」,不许静默留空", () => {
    const text = visible(renderWorker({ activity: activity(WK_ID, { readyWorks: 1, exhaustedTodos: 2 }) }));
    expect(text).toContain("预算用尽不再叫醒 2 件");
    expect(text).toContain("不会再被叫醒");
  });
});

// ── 判据 3:unavailable ≠ 空闲(这次改造的核心判据)────────────────

describe("③ runtime=unavailable 是「读不到」,不是「空闲」", () => {
  const unavailable = (over: Partial<Parameters<typeof renderPane>[0]> = {}) =>
    renderWorker({
      runtime: "unavailable",
      dispatch: { intervalMs: 10_000, lastRunAgeMs: null, draining: false },
      ...over,
    });

  it("出现「读不到」,并且**不许**出现「空闲」/「没有在跑」/「此刻没有回合在跑」", () => {
    const html = unavailable({ activity: activity(WK_ID, { currentWorks: WK_ACTIVITY.currentWorks }) });
    const text = visible(html);
    expect(text).toContain("运行态读不到");
    expect(text, "把「读不到」说成了空闲").not.toContain("空闲");
    expect(text, "把「读不到」说成了没在跑").not.toContain("没有在跑");
    expect(text, "把「读不到」说成了没有回合在跑").not.toContain("此刻没有回合在跑");
    expect(text, "把「读不到」说成了已跑多久").not.toContain("已跑");
    // 灰点(不动、不上色)—— 「读不到」不能只有一个绿点或什么都没有
    expect(html).toContain('data-state="unknown"');

    // 硬版本:连**原始标记**里都不许出现这两个词。页面刻意把判断依据写进
    // `title=`,所以「不许出现空闲」必须在标记层面也成立 —— 否则任何按标记
    // 搜词的读法(以及截图里选中的文本之外的工具)都会把说明文字当成断言。
    expect(html, "原始标记里出现了「空闲」").not.toContain("空闲");
    expect(html, "原始标记里出现了「没有在跑」").not.toContain("没有在跑");
  });

  it("库里的那部分**照常显示**(读不到的是运行态,不是整个页面)", () => {
    const text = visible(
      unavailable({
        activity: activity(WK_ID, {
          currentWorks: [{ id: "w1", title: "把导出接口写完", status: "in_progress", ageMs: 60_000 }],
          readyWorks: 3,
          todos: [{ kind: "review_work", label: WK_TODO_LABEL, attempts: 1, maxAttempts: 3, target: null }],
        }),
      }),
    );
    expect(text).toContain("把导出接口写完");
    expect(text).toContain("进行中");
    expect(text).toContain("优先做 3 件");
    expect(text).toContain(WK_TODO_LABEL);
    expect(text).toContain("已叫醒 1/3 次");
  });

  it("unavailable 时心跳也不许照抄「本进程还没跑过兜底检查」(那是「没发生」,不是「读不到」)", () => {
    const text = visible(unavailable());
    expect(text).toContain("心跳读不到");
    expect(text).not.toContain("本进程还没跑过兜底检查");
  });

  it("防御:即便快照里错误地带着 turn,unavailable 也**不许**渲染成「在跑」", () => {
    const text = visible(
      unavailable({
        activity: activity(WK_ID, { turn: { elapsedMs: 99_000, trigger: { kind: "user" } } }),
      }),
    );
    expect(text).toContain("运行态读不到");
    expect(text).not.toContain("已跑");
    expect(text).not.toContain("你亲口发起");
  });

  it("页签上也不许把「读不到」显示成「没在跑」:给灰点,不给绿点", () => {
    const html = renderToStaticMarkup(
      createElement(MemberRoleTabs, {
        members: [WK],
        active: WK_ID,
        onSelect: vi.fn(),
        // ⚠️ 即便快照里带着 turn:runtime 不是 host,就不许点亮
        activityOf: () => activity(WK_ID, { turn: { elapsedMs: 1_000, trigger: { kind: "user" } } }),
        runtime: "unavailable",
      }),
    );
    expect(html).toContain('data-state="unknown"');
    expect(html, "读不到却点亮了实时点").not.toContain('class="ss-live-dot"></span>');
    expect(html).not.toContain("空闲");
    expect(html).not.toContain("没有在跑");
  });
});

// ── 判据 4:还没拿到过快照(data === null)也不许断言空闲 ──────────

describe("④ live.data === null(还没拿到过)⇒ 「正在读取」,不是「一切正常」", () => {
  const noSnapshot = renderPane({
    member: WK,
    activity: null,
    conversation: null,
    harnessRole: null,
    artifacts: [],
    runtime: null,
    dispatch: null,
    fetchedAt: null,
    now: 12_345,
  });

  it("出现「正在读取运行态」,且不许出现任何「空闲 / 没在跑」的断言", () => {
    const text = visible(noSnapshot);
    expect(text).toContain("正在读取运行态");
    expect(text).not.toContain("空闲");
    expect(text).not.toContain("没有在跑");
    expect(text).not.toContain("此刻没有回合在跑");
    expect(text).not.toContain("已跑");
    expect(noSnapshot).toContain('data-state="unknown"');
    expect(noSnapshot).not.toContain("空闲");
    expect(noSnapshot).not.toContain("没有在跑");
  });

  it("**不许**把「还不知道」显示成一个空的「一切正常」", () => {
    const text = visible(noSnapshot);
    expect(text, "还没拿到快照就说「手上没有进行中的工作项」").not.toContain("手上没有进行中的工作项");
    expect(text, "还没拿到快照就说「排空器没有该它跑的待办」").not.toContain("排空器现在没有该它跑的待办");
  });

  it("对话与工件这两块**不依赖**运行态,照常显示(它们来自别的端点)", () => {
    const text = visible(
      renderPane({
        member: WK,
        activity: null,
        conversation: WK_CONVERSATION,
        harnessRole: WK_ROLE,
        artifacts: WK_ARTIFACTS,
        runtime: null,
        dispatch: null,
        fetchedAt: null,
        now: 0,
      }),
    );
    expect(text).toContain("他产生了什么对话 · 2 条");
    expect(text).toContain("他产出了什么工件 · 2 件");
  });
});

// ── 判据 5:页签角标 = 「它欠着几件事」 ───────────────────────────

describe("⑤ 页签角标 = 它欠着几件事(口径:readyWorks + todos.length)", () => {
  it("口径逐项钉住", () => {
    expect(memberDebt(activity(WK_ID, { readyWorks: 5, todos: WK_ACTIVITY.todos }))).toBe(6);
    expect(memberDebt(activity(WK_ID, { readyWorks: 0, todos: [] }))).toBe(0);
    // 没拿到快照 ⇒ 0(不许凭空造一个数出来)
    expect(memberDebt(null)).toBe(0);
    // waitingWorks 与 exhaustedTodos **不进角标**(它们是「还动不了 / 已经不叫它了」)
    expect(memberDebt(activity(WK_ID, { waitingWorks: 9, exhaustedTodos: 9 }))).toBe(0);
  });

  it("角标数字与口径一致;不欠事的成员**不显示**角标(负样本)", () => {
    const debtful = activity(WK_ID, {
      readyWorks: 5,
      todos: [
        { kind: "execute_work", label: "a", attempts: 0, maxAttempts: 3, target: null },
        { kind: "review_work", label: "b", attempts: 0, maxAttempts: 3, target: null },
      ],
    });
    const clean = activity(BM_ID, { readyWorks: 0, todos: [] });
    const html = renderToStaticMarkup(
      createElement(MemberRoleTabs, {
        members: [WK, BM],
        active: null,
        onSelect: vi.fn(),
        activityOf: (id: string) => (id === WK_ID ? debtful : clean),
        runtime: "host",
      }),
    );
    const text = visible(html);
    expect(text).toContain("7"); // 5 + 2
    expect((html.match(/data-tone="cinnabar"/g) ?? []).length, "只有欠着事的那个成员有角标").toBe(1);
    // 角标数字与口径**同源**:这里是 5 + 2 = 7,不是随便一个数
    expect(memberDebt(debtful)).toBe(7);
  });

  it("页签:有回合在跑的那一个才点亮实时点", () => {
    const html = renderToStaticMarkup(
      createElement(MemberRoleTabs, {
        members: [WK, BM],
        active: null,
        onSelect: vi.fn(),
        activityOf: (id: string) =>
          id === WK_ID ? activity(WK_ID, { turn: { elapsedMs: 1_000, trigger: { kind: "user" } } }) : activity(BM_ID),
        runtime: "host",
      }),
    );
    expect((html.match(/class="ss-live-dot"><\/span>/g) ?? []).length, "只有在跑的那一个有点").toBe(1);
  });
});

// ── 判据 6:零值不占版面 ────────────────────────────────────────

describe("⑥ 数量为 0 的事实不许占版面", () => {
  it("waitingWorks = 0 ⇒ 页面上不出现「等前置」", () => {
    const text = visible(renderWorker({ activity: activity(WK_ID, { readyWorks: 2, waitingWorks: 0 }) }));
    expect(text).toContain("优先做 2 件");
    expect(text, "「等前置 0 件」占了版面").not.toContain("等前置");
  });

  it("exhaustedTodos = 0 ⇒ 不出现「预算用尽」", () => {
    const text = visible(renderWorker({ activity: activity(WK_ID, { readyWorks: 1, exhaustedTodos: 0 }) }));
    expect(text).not.toContain("预算用尽");
  });

  it("✅ 正样本(证明上面两条不是空转):> 0 时**必须**出现", () => {
    const text = visible(
      renderWorker({ activity: activity(WK_ID, { readyWorks: 2, waitingWorks: 3, exhaustedTodos: 4 }) }),
    );
    expect(text).toContain("优先做 2 件");
    expect(text).toContain("等前置 3 件");
    expect(text).toContain("预算用尽不再叫醒 4 件");
  });

  it("三项全 0 ⇒ 那一行整个不渲染", () => {
    expect(debtFacts(activity(WK_ID, { readyWorks: 0, waitingWorks: 0, exhaustedTodos: 0 }))).toEqual([]);
    const text = visible(renderWorker({ activity: activity(WK_ID) }));
    expect(text).not.toContain("优先做");
    expect(text).not.toContain("等前置");
    expect(text).not.toContain("预算用尽");
  });
});

// ── 判据 7:条数来自真实数组 / SQL 真值 ──────────────────────────

describe("⑦ 「N 条」「N 件」的 N 必须来自真实数据", () => {
  it("工件数 = 传入数组的 length;每一件都在页面上", () => {
    const four = [
      artifact("a1", { title: "工件一" }),
      artifact("a2", { title: "工件二" }),
      artifact("a3", { title: "工件三" }),
      artifact("a4", { title: "工件四" }),
    ];
    const text = visible(renderWorker({ artifacts: four }));
    expect(text).toContain("他产出了什么工件 · 4 件");
    for (const a of four) expect(text).toContain(a.title);
    expect(text, "凭空多报了一件").not.toContain("· 5 件");
  });

  it("对话条数用 `group.total`(SQL GROUP BY 的真值),**不是** messages.length", () => {
    const truncated = conversation(WK_ID, {
      total: 9,
      byKind: { assistant: 9 },
      messages: [msg("m2", WK_ID, "assistant", WK_MSG_EXCERPT), msg("m1", WK_ID, "assistant", "先看现有接口")],
      truncated: true,
    });
    const text = visible(renderWorker({ conversation: truncated }));
    expect(text).toContain("他产生了什么对话 · 9 条");
    expect(text, "拿返回条数冒充了总数").not.toContain("他产生了什么对话 · 2 条");
    expect(text).toContain("只显示最近 2 条(共 9 条");
  });

  it("一条都没有的成员:如实说 0,而且说清是「还没有」", () => {
    const text = visible(renderWorker({ conversation: null, artifacts: [] }));
    expect(text).toContain("他产生了什么对话 · 0 条");
    expect(text).toContain("他产出了什么工件 · 0 件");
    expect(text).toContain("还没有发言。");
    expect(text).toContain("他还没有产出的工件。");
  });
});

// ── 判据 8:能力面「求解不了」≠「0 个」 ──────────────────────────

describe("⑧ 角色能力面:工具面「求解不了」不许显示成「0 个」", () => {
  it("toolsSolved=false ⇒ 「求解不了(组织未播种)」且不显示计数", () => {
    const text = visible(
      renderWorker({
        harnessRole: harnessRole("worker", "工程师", { toolsSolved: false, tools: [] }),
      }),
    );
    expect(text).toContain("求解不了(组织未播种)");
    expect(text, "把「算不出来」显示成了「实得工具 0 个」").not.toMatch(/实得工具\s*0\s*个/);
  });

  it("✅ 正样本:toolsSolved=true 且 tools 为空 ⇒ **这才是**「0 个」(合法形状)", () => {
    const text = visible(
      renderWorker({ harnessRole: harnessRole("worker", "工程师", { toolsSolved: true, tools: [] }) }),
    );
    expect(text).toMatch(/实得工具\s*0\s*个/);
    expect(text).not.toContain("求解不了");
  });

  it("越界项与 ceiling 都如实显示", () => {
    const text = visible(
      renderWorker({
        harnessRole: harnessRole("worker", "工程师", {
          ceiling: ["board_list", "board_read", "code_write"],
          blockedByCeiling: ["org.reset"],
        }),
      }),
    );
    expect(text).toContain("超出架构上界");
    expect(text).toContain("org.reset");
    expect(text).toContain("code_write");
  });
});

// ── 判据 9:时间真的在走(展示层面的推进)────────────────────────

describe("⑨ 年龄会随本地时间往前推(时间看起来在走)", () => {
  it("formatAge 的粒度:秒 → 分 → 时 → 天,非法值不猜", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(12_000)).toBe("12s");
    expect(formatAge(59_999)).toBe("59s");
    expect(formatAge(65_000)).toBe("1分5s");
    expect(formatAge(3_600_000)).toBe("1小时0分");
    expect(formatAge(90_000_000)).toBe("1天1小时");
    expect(formatAge(-1)).toBe("—");
    expect(formatAge(Number.NaN)).toBe("—");
  });

  it("elapsedSinceFetch:没有快照时加 0;时钟回拨不给负数", () => {
    expect(elapsedSinceFetch(null, 99_999)).toBe(0);
    expect(elapsedSinceFetch(1_000, 4_500)).toBe(3_500);
    expect(elapsedSinceFetch(1_000, 500)).toBe(0);
  });

  it("快照 ageMs=10s、本地已过 5s ⇒ 屏上是 15s(加法只影响显示)", () => {
    const text = visible(
      renderWorker({
        activity: activity(WK_ID, { turn: { elapsedMs: 10_000, trigger: { kind: "user" } } }),
        fetchedAt: 1_000,
        now: 6_000,
      }),
    );
    expect(text).toContain("已跑 15s");
  });
});
