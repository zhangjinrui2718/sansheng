/**
 * 表态(V2,2026-11-21)—— 行动区 + 流内塌缩事实的双判据
 *
 * ⚠️ **判据变更记录**(V2,用户对 v5 流内卡不满:随对话滚动漂移、可发现性不稳):
 *   · 未完结表态 → **行动区**(`features/chat/ActionRail.tsx`,钉在输入区上方,
 *     位置恒定;零待办整区消失);判据 `actionItemsOf`(四状态点);
 *   · 完结表态 → 仍在流里**原地塌缩成一行事实**(v5 塌缩判据逐字继承);
 *     判据 `streamFactsOf`;
 *   · 两者同源(同一份 StreamCardsInput),不会两处说法漂移。
 *   · 诚实纪律**逐字继承**:加载中/读失败不许渲染成「没有」;已收口项目的提问
 *     只数不渲染;F3「已答复 · 整理中」窗口要可见(consumedAt 区分两态)。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AwaitingAcceptanceView,
  AnsweredClientQuestionView,
  ClientQuestionView,
  Turn,
  WorkView,
} from "../../shared/types/platform";
import type { ActionItem, StreamCardsInput } from "../../web/src/entities/streamCards";
import {
  actionItemKey,
  actionItemsOf,
  cardsUnavailableOf,
  mergeStream,
  streamFactKey,
  streamFactsOf,
} from "../../web/src/entities/streamCards";
import { ConversationStream } from "../../web/src/features/chat/MessageList";
import { StreamFactView } from "../../web/src/features/chat/StreamFacts";
import { ActionRail } from "../../web/src/features/chat/ActionRail";

const WEB_SRC = join(process.cwd(), "web/src");
const source = (rel: string): string =>
  readFileSync(join(WEB_SRC, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── 夹具 ──────────────────────────────────────────────────────────

const question = (over: Partial<ClientQuestionView> = {}): ClientQuestionView => ({
  id: "q_1",
  projectId: "p1",
  projectName: "美股量化平台",
  question: "现金账户档位选哪个?",
  options: ["PDT 档", "现金档"],
  lean: "建议现金档",
  intent: null,
  askedByAgentId: "a_bm",
  askedByName: "三生",
  createdAt: 1_700_000_200_000,
  status: "open",
  ...over,
});

const answered = (over: Partial<AnsweredClientQuestionView> = {}): AnsweredClientQuestionView => ({
  id: "q_1",
  projectId: "p1",
  question: "现金账户档位选哪个?",
  answeredAt: 1_700_000_300_000,
  consumedAt: 1_700_000_400_000,
  decisionArtifactId: "art_d1",
  ...over,
});

const acceptance = (over: Partial<AwaitingAcceptanceView> = {}): AwaitingAcceptanceView => ({
  artifactId: "art_1",
  title: "最终交付物",
  deliveredAt: 1_700_000_100_000,
  deliverableType: "html_report",
  ...over,
});

const work = (over: Partial<WorkView> = {}): WorkView =>
  ({
    id: "w_1",
    projectId: "p1",
    parentWorkId: null,
    title: "拆解出来的活",
    goal: "g",
    status: "open",
    assigneeAgentId: "a_wk",
    assigneeName: "研究员",
    priority: 3,
    createdAt: 1_700_000_150_000,
    updatedAt: 1_700_000_150_000,
    dependsOn: [],
    ...over,
  }) as WorkView;

const turn = (id: string, at: number): Turn =>
  ({
    id,
    projectId: "p1",
    sessionId: "s_main",
    role: "user",
    blocks: [{ kind: "text", text: `消息 ${id}` }],
    startedAt: at,
    agentId: null,
    origin: { source: "unknown" },
  }) as Turn;

const input = (over: Partial<StreamCardsInput> = {}): StreamCardsInput => ({
  projectId: "p1",
  isMainSession: true,
  detail: {
    detail: {
      awaitingAcceptance: [acceptance()],
      recentDeliveryVerdicts: [
        { artifactId: "art_0", title: "上一份交付物", verdict: "accept", note: null, at: 1_700_000_050_000 },
      ],
    },
    loading: false,
    error: null,
  },
  questions: {
    data: [question()],
    closedProjectQuestions: [],
    answered: [answered()],
    loading: false,
    error: null,
  },
  works: { data: [], loading: false, error: null },
  unconfirmedCount: 0,
  ...over,
});

const renderFact = (fact: Parameters<typeof StreamFactView>[0]["fact"]) =>
  renderToStaticMarkup(createElement(StreamFactView, { fact }));

const renderRail = (actions: readonly ActionItem[], unavailable: string | null = null) =>
  renderToStaticMarkup(createElement(ActionRail, { actions, unavailable, plan: null }));

// ── 判据:行动项(未完结 → 行动区)──────────────────────────────

describe("actionItemsOf · 行动项从哪来、锚在哪", () => {
  it("三类行动项都发,且各自锚在自己的时刻上(验收=交付时刻/提问=提问时刻)", () => {
    const items = actionItemsOf(
      input({
        works: { data: [work({ confirmedAt: null })], loading: false, error: null },
        unconfirmedCount: 1,
      }),
    );
    const atOf = (type: ActionItem["type"]) =>
      items.filter((i) => i.type === type).map((i) => i.at);
    expect(atOf("acceptance")).toEqual([1_700_000_100_000]);
    expect(atOf("question")).toEqual([1_700_000_200_000]);
    expect(atOf("confirm")).toEqual([1_700_000_150_000]); // 最新一条未确认工作项的产生时刻
  });

  it("排序 = 最早等你的事在最上(锚定时刻升序)", () => {
    const items = actionItemsOf(input());
    const ats = items.map((i) => i.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });

  it("接待会话(无项目)⇒ 一项都没有;非主对话线 ⇒ 同样没有", () => {
    expect(actionItemsOf(input({ projectId: null }))).toEqual([]);
    expect(actionItemsOf(input({ isMainSession: false }))).toEqual([]);
  });

  it("**加载中不发项**(详情/提问还在拉 ⇒ 那两类不出,不渲染成「没有」,也不编锚)", () => {
    expect(
      actionItemsOf(input({ detail: { detail: null, loading: true, error: null } })).filter((i) => i.type === "acceptance"),
    ).toEqual([]);
    expect(
      actionItemsOf(
        input({ questions: { data: [], closedProjectQuestions: [], answered: [], loading: true, error: null } }),
      ).filter((i) => i.type === "question"),
    ).toEqual([]);
  });

  it("确认开工判的是「行在不在手」,不是「在不在取」:首载无行 ⇒ 不出;重取期间旧行在手 ⇒ 照常出", () => {
    expect(
      actionItemsOf(input({ works: { data: [], loading: true, error: null }, unconfirmedCount: 3 })).filter((i) => i.type === "confirm"),
    ).toEqual([]);
    expect(
      actionItemsOf(input({ works: { data: [work({ confirmedAt: null })], loading: true, error: null }, unconfirmedCount: 3 })).map((i) => i.type),
    ).toContain("confirm");
  });

  it("收口提议(intent=close)是独立的第四类(type=close),普通提问是 question", () => {
    const items = actionItemsOf(
      input({
        detail: { detail: null, loading: false, error: null },
        questions: {
          data: [question({ intent: "close" })],
          closedProjectQuestions: [],
          answered: [],
          loading: false,
          error: null,
        },
      }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("close");
  });

  it("已收口项目的提问只数不渲染:那批经同一道筛进不来(2026-10-07 纪律不变)", () => {
    const items = actionItemsOf(
      input({
        detail: { detail: null, loading: false, error: null },
        questions: {
          data: [],
          closedProjectQuestions: [question({ id: "q_closed", projectId: "p1" })],
          answered: [],
          loading: false,
          error: null,
        },
      }),
    );
    expect(items.filter((i) => i.type === "question" || i.type === "close")).toEqual([]);
  });
});

// ── 判据:塌缩事实(完结 → 留在流里)────────────────────────────

describe("streamFactsOf · 事实行从哪来、锚在哪", () => {
  it("三类事实都发,且各自锚在自己的时刻上(裁决=落库时刻/答复=答复时刻)", () => {
    const facts = streamFactsOf(input());
    const atOf = (kind: string) => facts.filter((f) => f.kind === kind).map((f) => f.at);
    expect(atOf("verdict")).toEqual([1_700_000_050_000]);
    expect(atOf("answered")).toEqual([1_700_000_300_000]);
  });

  it("接待/非主线 ⇒ 没有事实行", () => {
    expect(streamFactsOf(input({ projectId: null }))).toEqual([]);
    expect(streamFactsOf(input({ isMainSession: false }))).toEqual([]);
  });

  it("未处置(consumedAt=null)经判据函数产出 consumed:false —— F3 窗口不许在判据层塌掉", () => {
    // ⚠️ 这条必须从**判据函数**出发:直接构造 fact 对象会绕过 consumedAt 的换算,
    // 变异「consumed: true」在那种写法下抓不到(变异自检 M5 抓出来的盲区)。
    const facts = streamFactsOf(
      input({
        questions: {
          data: [],
          closedProjectQuestions: [],
          answered: [answered({ consumedAt: null })],
          loading: false,
          error: null,
        },
      }),
    );
    const row = facts.find((f) => f.kind === "answered");
    expect(row).toBeDefined();
    expect(row?.kind === "answered" && row.consumed).toBe(false);
    expect(renderFact(row!)).toContain("整理中");
  });

  it("plan-confirmed 按 confirmedAt 分批:同一毫秒一批,一条事实行", () => {
    const facts = streamFactsOf(
      input({
        works: {
          data: [
            work({ id: "w1", confirmedAt: 1_700_000_500_000 }),
            work({ id: "w2", confirmedAt: 1_700_000_500_000 }),
            work({ id: "w3", confirmedAt: 1_700_000_600_000, status: "done" }),
          ],
          loading: false,
          error: null,
        },
      }),
    );
    const confirmed = facts.filter((f) => f.kind === "plan-confirmed");
    expect(confirmed).toHaveLength(2);
    expect(confirmed.map((f) => (f.kind === "plan-confirmed" ? f.count : 0)).sort()).toEqual([1, 2]);
  });
});

describe("mergeStream · 归并", () => {
  it("按锚定时刻归并排序;同一时刻轮在前(稳定)", () => {
    const items = mergeStream(
      [turn("t_early", 1_700_000_100_000), turn("t_late", 1_700_000_300_000)].map((t) => ({ turn: t })),
      streamFactsOf(input()),
    );
    const kinds = items.map((i) => (i.kind === "turn" ? `turn:${i.turn.id}` : `fact:${i.fact.kind}`));
    expect(kinds).toEqual([
      "fact:verdict", // 50s
      "turn:t_early", // 100s
      "turn:t_late", // 300s —— 与事实并列,轮在前(先 push 轮)
      "fact:answered", // 300s
    ]);
  });

  it("流 key 稳定且互不相同(同类同实体共享 key 会复用错 DOM)", () => {
    const facts = streamFactsOf(input());
    const keys = facts.map(streamFactKey);
    expect(new Set(keys).size).toBe(keys.length);
    const k1 = streamFactKey({ kind: "verdict", at: 1, artifactId: "a", title: "t", verdict: "accept", note: null });
    const k2 = streamFactKey({ kind: "verdict", at: 2, artifactId: "a", title: "t", verdict: "reject", note: null });
    expect(k1).not.toBe(k2);
  });

  it("行动项 key 也稳定(confirm 恒 plan;question/close 按 q.id)", () => {
    const keys = actionItemsOf(input({ works: { data: [work({ confirmedAt: null })], loading: false, error: null }, unconfirmedCount: 1 })).map(actionItemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("cardsUnavailableOf · 读不到不许静默", () => {
  it("加载中是 null(还没查到不许说「读不到」);读失败按来源点名;接待恒 null", () => {
    expect(cardsUnavailableOf({ projectId: "p1", detailError: null, questionsError: null })).toBeNull();
    expect(
      cardsUnavailableOf({ projectId: "p1", detailError: "boom", questionsError: null }),
      "项目详情",
    ).toContain("项目详情");
    expect(
      cardsUnavailableOf({ projectId: "p1", detailError: "boom", questionsError: "boom2" }),
    ).toContain("提问台账");
    expect(cardsUnavailableOf({ projectId: null, detailError: "boom", questionsError: "boom2" })).toBeNull();
  });
});

// ── 渲染:行动区 vs 塌缩事实行 ───────────────────────────────────

describe("ActionRail · 行动区渲染", () => {
  it("每件待办一行:类型词 + 摘要 + 动词(四状态点各自的词都在场)", () => {
    const items = actionItemsOf(
      input({
        works: { data: [work({ confirmedAt: null })], loading: false, error: null },
        unconfirmedCount: 1,
        questions: {
          data: [question(), question({ id: "q_close", intent: "close", createdAt: 1_700_000_250_000 })],
          closedProjectQuestions: [],
          answered: [],
          loading: false,
          error: null,
        },
      }),
    );
    const html = renderRail(items);
    expect(html).toContain("确认开工");
    expect(html).toContain("答问");
    expect(html).toContain("收口");
    expect(html).toContain("验收");
    expect(html).toContain("最终交付物"); // 验收摘要 = 交付物标题
    expect(html).toContain("现金账户档位选哪个"); // 答问摘要
  });

  it("零待办且读得到 ⇒ 整区消失(「没有事等你」不是信息)", () => {
    expect(renderRail([])).toBe("");
  });

  it("读不到 ⇒ 一行「读不到」常驻(不静默;不出假行动项)", () => {
    const html = renderRail([], "表态清单读不到(项目详情)—— 稍后自动重试");
    expect(html).toContain("表态清单读不到");
    expect(html).not.toContain("确认开工");
  });

  it("展开表单复用既有卡身(动作只有一份实现,ActionRail 不重写提交逻辑)", () => {
    // 2026-11-21:验收面板抽成共享件 components/deliverable/AcceptancePanel
    // (行动区与工件序列页两处消费);提问/计划卡身仍直接复用。
    const s = source("features/chat/ActionRail.tsx");
    expect(s).toContain("<ClientQuestionCard");
    expect(s).toContain("<PlanConfirmCard");
    expect(s).toContain("<AcceptancePanel");
    expect(s).not.toContain("<DeliveryVerdictActions"); // 不经面板直引 = 出现第二份组装
    const panel = source("components/deliverable/AcceptancePanel.tsx");
    expect(panel).toContain("<DeliveryVerdictActions");
    // 懒加载纪律照旧:正文点开才挂
    expect(panel).toContain("{showBody && <InlineDeliverableBody");
  });
});

describe("StreamFactView · 塌缩事实行渲染", () => {
  it("已答复(已处置)落 decision 工件;未处置 = 整理中(F3 窗口)", () => {
    const done = renderFact({ kind: "answered", at: 1, id: "q_1", question: "现金账户档位选哪个?", consumed: true });
    expect(done).toContain("已落 decision 工件");
    expect(done).not.toContain("提交答案");
    const pending = renderFact({ kind: "answered", at: 1, id: "q_1", question: "现金账户档位选哪个?", consumed: false });
    expect(pending).toContain("整理中");
  });

  it("裁决塌缩行带结论与附言;计划确认塌缩行带条数", () => {
    const v = renderFact({ kind: "verdict", at: 1, artifactId: "a", title: "最终交付物", verdict: "reject", note: "数据源错了" });
    expect(v).toContain("要改");
    expect(v).toContain("数据源错了");
    const p = renderFact({ kind: "plan-confirmed", at: 1, count: 4 });
    expect(p).toContain("已确认开工 · 4 条");
    expect(p).not.toContain("确认开工</button>");
  });
});

describe("ConversationStream · 轮与事实同一条流", () => {
  it("轮与塌缩事实按锚定时刻交错渲染(可操作表态不在这条流里 —— 在行动区)", () => {
    const items = mergeStream(
      [turn("t_1", 1_700_000_100_000)].map((t) => ({ turn: t })),
      streamFactsOf(input()),
    );
    const html = renderToStaticMarkup(
      createElement(ConversationStream, { history: items, streaming: [], hiddenNote: null }),
    );
    expect(html).toContain("消息 t_1");
    expect(html).toContain("已答复"); // answered 事实行(300s)在轮之后(问题原文可在事实行里)
    // ⚠️ 未完结表态的**操作面**不进流 —— V2 判据:它们长在行动区。
    // (answered 事实行含问题原文是塌缩判据的一部分,不算「操作面」。)
    expect(html).not.toContain("最终交付物"); // 验收卡(可操作)不在流里
    expect(html).not.toContain("提交答案");
    expect(html).not.toContain(">接受<");
  });

  it("真的什么都没有 ⇒ 流为空(空态由 MessageList 的 Empty 判,不在这里渲染「暂无」)", () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStream, { history: [], streaming: [], hiddenNote: null }),
    );
    expect(html).not.toContain("暂无");
    expect(html).not.toContain("加载中");
  });
});

// ── 落点与退役哨兵 ───────────────────────────────────────────────

describe("落点哨兵 · V2 判据变更", () => {
  it("v5 收件箱两件与流内可操作卡都不许复活", () => {
    expect(existsSync(join(WEB_SRC, "components/shell/ChatRightRail.tsx"))).toBe(false);
    expect(existsSync(join(WEB_SRC, "features/chat/Inbox.tsx"))).toBe(false);
    expect(existsSync(join(WEB_SRC, "features/chat/StreamCards.tsx"))).toBe(false);
  });

  it("旧 dock 的名字不许在 web/src 里回来(剥注释后)", () => {
    const chat = source("features/chat/ChatSurface.tsx");
    const app = source("App.tsx");
    for (const src of [chat, app]) {
      expect(src).not.toContain("AcceptanceDock");
      expect(src).not.toContain("ClientQuestionDock");
      expect(src).not.toContain("InboxPanel");
      expect(src).not.toContain("ChatRightRail");
    }
  });

  it("ChatSurface 真的在算行动项与事实并分别接线(MessageList 收 facts,ActionRail 收 actions)", () => {
    const chat = source("features/chat/ChatSurface.tsx");
    expect(chat).toContain("actionItemsOf(");
    expect(chat).toContain("streamFactsOf(");
    expect(chat).toContain("cardsUnavailableOf(");
    expect(chat).toMatch(/<MessageList\s+facts=\{facts\}/);
    expect(chat).toMatch(/<ActionRail\s+actions=\{actions\}/);
  });

  it("ActionRail 钉在输入区上方(MessageList 之后、ChatComposer 之前 —— 位置恒定)", () => {
    const chat = source("features/chat/ChatSurface.tsx");
    const iList = chat.indexOf("<MessageList");
    const iRail = chat.indexOf("<ActionRail");
    const iComposer = chat.indexOf("<ChatComposer");
    expect(iList).toBeGreaterThan(-1);
    expect(iRail).toBeGreaterThan(iList);
    expect(iComposer).toBeGreaterThan(iRail);
  });

  it("MessageList 真的在归并(不是把事实渲染成另一条带)", () => {
    const list = source("features/chat/MessageList.tsx");
    expect(list).toContain("mergeStream(");
    expect(list).toContain("StreamFactView");
  });

  it("对话页头部仍有「详情」入口(项目页签退场后的常驻路径,判据随迁)", () => {
    expect(source("features/chat/ChatSurface.tsx")).toContain('href="#/project"');
  });
});
