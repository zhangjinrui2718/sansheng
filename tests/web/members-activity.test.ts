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
 * ── 2026-10-06(同日第二刀):这一版又改了什么 ─────────────────────
 *
 * 用户的原话:「(成员页底部的两段)这个信息不要展示了,我感觉没什么意思」+
 * 「成员的 harness 管理可以放在成员的 tab 下面,可以把「成员」「harness」这两个
 * tab 也合并了」。对本文件的影响:
 *
 *   - `MemberPane` 上那个传「只读角色能力面」的 prop **删掉了**(那块内容换成
 *     成员面板里的 `RoleHarnessSection`,它自己取数)。测试夹具原来与那个 prop
 *     同名,也一并改名成 `roleHarness(...)` —— 这样「删干净」可以由一条 grep
 *     (三个已删除的名字:harness 路由页 / 角色页签 / 那个 prop)在 `web/src/`
 *     与 `tests/web/` 里 **0 命中**来验证,而不是靠读代码。
 *   - 原来的判据 ⑧(「求解不了」≠「0 个」)原来是断言成员页那块只读能力面的;
 *     那块已删,**整组挪到 `tests/web/harness-by-role.test.ts` 判据 ⑤**,断言对象
 *     换成 `HarnessRolePane`。
 *   - 新增两条:
 *       · 判据 ① 里的「成员页签一次只渲染一个成员的 harness 面板」(正负样本);
 *       · 判据 ⑩「页签角标 = 欠活数字 + `roleIssueCount` 告警」(原 harness 页
 *         页签那个角标的功能,两个页签合并后不能丢)。
 *     ⚠️ 「一次只渲染一个角色」这条判据原来是 harness 页的角色页签承担的
 *     (harness 页的角色页签),那个组件已删 —— 现在由**成员页签**承担,断言就在上面
 *     那两条里。
 *
 * ── 2026-10-06(同日第三刀):harness 从成员面板里**搬出去单独成卡** ─────
 *
 * 用户的原话:「成员中,角色 harness 单独放一个卡片出来,未来角色的 harness 配置
 * 就放在这个地方」。对本文件的影响:
 *
 *   - `MemberPane` 不再接收**任何** harness 相关的 prop(那个 `onHarnessSaved`
 *     也一起删掉 —— 没有读者了就是死参数),面板里也不再渲染 harness。
 *   - 判据 ① 里那两条断言**改了方向**:以前断言「成员面板里**有** harness 那一块」,
 *     现在断言「**没有**」;并新增一条**位置与归属**的断言(组合组件
 *     `MemberTabPanels` = 页面实际用的结构:面板在上、harness 卡在下)。
 *     `MembersPage` 依赖 store,SSR 下驱动不了,所以走组合组件而不是硬渲染页面。
 *   - 卡片头自己的判据(状态摘要、告警 Pill、`embedded` 不出两层 `Section`)
 *     在 `tests/web/harness-by-role.test.ts` 判据 ⑦⑧ —— 这里不重复一份。
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
  HarnessView,
  MemberActivityView,
  MemberConversationView,
  MemberView,
  ProjectLiveView,
  ProjectRole,
  PromptUnitView,
  RoleHarnessView,
  SessionMessageView,
} from "@shared/types/platform";
import {
  MemberPane,
  MemberRoleTabs,
  MemberTabPanels,
  debtFacts,
  elapsedSinceFetch,
  formatAge,
  memberDebt,
} from "@/routes/Members";
import { RoleHarnessDisclosure, roleIssueCount } from "@/components/members/RoleHarness";

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
  role: "research_worker",
  displayName: "研究员",
  specialization: "engineering",
};

/** 业务经理**独有**的三样东西 —— 负样本就靠它们(传研究工时一个都不许出现)。 */
const BM_TODO_LABEL = "把这一批下游结果合并成一次汇报";
const BM_ARTIFACT_TITLE = "甲方交付验收报告";
const BM_MSG_EXCERPT = "我已经把本轮结论汇报给甲方";

/** 研究员自己的三样(正样本)。 */
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
    bodyPath: `artifacts/art_${id}.md`,
    bodyBytes: 0,
    commitSha: null,
    authorAgentId: WK_ID,
    authorName: "研究员",
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

/**
 * 一个角色的 harness 视图夹具。
 *
 * ⚠️ 名字(2026-10-06)刻意**不叫**那个已删除的 prop 名 —— 那个名字是本轮验收里
 * 「三个旧名字在 `web/src/` 与 `tests/web/` 0 命中」时必须消失的词。改名让
 * 「删干净」这件事可以被一条命令验证,而不是靠读代码。
 */
function roleHarness(
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

const WK_HARNESS = roleHarness("research_worker", "研究员");

/**
 * 两段删除之后**唯一**还会渲染的 body(如果它非空的话)需要的夹具。
 *
 * ⚠️ 「不在成员表里的发言」整段现在只在 `strangers` 非空时才渲染,而且
 * `MemberPane` 里那一块 harness 面板是**自足**的(自己 `getHarness()`,SSR 下
 * `useEffect` 不跑 ⇒ 永远停在「加载中」)。所以本文件要钉住「一次只渲染一个成员的
 * harness 面板」时,得走 `RoleHarnessDisclosure`(那正是 `RoleHarnessSection`
 * 取到数据之后画的东西)拿**带完整数据**的视图断言 —— 在「加载中」的 html 上断言
 * 「B 的单元不许出现」是恒真的假检查。
 */
const promptUnit = (id: string, over: Partial<PromptUnitView> = {}): PromptUnitView => ({
  id,
  loaded: true,
  chars: id.length,
  content: `# ${id}`,
  path: `/data/harness/system_prompts/${id}.md`,
  ...over,
});

const BM_ONLY_UNIT = "business_manager.core";
const WK_ONLY_UNIT = "research_worker.core";
const SHARED_UNIT = "collaboration.ask";

const BM_HARNESS = roleHarness("business_manager", "业务经理", {
  promptUnits: [promptUnit(BM_ONLY_UNIT), promptUnit(SHARED_UNIT)],
});
const WK_HARNESS_FULL = roleHarness("research_worker", "研究员", {
  promptUnits: [promptUnit(SHARED_UNIT), promptUnit(WK_ONLY_UNIT)],
});

const HARNESS_VIEW: HarnessView = {
  roles: [BM_HARNESS, WK_HARNESS_FULL],
  promptDir: "/data/harness/system_prompts/",
  toolsDir: "/data/harness/tools/",
  strayToolSetFiles: [],
  writable: true,
};

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

/** 研究员那一份「正在做什么」:有回合在跑、手上有活、排空器有两条待办。 */
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
  /**
   * ⚠️ **必填** —— 「读不到对话记录」与「他没有说过话」在屏幕上都是「0 条 + 一句
   * 空态」,所以调用点必须显式表态(传 `null` = 这次请求没出错)。
   */
  conversationError: string | null;
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
    conversationError: null,
    artifacts: WK_ARTIFACTS,
    runtime: "host",
    dispatch: DISPATCH,
    fetchedAt: 1_000,
    now: 1_000,
    ...over,
  });

// ── 判据 1:一次只渲染一个成员 ──────────────────────────────────

describe("① 一次只渲染一个成员(这一版要修的正是「四个人的内容同时铺开」)", () => {
  it("传研究员 ⇒ 业务经理**独有**的内容一个都不许出现(负样本)", () => {
    const text = visible(renderWorker({ activity: WK_ACTIVITY }));
    expect(text, "研究员面板里出现了业务经理的显示名").not.toContain("业务经理");
    expect(text, "出现了业务经理独有的待办").not.toContain(BM_TODO_LABEL);
    expect(text, "出现了业务经理独有的工件").not.toContain(BM_ARTIFACT_TITLE);
    expect(text, "出现了业务经理独有的发言").not.toContain(BM_MSG_EXCERPT);

    // 正样本:研究员自己的三样都在(证明上面的负样本不是「整页啥都没渲染」)
    expect(text, "角色名(与 harness 页同一个词)").toContain("研究员");
    expect(text).toContain(WK_TODO_LABEL);
    expect(text).toContain(WK_ARTIFACT_TITLE);
    expect(text).toContain(WK_MSG_EXCERPT);
  });

  it("传业务经理 ⇒ 研究员独有的内容不许出现(反方向)", () => {
    const text = visible(
      renderPane({
        member: BM,
        activity: BM_ACTIVITY,
        conversation: BM_CONVERSATION,
        conversationError: null,
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
        issuesOf: () => 0,
        runtime: "host",
      }),
    );
    expect((html.match(/role="tab"/g) ?? []).length, "两个成员 ⇒ 两个 tab").toBe(2);
    expect((html.match(/aria-selected="true"/g) ?? []).length, "只有一个选中").toBe(1);
    const text = visible(html);
    expect(text).toContain("业务经理");
    expect(text).toContain("研究员");
    // ⚠️ 页签上**只有角色名**(2026-10-06):以前页签是「人 + 角色 Pill」两段,
    // 而在「一人一角色」的组织里那两个词一模一样 ⇒ 屏幕上成了「工程师 执行者」。
    // 现在主体就是角色名(与 harness 页逐字相同),人的名字进 tooltip。
    expect(text, "角色名只出现一次语义,不再有第二个说法").not.toContain("执行者");
    expect(text).not.toContain("质检审查员");
  });

  it("【harness 合并】一次只渲染一个成员的 harness 面板:A 成员的角色渲染出来,B 成员独有的单元一个都不许出现", () => {
    // 为什么走 `RoleHarnessDisclosure` 而不是 `MemberPane` 本身:`MemberPane` 里挂的
    // `RoleHarnessSection` **自己取数**(`useEffect`),而 `renderToStaticMarkup`
    // 不跑 effect ⇒ SSR 下它永远停在「加载中」,一个单元 id 都不渲染。在那种 html 上
    // 断言「B 的单元不许出现」是**恒真**的假检查(本项目对「空转的检查」有明确警惕)。
    // `RoleHarnessDisclosure` 正是 `RoleHarnessSection` 取到数据之后画的那一层 ——
    // 同一条渲染路径,只是把数据从 props 喂进来,于是正负样本都不空转。
    const disclosure = (role: ProjectRole) =>
      renderToStaticMarkup(
        createElement(RoleHarnessDisclosure, {
          role,
          view: HARNESS_VIEW,
          loading: false,
          error: null,
          drafts: {},
          backups: {},
          onDraftChange: vi.fn(),
          onApplied: vi.fn(),
        }),
      );

    const asWorker = disclosure(WK.role);
    expect(asWorker, "研究员那块里出现了业务经理独有的单元").not.toContain(BM_ONLY_UNIT);
    expect(asWorker, "研究员自己的单元不在 ⇒ 上面的负样本是空转的").toContain(WK_ONLY_UNIT);

    const asBm = disclosure(BM.role);
    expect(asBm, "业务经理那块里出现了研究员独有的单元").not.toContain(WK_ONLY_UNIT);
    expect(asBm).toContain(BM_ONLY_UNIT);
  });

  it("【harness 单独成卡】它**不在**成员面板卡片里(负样本)", () => {
    // 2026-10-06(第三刀):用户原话「成员中,角色 harness 单独放一个卡片出来,
    // 未来角色的 harness 配置就放在这个地方」。所以这条断言的方向**反过来**了 ——
    // 以前断言成员面板里**有**它,现在断言**没有**。
    const pane = renderWorker();
    expect(pane, "「角色 harness」还在成员面板卡片里").not.toContain("角色 harness");
    expect(pane, "harness 的配置折叠块还在成员面板里").not.toContain("展开配置(提示词单元");
    expect(pane, "`RoleHarnessSection` 画出来的东西还在面板里").not.toContain(WK_ONLY_UNIT);
    expect(pane, "旧的只读「角色能力面」还在 —— 两处并存了").not.toContain("角色能力面");
  });

  it("【harness 单独成卡】它在面板**之后**、同一个 tab 面板里另起一块(位置与归属)", () => {
    // ⚠️ `MembersPage` 依赖 store(`useChatStore`),SSR 下驱动不了 —— 照本文件
    // 既有做法,把页面里那两块**纯 props** 的组合抽出来断言:`MemberTabPanels`
    // 就是页面实际用的那个组合(member / harness 两个槽)。
    const paneHtml = renderWorker();
    const stack = renderToStaticMarkup(
      createElement(MemberTabPanels, {
        member: createElement(MemberPane, {
          member: WK,
          activity: WK_ACTIVITY,
          conversation: WK_CONVERSATION,
          conversationError: null,
          artifacts: WK_ARTIFACTS,
          runtime: "host",
          dispatch: DISPATCH,
          fetchedAt: 1_000,
          now: 1_000,
        }),
        harness: createElement(RoleHarnessDisclosure, {
          role: WK.role,
          view: HARNESS_VIEW,
          loading: false,
          error: null,
          drafts: {},
          backups: {},
          onDraftChange: vi.fn(),
          onApplied: vi.fn(),
        }),
      }),
    );

    // 归属:面板那一段里没有 harness
    const paneStart = stack.indexOf("正在做什么");
    const harnessStart = stack.indexOf("角色 harness");
    expect(harnessStart, "组合里根本没有 harness 那块").toBeGreaterThan(-1);
    // 位置:harness 卡排在成员面板之后(用面板自己的内容当锚点)
    expect(harnessStart, "harness 排在成员面板前面").toBeGreaterThan(paneStart);
    // 正样本:工件(面板里最后一块)也在 harness 之前 ⇒ 不是「整页只有 harness」
    expect(stack.indexOf(WK_ARTIFACT_TITLE)).toBeLessThan(harnessStart);

    // 而面板单独渲染时确实没有它(与上一条负样本互为证据)
    expect(paneHtml).not.toContain("角色 harness");
    expect(stack).toContain("角色 harness");
    expect(stack).toContain(WK_ONLY_UNIT);
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
        issuesOf: () => 0,
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
    conversationError: null,
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
        conversationError: null,
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
        issuesOf: () => 0,
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
        issuesOf: () => 0,
        runtime: "host",
      }),
    );
    expect((html.match(/class="ss-live-dot"><\/span>/g) ?? []).length, "只有在跑的那一个有点").toBe(1);
  });

  // ⚠️ 原 harness 页那一行角色页签带的**告警角标**(四类需要注意的处数),合并之后
  // 挂在这里 —— 不搬就等于把那条可见性静默丢掉。
  it("⑩ 页签角标之二 = `roleIssueCount`(角色 harness 的告警),与「欠活」各有一个 title", () => {
    // 构造一个 `promptUnits` 里带 `loaded: false` 的角色 ⇒ 它的 roleIssueCount 是 1
    const dirty = roleHarness("research_worker", "研究员", {
      promptUnits: [promptUnit(WK_ONLY_UNIT, { loaded: false, content: "" })],
    });
    const clean = roleHarness("business_manager", "业务经理");
    const roles = [dirty, clean];
    const issuesOf = (role: ProjectRole) => {
      const r = roles.find((x) => x.role === role);
      return r === undefined ? 0 : roleIssueCount(r);
    };
    // 那个数必须**真的**来自 `loaded: false`(不是手写的一个 1)
    expect(issuesOf("research_worker"), "roleIssueCount 没把缺单元算进去").toBe(1);
    expect(issuesOf("business_manager")).toBe(0);

    const activityOf = (id: string) =>
      id === WK_ID ? activity(WK_ID, { readyWorks: 2 }) : activity(BM_ID);
    const html = renderToStaticMarkup(
      createElement(MemberRoleTabs, {
        members: [WK, BM],
        active: null,
        onSelect: vi.fn(),
        activityOf,
        issuesOf,
        runtime: "host",
      }),
    );
    // 欠活 2 + harness 告警 1 ⇒ 两个 cinnabar 角标,而且各自的 title 说不同的事
    expect((html.match(/data-tone="cinnabar"/g) ?? []).length, "欠活 + harness 告警 = 两个角标").toBe(2);
    expect(html).toContain("它欠着 2 件");
    expect(html).toContain("这个角色的 harness 有 1 处需要注意");

    // 负样本:全部正常(告警 0)⇒ 只剩「欠活」那一个角标,告警那句一个字都不出现
    const okHtml = renderToStaticMarkup(
      createElement(MemberRoleTabs, {
        members: [WK],
        active: null,
        onSelect: vi.fn(),
        activityOf,
        issuesOf: () => 0,
        runtime: "host",
      }),
    );
    expect((okHtml.match(/data-tone="cinnabar"/g) ?? []).length, "正常时不该有告警角标").toBe(1);
    expect(okHtml).not.toContain("这个角色的 harness 有");
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

// ── 判据 8 已移动 ────────────────────────────────────────────────
//
// 原来的判据 ⑧「角色能力面:工具面『求解不了』不许显示成『0 个』」断言的是
// `MemberPane` 里那块**只读的**能力面。2026-10-06 把「成员 + harness」两个页签
// 合并时,那块视图整块删掉(换成可写的 harness 面板),三条判据**一条没丢**:
// **整组挪到 `tests/web/harness-by-role.test.ts` 的判据 ⑤**,断言对象换成
// `HarnessRolePane`(它自己就实现了那三例:求解不了 ≠ 0、正样本 0 个、
// blockedByCeiling 与 ceiling 条目可见)。
//
// 这里不再重复一份 —— 同一条判据在两个文件里各写一遍,正是这次要清掉的重复。

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

// ── 判据 ⑪:`member-conversations` 读不到 ≠「他没有说过话」 ────────────
//
// 2026-10-06 合并 harness 到成员页时,页面上**唯一**渲染 `conversations.error`
// 的那一处被删掉了 ⇒ 端点失败时每个人的对话块都会显示「还没有发言。」(0 条),
// 而那句话是假的:这一次请求根本没成功。两者在屏幕上一模一样,所以必须分开。
describe("⑪ 对话记录「读不到」不许显示成「没有发言」", () => {
  it("有错误 ⇒ 标题写「读不到」并给出原因,而**不是**一句 0 条的空态", () => {
    const text = visible(renderWorker({ conversationError: "Failed to fetch" }));
    expect(text).toContain("读不到");
    expect(text).toContain("Failed to fetch");
    expect(text, "把请求失败说成「0 条」就是撒谎").not.toContain("他产生了什么对话 · 0 条");
  });

  it("负样本:没有错误时才走「N 条」与空态(证明上面那条不是恒真)", () => {
    const ok = visible(renderWorker({ conversationError: null }));
    expect(ok).toContain("他产生了什么对话 · 2 条");
    expect(ok).not.toContain("读不到");
  });
});
