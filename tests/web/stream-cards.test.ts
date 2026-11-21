/**
 * 表态卡进流(v5,2026-11-20)—— 原 inbox 判据的继承与变更
 *
 * ⚠️ **判据变更记录**(2026-11-20,用户裁决「待答和验收的交互都放在聊天框里面」):
 *   · 右栏收件箱(`ChatRightRail` + `Inbox`)退场,四类表态卡按**锚定时刻**归并进
 *     对话流(取代 2026-11-17 R-A 的「融合队列」,也取代 PlanConfirmCard 旧推理
 *     「提问是状态不是消息」—— 新形态:锚定 + 完结塌缩,历史不删除);
 *   · 判据全部住在 `web/src/lib/streamCards.ts`(纯函数),本文件直接打它;
 *   · 「只拉一次详情」判据的落点随迁:ChatSurface(哨兵在 project-dashboard.test.ts);
 *   · 诚实纪律**逐字继承**:加载中/读失败不许渲染成「没有」;已收口项目的提问
 *     只数不渲染;F3「已答复 · 整理中」窗口要可见(现在以 consumedAt 区分两态)。
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
import type { StreamCardsInput } from "../../web/src/lib/streamCards";
import {
  cardsUnavailableOf,
  mergeStream,
  streamCardKey,
  streamCardsOf,
} from "../../web/src/lib/streamCards";
import { ConversationStream } from "../../web/src/components/chat/MessageList";
import { StreamCardView, type PlanCardContext } from "../../web/src/components/chat/StreamCards";

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

const renderCard = (card: Parameters<typeof StreamCardView>[0]["card"], plan: PlanCardContext | null = null) =>
  renderToStaticMarkup(createElement(StreamCardView, { card, plan }));

// ── 判据:卡的存在与锚定 ──────────────────────────────────────────

describe("streamCardsOf · 卡从哪来、锚在哪", () => {
  it("四类卡都发,且各自锚在自己的时刻上", () => {
    const cards = streamCardsOf(
      input({
        works: { data: [work({ confirmedAt: null })], loading: false, error: null },
        unconfirmedCount: 1,
      }),
    );
    const atOf = (kind: string) => cards.filter((c) => c.kind === kind).map((c) => c.at);
    expect(atOf("acceptance")).toEqual([1_700_000_100_000]); // 交付时刻
    expect(atOf("verdict")).toEqual([1_700_000_050_000]); // 裁决落库时刻
    expect(atOf("question")).toEqual([1_700_000_200_000]); // 提问时刻
    expect(atOf("answered")).toEqual([1_700_000_300_000]); // 答复时刻
    expect(atOf("plan")).toEqual([1_700_000_150_000]); // 最新一条未确认工作项的产生时刻
  });

  it("接待会话(无项目)⇒ 一张卡都没有;非主对话线 ⇒ 同样没有", () => {
    expect(streamCardsOf(input({ projectId: null }))).toEqual([]);
    expect(streamCardsOf(input({ isMainSession: false }))).toEqual([]);
  });

  it("**加载中不发卡**:详情/提问还在拉 ⇒ 那两类卡不出(不渲染成「没有」,也不编锚)", () => {
    expect(streamCardsOf(input({ detail: { detail: null, loading: true, error: null } })).filter((c) => c.kind === "acceptance")).toEqual([]);
    expect(
      streamCardsOf(input({ questions: { data: [], closedProjectQuestions: [], answered: [], loading: true, error: null } })).filter((c) => c.kind === "question"),
    ).toEqual([]);
  });

  it("计划卡判的是「行在不在手」,不是「在不在取」:首载无行 ⇒ 不出;重取期间旧行在手 ⇒ 照常出", () => {
    // 首载:计数 > 0 但一行都没拿到 ⇒ 不出计划卡(锚点还没有,不编一个)
    expect(
      streamCardsOf(input({ works: { data: [], loading: true, error: null }, unconfirmedCount: 3 })).filter((c) => c.kind === "plan"),
    ).toEqual([]);
    // 重取(useLoad 保留旧数据):行在手 ⇒ 照常出卡 —— 按 loading 拦会让卡在
    // 每次 WS revision bump 时闪没(变异自检抓出来的判据修正)。
    expect(
      streamCardsOf(input({ works: { data: [work({ confirmedAt: null })], loading: true, error: null }, unconfirmedCount: 3 })).map((c) => c.kind),
    ).toContain("plan");
  });

  it("收口提议(intent=close)与普通提问同为 question 卡(渲染层按 intent 分叉)", () => {
    const cards = streamCardsOf(
      input({
        // 清掉默认夹具里的验收/裁决卡 —— 本条只看提问这一类。
        detail: { detail: null, loading: false, error: null },
        questions: { data: [question({ intent: "close" })], closedProjectQuestions: [], answered: [], loading: false, error: null },
      }),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.kind).toBe("question");
  });

  it("已收口项目的提问只数不渲染:那批经同一道筛进不来(2026-10-07 纪律不变)", () => {
    // 项目 p1 已收口 ⇒ 它的提问在 closedProjectQuestions(带坐标),不在 data 里。
    // 判据:同一道筛(scopeClientQuestions)保证它们出不了卡 —— 想渲染也拿不到。
    const cards = streamCardsOf(
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
    expect(cards.filter((c) => c.kind === "question")).toEqual([]);
  });

  it("plan-confirmed 按 confirmedAt 分批:同一毫秒一批,一条事实行", () => {
    const cards = streamCardsOf(
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
    const confirmed = cards.filter((c) => c.kind === "plan-confirmed");
    expect(confirmed).toHaveLength(2); // 两个批次时刻,不是三条工作项
    expect(confirmed.map((c) => (c.kind === "plan-confirmed" ? c.count : 0)).sort()).toEqual([1, 2]);
  });
});

describe("mergeStream · 归并", () => {
  it("按锚定时刻归并排序;同一时刻轮在前(稳定)", () => {
    const items = mergeStream(
      [turn("t_early", 1_700_000_100_000), turn("t_late", 1_700_000_300_000)].map((t) => ({ turn: t })),
      streamCardsOf(input()),
    );
    const kinds = items.map((i) => (i.kind === "turn" ? `turn:${i.turn.id}` : `card:${i.card.kind}`));
    expect(kinds).toEqual([
      "card:verdict", // 50s
      "turn:t_early", // 100s
      "card:acceptance", // 100s —— 与轮并列,轮在前
      "card:question", // 200s
      "turn:t_late", // 300s
      "card:answered", // 300s —— 与轮并列,轮在前
    ]);
  });

  it("流 key 稳定且互不相同(同类同实体共享 key 会复用错 DOM)", () => {
    const cards = streamCardsOf(input());
    const keys = cards.map(streamCardKey);
    expect(new Set(keys).size).toBe(keys.length);
    // 同一交付物的两次裁决是两行事实,key 按 (artifact, 时刻) 区分
    const k1 = streamCardKey({ kind: "verdict", at: 1, artifactId: "a", title: "t", verdict: "accept", note: null });
    const k2 = streamCardKey({ kind: "verdict", at: 2, artifactId: "a", title: "t", verdict: "reject", note: null });
    expect(k1).not.toBe(k2);
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

// ── 渲染:可操作卡 vs 塌缩事实行 ─────────────────────────────────

describe("StreamCardView · 渲染", () => {
  it("验收卡 = 实体卡 + 两个动作(接受/要改),标题与交付时刻在场", () => {
    const html = renderCard({ kind: "acceptance", at: 1, a: acceptance() });
    expect(html).toContain("最终交付物");
    expect(html).toContain(">接受<");
    expect(html).toContain(">要改<");
    expect(html).toContain("等你验收");
  });

  it("提问卡复用 ClientQuestionCard(问题 + 选项 + 提交),收口提议分叉照旧", () => {
    const html = renderCard({ kind: "question", at: 1, q: question() });
    expect(html).toContain("现金账户档位选哪个?");
    expect(html).toContain("PDT 档");
    expect(html).toContain("提交答案");
    const close = renderCard({ kind: "question", at: 1, q: question({ intent: "close" }) });
    expect(close).toContain("同意收口");
    expect(close).toContain("先不收");
  });

  it("塌缩行:已答复(已处置)落 decision 工件;未处置 = 整理中(F3 窗口)", () => {
    const done = renderCard({ kind: "answered", at: 1, id: "q_1", question: "现金账户档位选哪个?", consumed: true });
    expect(done).toContain("已落 decision 工件");
    expect(done).not.toContain("提交答案");
    const pending = renderCard({ kind: "answered", at: 1, id: "q_1", question: "现金账户档位选哪个?", consumed: false });
    expect(pending).toContain("整理中");
  });

  it("裁决塌缩行带结论与附言;计划确认塌缩行带条数", () => {
    const v = renderCard({ kind: "verdict", at: 1, artifactId: "a", title: "最终交付物", verdict: "reject", note: "数据源错了" });
    expect(v).toContain("要改");
    expect(v).toContain("数据源错了");
    const p = renderCard({ kind: "plan-confirmed", at: 1, count: 4 });
    expect(p).toContain("已确认开工 · 4 条");
    expect(p).not.toContain("确认开工</button>");
  });

  it("计划卡 = 确认开工入口(需要 plan 上下文;没有上下文不渲染)", () => {
    const plan: PlanCardContext = {
      projectId: "p1",
      goal: "做一个量化平台",
      acceptanceCriteria: ["能跑"],
      works: { data: [work()], loading: false, error: null },
      onConfirmed: () => {},
    };
    const html = renderCard({ kind: "plan", at: 1 }, plan);
    expect(html).toContain("等你确认开工");
    expect(html).toContain("确认开工");
    expect(renderCard({ kind: "plan", at: 1 }, null)).toBe("");
  });
});

describe("ConversationStream · 轮与卡同一条流", () => {
  it("轮与卡按锚定时刻交错渲染;读不到行在流尾", () => {
    const items = mergeStream(
      [turn("t_1", 1_700_000_100_000)].map((t) => ({ turn: t })),
      streamCardsOf(input()),
    );
    const html = renderToStaticMarkup(
      createElement(ConversationStream, {
        history: items,
        streaming: [],
        hiddenNote: null,
        cardsUnavailable: "表态清单读不到(项目详情)—— 稍后自动重试",
        plan: null,
      }),
    );
    const iMsg = html.indexOf("消息 t_1");
    const iAcc = html.indexOf("最终交付物");
    expect(iMsg).toBeGreaterThan(-1);
    expect(iAcc).toBeGreaterThan(-1);
    // 交付(100s)在轮(100s)之后(并列轮在前),提问(200s)在更后
    const iQ = html.indexOf("现金账户档位选哪个?");
    expect(iAcc).toBeGreaterThan(iMsg);
    expect(iQ).toBeGreaterThan(iAcc);
    expect(html).toContain("表态清单读不到");
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

describe("落点哨兵 · v5 判据变更", () => {
  it("右栏收件箱两个文件已退役,不许复活", () => {
    expect(existsSync(join(WEB_SRC, "components/shell/ChatRightRail.tsx"))).toBe(false);
    expect(existsSync(join(WEB_SRC, "components/client/Inbox.tsx"))).toBe(false);
  });

  it("旧 dock 的名字不许在 web/src 里回来(剥注释后)", () => {
    const chat = source("components/chat/ChatSurface.tsx");
    const app = source("App.tsx");
    for (const src of [chat, app]) {
      expect(src).not.toContain("AcceptanceDock");
      expect(src).not.toContain("ClientQuestionDock");
      expect(src).not.toContain("InboxPanel");
      expect(src).not.toContain("ChatRightRail");
    }
  });

  it("ChatSurface 真的在算卡并传给 MessageList;计划 band 挂载点已退场", () => {
    const chat = source("components/chat/ChatSurface.tsx");
    expect(chat).toContain("streamCardsOf(");
    expect(chat).toContain("cardsUnavailableOf(");
    expect(chat).toMatch(/<MessageList\s+cards=\{cards\}/);
    expect(chat).not.toMatch(/<PlanConfirmCard/); // band 形态退场;卡身由 StreamCards 渲染
  });

  it("MessageList 真的在归并(不是把卡渲染成另一条带)", () => {
    const list = source("components/chat/MessageList.tsx");
    expect(list).toContain("mergeStream(");
    expect(list).toContain("StreamCardView");
  });

  it("对话页头部仍有「详情」入口(项目页签退场后的常驻路径,判据随迁)", () => {
    expect(source("components/chat/ChatSurface.tsx")).toContain('href="#/project"');
  });
});
