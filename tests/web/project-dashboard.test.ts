/**
 * 项目页的**仪表盘** —— 判据(`lib/dashboard.ts`)+ 接线
 *
 * ── 测什么 ────────────────────────────────────────────────────────
 *
 * 1. **「最要紧」是排序,不是评价** —— 档位顺序**写死在一处**(`PRIORITY`),
 *    每一档都有**该去的地方**(能点过去),没有地址的档位必须**明说它没有**。
 * 2. **读不到 ≠ 没事** —— 运行态读不到时,第一档是 `unreadable`,
 *    **不是** `none`。这一条与 `ProjectLiveView.runtime = "unavailable"`、
 *    `DataState` 的四态同源:「不知道」与「没有」在屏幕上长得一模一样。
 * 3. **计数不许自己数** —— 数字读服务端算好的 `detail.counts`;
 *    自己数一遍会与左栏徽标漂开,而**两个地方显示不同的数字**是最难查的一类病。
 * 4. **一个实体只渲染一处** —— 项目页**不再**渲染工作项列表
 *    (它与工作项页各渲染一遍同一个实体,而两处各渲染一遍的地方,**关联必然丢**)。
 *
 * ⚠️ 判据里刻意**没有**「排版好不好看」:那不是判据,是审美。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRIORITY, countCards, nextThing } from "../../web/src/lib/dashboard";
import type { DashboardFacts, NextThingKey } from "../../web/src/lib/dashboard";
import { DashboardCards } from "../../web/src/components/dashboard/DashboardCards";
import { toHash } from "../../web/src/lib/route";
import type { BlockerView, ProjectLiveView, WorkView } from "../../shared/types/platform";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, "..", "..", rel), "utf8");

const projectDetail = read("web/src/routes/ProjectDetail.tsx");
const dashboard = read("web/src/lib/dashboard.ts");
const chatRightRail = read("web/src/components/shell/ChatRightRail.tsx");
const agentPanel = read("web/src/components/shell/AgentPanel.tsx");
const acceptanceDock = read("web/src/components/client/AcceptanceDock.tsx");
const clientQuestionDock = read("web/src/components/client/ClientQuestionDock.tsx");

/** 去掉注释再找 —— 注释里写着反面教材会让 grep 命中假阳性。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── 夹具 ──────────────────────────────────────────────────────────

const work = (over: Partial<WorkView> = {}): WorkView =>
  ({
    id: "w_1",
    projectId: "p_1",
    title: "写调研",
    goal: "写调研",
    status: "in_progress",
    assigneeAgentId: "a_9",
    assigneeName: "研究员",
    parentWorkId: null,
    dependsOn: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }) as WorkView;

const blocker = (over: Partial<BlockerView> = {}): BlockerView =>
  ({
    id: "b_1",
    projectId: "p_1",
    title: "等第三方接口",
    detail: "",
    severity: "high",
    status: "open",
    raisedByAgentId: "a_9",
    blockedWorkIds: ["w_1"],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }) as BlockerView;

const live = (over: Partial<ProjectLiveView> = {}): ProjectLiveView =>
  ({
    runtime: "ok",
    runningTurns: 0,
    ...over,
  }) as ProjectLiveView;

const facts = (over: Partial<DashboardFacts> = {}): DashboardFacts => ({
  projectId: "p_1",
  works: { data: [], loading: false, error: null },
  blockers: { data: [], loading: false, error: null },
  pendingQuestions: { count: 0, loading: false, error: null },
  pendingAcceptance: { count: 0, loading: false, error: null },
  live: live(),
  liveState: { loading: false, error: null },
  ...over,
});

// ── 判据 ──────────────────────────────────────────────────────────

describe("「现在最要紧的一件事」:档位顺序", () => {
  it("档位集合是闭合的 —— 顺序写死在一处", () => {
    expect([...PRIORITY]).toEqual([
      "next_unreadable",
      "next_high_blocker",
      "next_waiting_client",
      "next_waiting_acceptance",
      "next_stalled_work",
      "next_running",
      "next_none",
    ]);
  });

  it("① 运行态读不到 ⇒ 第一档是「读不到」,绝不是「没有待办」", () => {
    const t = nextThing(facts({ live: null }));
    expect(t.key).toBe("next_unreadable");
    // ⚠️ 负样本:「一切正常」是这里最容易写出来的一句**自信的假话**。
    expect(t.key).not.toBe("next_none");
    expect(t.label).toContain("读不到");
    // 读不到时**不许**给一个地址 —— 指到某处去等于说「那里有你该看的东西」。
    expect(t.to).toBeNull();
  });

  it("①b 运行态明确是 unavailable(不是 null)⇒ 同样判「读不到」", () => {
    const t = nextThing(facts({ live: live({ runtime: "unavailable" }) }));
    expect(t.key).toBe("next_unreadable");
  });

  it("② 高危阻塞 ⇒ 排第一,而且带地址", () => {
    const t = nextThing(
      facts({
        blockers: { data: [blocker({ severity: "critical" })], loading: false, error: null },
        pendingQuestions: { count: 3, loading: false, error: null },
      }),
    );
    expect(t.key).toBe("next_high_blocker");
    // ⚠️ 地址必须带**项目 id** —— 阻塞只存在于某一个项目里,
    // 不带 id 的地址是「半个地址」:它只在「你正好在看那个项目」时成立。
    expect(t.to).not.toBeNull();
    expect(toHash(t.to!)).toContain("project=p_1");
    expect(toHash(t.to!)).toContain("blocker=b_1");
  });

  it("②b 低危阻塞**不**触发这一档(严重度是判据的一部分)", () => {
    const t = nextThing(
      facts({ blockers: { data: [blocker({ severity: "low" })], loading: false, error: null } }),
    );
    expect(t.key).not.toBe("next_high_blocker");
  });

  it("②c 已解决的阻塞**不**触发这一档", () => {
    const t = nextThing(
      facts({ blockers: { data: [blocker({ status: "resolved" })], loading: false, error: null } }),
    );
    expect(t.key).not.toBe("next_high_blocker");
  });

  it("③ 等甲方答 ⇒ 排在「停了的工作项」之前(球在甲方那边)", () => {
    const t = nextThing(
      facts({
        pendingQuestions: { count: 2, loading: false, error: null },
        works: { data: [work({ status: "failed" })], loading: false, error: null },
      }),
    );
    expect(t.key).toBe("next_waiting_client");
  });

  it("④ 等甲方验收", () => {
    const t = nextThing(
      facts({ pendingAcceptance: { count: 1, loading: false, error: null } }),
    );
    expect(t.key).toBe("next_waiting_acceptance");
  });

  it("⑤ 停了的工作项(失败)⇒ 这一档说「平台会自己重划范围」", () => {
    const t = nextThing(
      facts({ works: { data: [work({ status: "failed" })], loading: false, error: null } }),
    );
    expect(t.key).toBe("next_stalled_work");
    expect(t.action).toContain("不需要你动作");
  });

  it("⑥ 正在跑 ⇒ 有这一档,但明说「不需要你动作」", () => {
    const t = nextThing(facts({ live: live({ runningTurns: 2 }) }));
    expect(t.key).toBe("next_running");
    expect(t.action).toContain("不需要你动作");
  });

  it("⑦ 真的没有 ⇒ 明说「此刻没有等你动作的事」,不许编一件出来充数", () => {
    const t = nextThing(facts());
    expect(t.key).toBe("next_none");
    expect(t.label).toContain("没有");
    expect(t.to).toBeNull();
  });

  it("⚠️ 每一档都要说清「要不要你动作」", () => {
    const keys: NextThingKey[] = [...PRIORITY];
    for (const key of keys) {
      const t = nextThing(factsFor(key));
      expect(t.action.length).toBeGreaterThan(0);
      expect(t.why.length).toBeGreaterThan(0);
    }
  });
});

/** 造出「恰好落在某一档」的事实。 */
function factsFor(key: NextThingKey): DashboardFacts {
  switch (key) {
    case "next_unreadable":
      return facts({ live: null });
    case "next_high_blocker":
      return facts({ blockers: { data: [blocker()], loading: false, error: null } });
    case "next_waiting_client":
      return facts({ pendingQuestions: { count: 1, loading: false, error: null } });
    case "next_waiting_acceptance":
      return facts({ pendingAcceptance: { count: 1, loading: false, error: null } });
    case "next_stalled_work":
      return facts({ works: { data: [work({ status: "failed" })], loading: false, error: null } });
    case "next_running":
      return facts({ live: live({ runningTurns: 1 }) });
    case "next_none":
      return facts();
  }
}

describe("计数卡", () => {
  it("每张卡都带一个能解析的地址", () => {
    const cards = countCards(
      {
        works: 5,
        openWorks: 2,
        artifacts: 9,
        pendingQuestions: 1,
        openBlockers: 0,
        pendingAcceptance: 0,
      },
      "p_1",
    );
    for (const c of cards) {
      expect(c.to).not.toBeNull();
      const href = toHash(c.to!);
      expect(href.startsWith("#/")).toBe(true);
    }
  });

  it("⚠️ 阻塞那张卡带项目 id —— 阻塞只存在于某一个项目里", () => {
    const cards = countCards(
      {
        works: 0,
        openWorks: 0,
        artifacts: 0,
        pendingQuestions: 0,
        openBlockers: 1,
        pendingAcceptance: 0,
      },
      "p_1",
    );
    const b = cards.find((c) => c.key === "blockers");
    expect(b).toBeDefined();
    expect(toHash(b!.to!)).toContain("project=p_1");
  });
});

describe("排版:卡片是真链接", () => {
  it("链接是真 <a href> —— 右键复制 / 中键 / 后退三件全靠它", () => {
    const cards = countCards(
      {
        works: 5,
        openWorks: 2,
        artifacts: 9,
        pendingQuestions: 1,
        openBlockers: 0,
        pendingAcceptance: 0,
      },
      "p_1",
    );
    const html = renderToStaticMarkup(
      createElement(DashboardCards, { cards, next: nextThing(facts()) }),
    );
    expect(html).toContain("<a ");
    expect(html).toContain('href="#/works"');
    // ⚠️ 负样本:onClick 改 hash 会让「右键复制地址」消失,而页面看起来一模一样。
    expect(html).not.toContain("onclick");
  });
});

// ── 接线(源码级)────────────────────────────────────────────────────

describe("接线:项目页降级为仪表盘", () => {
  it("⚠️ 项目页**不再**渲染工作项列表 —— 一个实体只渲染一处", () => {
    // 负样本。改版前这里是 `detail.works.map(...)`。
    expect(stripComments(projectDetail)).not.toContain("detail.works.map(");
  });

  it("项目页挂了仪表盘", () => {
    expect(projectDetail).toContain("<DashboardCards");
  });

  it("⚠️ 计数读服务端算好的 detail.counts —— 不许自己数一遍", () => {
    // 自己数一遍会与左栏徽标漂开,而「两个地方显示不同的数字」是最难查的一类病。
    expect(stripComments(projectDetail)).toContain("detail?.counts.works");
    expect(stripComments(projectDetail)).toContain("detail?.counts.pendingAcceptance");
  });

  it("⚠️ 档位名只允许出现在 lib/dashboard.ts —— 页面不许自己判「哪件最要紧」", () => {
    const page = stripComments(projectDetail);
    // ⚠️ 档位名带 `next_` 前缀是有意的:**`orgState.ts` 的派生状态里已经有
    // `waiting_client` / `unreadable` 两个同名键**(那是「组织运行态」那一套)。
    // 两套**不同的**状态机用同一批词 ⇒ grep 一次出来两个意思 ⇒ 前缀把它们隔开。
    for (const key of PRIORITY) {
      expect(page).not.toContain(`"${key}"`);
    }
    // 而「怎么算」只能有一处:页面调 `nextThing(`。
    expect(page).toContain("nextThing(");
  });

  it("⚠️ 右栏四个文件里 useProjectDetail( 仍只出现一次", () => {
    // 三个 hook 实例 = 三份 loading = 「一处写加载中、另一处写没有」。
    const files = [chatRightRail, agentPanel, acceptanceDock, clientQuestionDock];
    const count = files.filter((f) => f.includes("useProjectDetail(")).length;
    expect(count).toBe(1);
  });
});
