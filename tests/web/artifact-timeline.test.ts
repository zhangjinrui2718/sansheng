/**
 * 工件页 · **推进图(时间轴 × 泳道)** 的渲染判据(2026-10-07)
 *
 * ── 为什么这份测试长这样 ────────────────────────────────────────
 *
 * 用户要的主视图是「横轴是时间,纵轴是工件的类型,即使没在 dag 上的工件也可以放在
 * 这个图表里面」,外加「把工作项的完成和工件的产出也标在这个图表里面」。这张图最
 * 容易出的两种错**在截图里都看不出来**:
 *
 *   ① **漏点 / 漏条**(某件工件没画、某条工作项没画)—— 图上少一个记号,看起来只是
 *      「这个项目就这么多」。所以夹具照抄真机形状(**20 件 = 14 挂环节 + 6 决策**),
 *      断言是**计数**:`data-mark-id` 恰好 20 个、`data-span-id` 恰好 5 个、
 *      6 件不挂环节的点一个都不少。
 *   ② **把「未收口」画成「已收口」,或在读不到运行态时点亮呼吸点** —— 那是在替平台
 *      宣布「这条做完了 / 此刻有人在跑」。所以端点语义(`data-open`)与「读不到 ⇒
 *      一个 `.ss-live-dot` 都没有」都是**成对**的正负样本。
 *
 * ── 断言落在结构性标记上,不靠 class 名猜 ───────────────────────
 *
 * `data-mark-id` / `data-span-id` / `data-open` / `data-selected` /
 * `data-milestone-id` / `data-milestone-span` / `data-now-line` / `tabindex` /
 * `role` 是渲染层专门为测试留的钩子(见 `web/src/routes/Artifacts.tsx` 文件头)。
 * 属性顺序无关:`tagsWith` 先取「含这个属性的开标签」整段,再由 `attrOf` 读值。
 *
 * ⚠️ **「一个 `.ss-live-dot` 都没有」落在新的主视图(① 与它的图例)上,不是整页**:
 * ⑤ 旧 DAG 的图例里有一个常驻的 `.ss-live-dot`(「点 = 此刻在跑」),它的节点上还有
 * 一个**灰的、不动的** unknown 点 —— 那是旧组件的信息,而 ⑤ 被要求「一个信息都不删」,
 * 所以不能为了让全页出现 0 个类名而删它们。这里另有一条测试把整页的情况钉清楚:
 * **运行态读不到时,`.ss-live-dot` 只允许出现在 ⑤ 那一块**(新主视图 0 个)。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactView, WorkView } from "@shared/types/platform";
import {
  ArtifactsScreen,
  ProgressTimeline,
  TimelineLegend,
  type DagLive,
} from "@/routes/Artifacts";
import { layoutTimeline } from "@/lib/timeline";

// ── 夹具(不连真库:字段全自己造)────────────────────────────────

const T0 = Date.parse("2026-10-05T16:54:00+08:00");
const MIN = 60_000;
/** 「此刻」= 那份数据收尾之后 9 分钟(落在时间域内)。 */
const NOW = T0 + 40 * MIN;
/** 域外的一个「此刻」—— 钉「nowX 为 null 时不画此刻线」。 */
const FAR_NOW = T0 + 3 * 24 * 60 * MIN;

function work(id: string, over: Partial<WorkView> = {}): WorkView {
  return {
    id,
    projectId: "p1",
    parentWorkId: null,
    title: `环节 ${id}`,
    goal: "",
    status: "done",
    assigneeAgentId: "wk",
    assigneeName: "工程师",
    createdAt: T0,
    updatedAt: T0 + 30 * MIN,
    dependsOn: [],
    ...over,
  };
}

function art(
  id: string,
  kind: ArtifactView["kind"],
  at: number,
  workId: string | null,
  title: string,
  over: Partial<ArtifactView> = {},
): ArtifactView {
  return {
    id,
    projectId: "p1",
    kind,
    status: "open",
    title,
    body: "",
    authorAgentId: "wk",
    authorName: "工程师",
    createdAt: at,
    updatedAt: at,
    links: [],
    workId,
    ...over,
  };
}

/**
 * 5 条工作项:**3 条终态**(根 / 甲 / 乙)+ **2 条未终态**(丙 `in_progress`、
 * 整合 `blocked`)。终态与未终态都要有,否则「开口端 / 封口端」只有一边可断言。
 */
const W_ROOT = work("w-root", { title: "根环节", createdAt: T0, updatedAt: T0 + 31 * MIN });
const W_A = work("w-a", { title: "甲环节", createdAt: T0 + 1 * MIN, updatedAt: T0 + 20 * MIN });
const W_B = work("w-b", { title: "乙环节", createdAt: T0 + 1 * MIN, updatedAt: T0 + 29 * MIN });
const W_C = work("w-c", {
  title: "丙环节",
  status: "in_progress",
  createdAt: T0 + 3 * MIN,
  updatedAt: T0 + 20 * MIN,
});
const W_INT = work("w-int", {
  title: "整合环节",
  status: "blocked",
  assigneeAgentId: "qa",
  assigneeName: "质检",
  createdAt: T0 + 5 * MIN,
  updatedAt: T0 + 29 * MIN,
});
const WORKS = [W_ROOT, W_A, W_B, W_C, W_INT];

/** 6 件 `workId === null` 的决策 —— 这正是「没在 dag 上的工件也要放进来」那一条。 */
const DECISION_IDS = ["d0", "d1", "d2", "d3", "d4", "d5"];

/**
 * **20 件工件 = 14 挂环节 + 6 决策**(照抄真机形状:evidence 6 / review_finding 7 /
 * deliverable 1 / decision 6)。
 *
 * `r7` 给了 `status: "accepted"` —— 「状态不是 open 的点要有一圈可区分的描边」
 * 需要一条正样本(负样本是全部 `open` 的那些)。
 */
const ARTS: ArtifactView[] = [
  art("e1", "evidence", T0 + 2 * MIN, "w-a", "甲证据一"),
  art("e2", "evidence", T0 + 3 * MIN, "w-a", "甲证据二"),
  art("e3", "evidence", T0 + 4 * MIN, "w-b", "乙证据三"),
  art("e4", "evidence", T0 + 8 * MIN, "w-c", "丙证据四"),
  art("e5", "evidence", T0 + 12 * MIN, "w-int", "整合证据五"),
  art("e6", "evidence", T0 + 13 * MIN, "w-int", "整合证据六"),
  art("r1", "review_finding", T0 + 10 * MIN, "w-a", "甲评审一"),
  art("r2", "review_finding", T0 + 11 * MIN, "w-a", "甲评审二"),
  art("r3", "review_finding", T0 + 15 * MIN, "w-b", "乙评审三"),
  art("r4", "review_finding", T0 + 16 * MIN, "w-b", "乙评审四"),
  art("r5", "review_finding", T0 + 18 * MIN, "w-c", "丙评审五"),
  art("r6", "review_finding", T0 + 24 * MIN, "w-int", "整合评审六"),
  art("r7", "review_finding", T0 + 26 * MIN, "w-root", "根评审七", { status: "accepted" }),
  art("dl", "deliverable", T0 + 25 * MIN, "w-root", "交付物"),
  art("d0", "decision", T0 + 1 * MIN, null, "决策零"),
  art("d1", "decision", T0 + 2 * MIN, null, "决策一"),
  art("d2", "decision", T0 + 3 * MIN, null, "决策二"),
  art("d3", "decision", T0 + 4 * MIN, null, "决策三"),
  art("d4", "decision", T0 + 5 * MIN, null, "决策四"),
  art("d5", "decision", T0 + 6 * MIN, null, "决策五"),
];

const NO_LIVE = null;
const HOST_IDLE: DagLive = {
  runtime: "host",
  agents: [
    { agentId: "wk", turn: null },
    { agentId: "qa", turn: null },
  ],
};
/** 工程师(`wk`,就是丙环节的负责人)此刻有回合在跑 ⇒ 恰好一条工作项点亮。 */
const HOST_RUNNING: DagLive = {
  runtime: "host",
  agents: [
    { agentId: "wk", turn: { elapsedMs: 1000 } },
    { agentId: "qa", turn: null },
  ],
};
const UNAVAILABLE: DagLive = { runtime: "unavailable", agents: [] };

// ── 渲染与解析小工具 ────────────────────────────────────────────

const countOf = (html: string, re: RegExp): number => (html.match(re) ?? []).length;

/** 取出所有「含某个属性的开标签」(属性顺序无关 —— 不靠「它写在第几位」断言)。 */
function tagsWith(html: string, attr: string): string[] {
  return html.match(new RegExp(`<[a-zA-Z][^>]*\\b${attr}[^>]*>`, "g")) ?? [];
}

function attrOf(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m === null ? null : m[1]!;
}

/** `data-x="id"` → 该 id 对应的整段开标签。 */
function tagById(html: string, attr: string, id: string): string {
  const tag = tagsWith(html, attr).find((t) => attrOf(t, attr) === id);
  expect(tag, `渲染里没有 ${attr}="${id}" 的元素`).toBeDefined();
  return tag!;
}

type TimelineProps = Parameters<typeof ProgressTimeline>[0];
const timelineProps = (over: Partial<TimelineProps> = {}): TimelineProps => ({
  works: WORKS,
  artifacts: ARTS,
  live: NO_LIVE,
  now: NOW,
  selectedId: null,
  onSelectWork: vi.fn(),
  onOpenArtifact: vi.fn(),
  ...over,
});
const renderTimeline = (over: Partial<TimelineProps> = {}): string =>
  renderToStaticMarkup(createElement(ProgressTimeline, timelineProps(over)));

type ScreenProps = Parameters<typeof ArtifactsScreen>[0];
const screenProps = (over: Partial<ScreenProps> = {}): ScreenProps => ({
  works: WORKS,
  artifacts: ARTS,
  live: HOST_RUNNING,
  now: NOW,
  picked: undefined,
  onPick: vi.fn(),
  openId: null,
  onToggleDetail: vi.fn(),
  ...over,
});
const renderScreen = (over: Partial<ScreenProps> = {}): string =>
  renderToStaticMarkup(createElement(ArtifactsScreen, screenProps(over)));

/** ⑤ 旧 DAG 那一段的起点(它自己的 `<details>`;之前的一切都属于 ①~④)。 */
const dagStart = (html: string): number => html.indexOf('<details class="ss-disclosure"');

// ── 判据 1:每件工件恰好一个点(含不挂环节的)────────────────────

describe("① 工件 = 点:20 件恰好 20 个,6 件不挂环节的也在图上", () => {
  it("`data-mark-id` 恰好 20 个,且不存在两个点同 id(负样本)", () => {
    const html = renderTimeline();
    const tags = tagsWith(html, "data-mark-id");
    const ids = tags.map((t) => attrOf(t, "data-mark-id")!);
    expect(ids.length, "图上少画/多画了工件").toBe(ARTS.length);
    expect(ids.length).toBe(20);
    expect(new Set(ids).size, "同一个工件画了两次").toBe(20);
    // 负样本:只画了挂环节的 14 件 —— 那正是用户要修的那种漏
    expect(ids.length).not.toBe(14);
  });

  it("6 件 `workId === null` 的决策**照样在图上**(这正是用户要的那一条)", () => {
    const html = renderTimeline();
    const ids = tagsWith(html, "data-mark-id").map((t) => attrOf(t, "data-mark-id")!);
    for (const d of DECISION_IDS) expect(ids, `决策 ${d} 没被画出来`).toContain(d);
    // 而且它们的话要说对:不挂在任何环节上 ≠ 还没归位
    expect(html).toContain("不挂在任何环节上");
    expect(html).not.toContain("还没归位");
  });

  it("⚠️ 页面不许再说「无环节的工件没画在图上」(那是 DAG 时代的旧话)", () => {
    // 这条来自用户的追问:「不挂在任何环节上的工件 6 —— 这些工件是不是已经在图上面了?」
    // 在换成时间轴之前,那句话是**对的**(旧 DAG 只画挂上环节的工件);换图之后
    // 它变成了**假话**,而它偏偏写在页面正文里(正是本项目最忌的那种「屏幕上说着
    // 与事实相反的话,而看起来完全正常」)。所以钉成一条负样本。
    const full = renderScreen();
    expect(full, "页面还在说无环节的工件没画出来").not.toContain("不出现在上面的流程图上");
    expect(full, "改成了「已经在图上」就该看得见这句话").toContain("已经在上面那张图上");
    // 正样本:同一批工件既有图上的点,也有清单里的一行(两处都对得上,不是二选一)
    const ids = tagsWith(full, "data-mark-id").map((t) => attrOf(t, "data-mark-id")!);
    for (const d of DECISION_IDS) expect(ids).toContain(d);
    expect(full).toContain("决策零");
    // 清单**默认收起**(不再与图重复占版面),但内容仍在 DOM 里(可展开)
    expect(full).toContain("展开清单(6 条 · 可逐条看详情)");
    expect(/<details[^>]*\sopen/.test(full), "清单默认必须是收起的").toBe(false);
  });

  it("状态不是 `open` 的点有一圈可区分的描边;`open` 的没有(负样本)", () => {
    const html = renderTimeline();
    const accepted = tagById(html, "data-mark-id", "r7"); // status: accepted
    const stillOpen = tagById(html, "data-mark-id", "e1"); // status: open
    expect(accepted, "已定性的点与有效的点长得一样").toContain('stroke-width="1.5"');
    expect(stillOpen, "有效的点被加上了描边").not.toContain('stroke-width="1.5"');
  });

  it("点落在它自己 kind 的那一道上(纵坐标与布局逐个对上)", () => {
    const html = renderTimeline();
    const tl = layoutTimeline({ works: WORKS, artifacts: ARTS, now: NOW, live: NO_LIVE });
    for (const mark of tl.marks) {
      const tag = tagById(html, "data-mark-id", mark.id);
      expect(Number(attrOf(tag, "cy")), `${mark.id} 没落在自己那道的中线上`).toBe(mark.y);
    }
  });
});

// ── 判据 2:每条工作项恰好一条跨度条,端点语义成对 ────────────────

describe("② 工作项 = 跨度条:5 条,终态封口 / 未终态开口", () => {
  it("`data-span-id` 恰好 5 个,与 `works.length` 相等", () => {
    const html = renderTimeline();
    const tags = tagsWith(html, "data-span-id");
    expect(tags.length, "每条工作项必须恰好一条条").toBe(WORKS.length);
    expect(new Set(tags.map((t) => attrOf(t, "data-span-id"))).size).toBe(WORKS.length);
  });

  it("终态那条 `data-open=\"false\"`;未终态那条 `data-open=\"true\"`(正负成对)", () => {
    const html = renderTimeline();
    const openOf = (id: string): string | null =>
      attrOf(tagById(html, "data-span-id", id), "data-open");
    // 终态(done)⇒ 封口
    expect(openOf("w-root")).toBe("false");
    expect(openOf("w-root"), "终态被画成了开口").not.toBe("true");
    // 未终态(in_progress / blocked)⇒ 开口
    expect(openOf("w-c")).toBe("true");
    expect(openOf("w-int")).toBe("true");
    expect(openOf("w-c"), "未终态被画成了封口 —— 等于替平台宣布「做完了」").not.toBe("false");
    // 计数也是成对的:2 开口 + 3 封口
    expect(countOf(html, /data-open="true"/g)).toBe(2);
    expect(countOf(html, /data-open="false"/g)).toBe(3);
  });

  it("`data-open` 与布局给的 `open` 逐个一致(渲染层没有自己另算一套)", () => {
    const html = renderTimeline();
    const tl = layoutTimeline({ works: WORKS, artifacts: ARTS, now: NOW, live: NO_LIVE });
    for (const span of tl.spans) {
      const tag = tagById(html, "data-span-id", span.id);
      expect(attrOf(tag, "data-open"), `${span.id} 的端点语义与布局不一致`).toBe(
        span.open ? "true" : "false",
      );
    }
  });

  it("端点的话照实说:「收口(最后一次变更…)」/「未收口(还在推进…)」", () => {
    const html = renderTimeline();
    expect(html).toContain("收口(最后一次变更,不是精确完成时刻)");
    expect(html).toContain("未收口(还在推进,右端 = 此刻)");
    // 不许编一个精确完成时刻
    expect(html).not.toContain("完成时刻:");
  });
});

// ── 判据 3:产出刻度 = 该环节的工件数 ────────────────────────────

describe("③ 条上的刻度:某条环节的刻度数 = 它的工件数", () => {
  /** spanId → 它的刻度(工件 id)列表,顺序即渲染顺序。 */
  function milestonesBySpan(html: string): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const tag of tagsWith(html, "data-milestone-id")) {
      const ms = attrOf(tag, "data-milestone-id")!;
      const span = attrOf(tag, "data-milestone-span")!;
      m.set(span, [...(m.get(span) ?? []), ms]);
    }
    return m;
  }

  it("每条环节的刻度就是它自己的那些工件(顺序按时间)", () => {
    const ms = milestonesBySpan(renderTimeline());
    expect(ms.get("w-a")).toEqual(["e1", "e2", "r1", "r2"]);
    expect(ms.get("w-b")).toEqual(["e3", "r3", "r4"]);
    expect(ms.get("w-c")).toEqual(["e4", "r5"]);
    expect(ms.get("w-int")).toEqual(["e5", "e6", "r6"]);
    expect(ms.get("w-root")).toEqual(["dl", "r7"]);
  });

  it("负样本:乙的工件 id 不许出现在甲的刻度里(反之亦然)", () => {
    const ms = milestonesBySpan(renderTimeline());
    expect(ms.get("w-a")).not.toContain("r3");
    expect(ms.get("w-a")).not.toContain("e3");
    expect(ms.get("w-b")).not.toContain("r1");
  });

  it("刻度总数 = 挂了环节的工件数(14);不挂环节的 6 件一条刻度都不该有", () => {
    const ms = milestonesBySpan(renderTimeline());
    const all = [...ms.values()].flat();
    expect(all.length).toBe(14);
    for (const d of DECISION_IDS) expect(all, `决策 ${d} 被塞进了某条环节的刻度`).not.toContain(d);
  });
});

// ── 判据 4 / 5:运行态读不到 ⇒ 一个呼吸点都没有 ──────────────────

describe("④ 运行态 `unavailable` / `live === null` ⇒ 新主视图一个 `.ss-live-dot` 都没有", () => {
  it("runtime unavailable ⇒ 0 个呼吸点,而且明说「读不到」", () => {
    const html = renderTimeline({ live: UNAVAILABLE });
    expect(countOf(html, /ss-live-dot/g), "读不到运行态却点亮了呼吸点").toBe(0);
    expect(html, "读不到运行态时没有说实话").toContain("读不到");
  });

  it("负样本:同一份数据 runtime host + 有人在跑 ⇒ 必须有呼吸点", () => {
    const html = renderTimeline({ live: HOST_RUNNING });
    expect(countOf(html, /ss-live-dot/g), "有回合在跑却一个点都没有").toBeGreaterThan(0);
    expect(html, "运行态读得到时不该说「读不到」").not.toContain("读不到");
  });

  it("`live === null`(还没拿到快照)与 unavailable 同处置", () => {
    const html = renderTimeline({ live: NO_LIVE });
    expect(countOf(html, /ss-live-dot/g), "还没拿到快照就点亮了呼吸点").toBe(0);
    expect(html).toContain("读不到");
  });

  it("`TimelineLegend` 是纯 props:那句话说出口,但只在读不到时", () => {
    const on = renderToStaticMarkup(createElement(TimelineLegend, { runtimeUnknown: true }));
    const off = renderToStaticMarkup(createElement(TimelineLegend, { runtimeUnknown: false }));
    expect(on).toContain("读不到");
    expect(on).toContain("一条都没点亮");
    expect(off).not.toContain("读不到");
    expect(off).toContain("横轴 = 时间");
    // 图例本身不许放点(旧 DAG 图例里那个点是它自己的事)
    expect(countOf(off, /ss-live-dot/g)).toBe(0);
  });

  it("整页:读不到运行态时,`.ss-live-dot` **只允许**出现在 ⑤ 旧 DAG 那一块", () => {
    const html = renderScreen({ live: UNAVAILABLE });
    const at = dagStart(html);
    expect(at, "⑤ 的 <details> 不见了 —— 折叠不等于删除").toBeGreaterThan(-1);
    expect(
      countOf(html.slice(0, at), /ss-live-dot/g),
      "新主视图 / 图例 / 面板里出现了点(它们一个都不许有)",
    ).toBe(0);
    // ⑤ 里那些点是旧组件的既有信息(图例 + 灰的 unknown 点),一个都没删
    expect(countOf(html.slice(at), /ss-live-dot/g)).toBeGreaterThan(0);
  });

  it("可点元素键盘可达:每条条、每个点都是 role=button + tabindex=0", () => {
    const html = renderTimeline();
    const interactive = WORKS.length + ARTS.length;
    expect(countOf(html, /role="button"/g)).toBe(interactive);
    expect(countOf(html, /tabindex="0"/g)).toBe(interactive);
  });
});

// ── 判据 6:刻度与「此刻」线 ─────────────────────────────────────

describe("⑥ 刻度渲染出来了;「此刻」线只在读得到运行态且它在域内时出现", () => {
  it("tick 标签至少 2 个(否则横轴读不出时间)", () => {
    const html = renderTimeline({ live: HOST_RUNNING });
    expect(countOf(html, /<title>刻度 /g)).toBeGreaterThanOrEqual(2);
    expect(html, />\d\d:\d\d</, "横轴上一个时刻标签都没有").toBeTruthy();
  });

  it("`data-now-line` 恰好在 host + 域含此刻时出现", () => {
    expect(countOf(renderTimeline({ live: HOST_RUNNING }), /data-now-line/g)).toBe(1);
  });

  it("负样本 1:读不到运行态 ⇒ 不画此刻线(那时连「此刻谁在跑」都不知道)", () => {
    expect(countOf(renderTimeline({ live: UNAVAILABLE }), /data-now-line/g)).toBe(0);
    expect(countOf(renderTimeline({ live: NO_LIVE }), /data-now-line/g)).toBe(0);
  });

  it("负样本 2:读得到运行态但此刻在域外 ⇒ 也不画(线会落在画布外)", () => {
    const html = renderTimeline({ live: HOST_IDLE, now: FAR_NOW });
    expect(countOf(html, /data-now-line/g)).toBe(0);
    // 但图本身照常渲染(不是整块空掉)
    expect(tagsWith(html, "data-span-id").length).toBe(WORKS.length);
  });
});

// ── 判据 7:旧 DAG 还在 DOM 里,但默认折叠 ───────────────────────

describe("⑦ ⑤ 依赖关系图:结构不变,默认折叠", () => {
  it("`class=\"ss-dag-node\"` 的数量仍对得上(折叠 ≠ 删除)", () => {
    const html = renderScreen();
    expect(countOf(html, /class="ss-dag-node"/g), "旧 DAG 的节点被弄丢了").toBe(WORKS.length);
    expect(html).toContain("依赖关系图(分层排布,可能较宽)");
  });

  it("那个 `<details>` 没有 `open`(默认展开就等于把主视图位置又让回去了)", () => {
    const html = renderScreen();
    const at = dagStart(html);
    expect(at).toBeGreaterThan(-1);
    const tagEnd = html.indexOf(">", at);
    const tag = html.slice(at, tagEnd + 1);
    expect(tag).toContain("ss-disclosure");
    expect(tag, "旧 DAG 被默认展开了").not.toMatch(/\sopen(=|\s|>)/);
  });

  it("负样本:整页里没有任何 `<details>` 是展开的(夹具无长 body / 无 goal)", () => {
    const html = renderScreen();
    expect(html).not.toMatch(/<details[^>]*\sopen(=|\s|>)/);
    expect(html).toContain("<details");
  });
});

// ── 判据 8:选中联动(① 与 ② 是同一个选中态)──────────────────────

describe("⑧ 选中联动:① 上选中的那条 = ② 面板显示的那个环节", () => {
  /**
   * ② 面板那一段(`>选中的环节<` → ③ 的标题)。
   *
   * ⚠️ 端点的锚必须带 `>` / `<`:① 的 tooltip 里逐字写着「产出环节:不挂在任何环节上」,
   * 只按那句话切会把切片起点切到 ① 里去(`>不挂在任何环节上的工件<` 才是 ③ 的标题)。
   */
  function panelSection(html: string): string {
    const from = html.indexOf(">选中的环节<");
    const to = html.indexOf(">不挂在任何环节上的工件<");
    expect(from, "② 面板不见了").toBeGreaterThan(-1);
    expect(to, "③ 那一块不见了(夹具里 6 件决策,应该一直在)").toBeGreaterThan(from);
    return html.slice(from, to);
  }

  it("正样本:picked = 甲环节 ⇒ ① 那条 bar 标成 selected,② 出现甲环节与它的工件", () => {
    const html = renderScreen({ picked: "w-a" });
    const bar = tagById(html, "data-span-id", "w-a");
    expect(attrOf(bar, "data-selected"), "① 上选中的不是被选的那个环节").toBe("true");
    expect(attrOf(tagById(html, "data-span-id", "w-b"), "data-selected")).toBe("false");

    const panel = panelSection(html);
    expect(panel).toContain("甲环节");
    expect(panel).toContain("甲证据一");
    expect(panel).toContain("甲评审一");
  });

  it("负样本:乙环节独有的工件标题不许出现在甲的面板里", () => {
    const panel = panelSection(renderScreen({ picked: "w-a" }));
    expect(panel).not.toContain("乙评审三");
    expect(panel).not.toContain("乙证据三");
    expect(panel, "整个项目的工件被铺进了面板").not.toContain("整合证据五");
    expect(panel).not.toContain("决策零");
  });

  it("正样本反向证明上一条不是恒真:picked = 乙环节 ⇒ 乙的工件出现、甲的消失", () => {
    const panel = panelSection(renderScreen({ picked: "w-b" }));
    expect(panel).toContain("乙环节");
    expect(panel).toContain("乙评审三");
    expect(panel).not.toContain("甲证据一");
    expect(attrOf(tagById(renderScreen({ picked: "w-b" }), "data-span-id", "w-b"), "data-selected")).toBe(
      "true",
    );
  });

  it("默认选中 = 布局里第一个**有工件**的环节(不是第一条工作项)", () => {
    // 夹具里 w-root 有 2 件(dl / r7),它就是默认
    const panel = panelSection(renderScreen({ picked: undefined }));
    expect(panel).toContain("根环节");
    // 负样本:w-c(丙)不是默认
    expect(panel).not.toContain("丙证据四");
  });

  it("`picked === null`(用户明确取消)⇒ 面板收起,只剩一句提示", () => {
    const html = renderScreen({ picked: null });
    expect(html).toContain("点一个环节看它的产出。");
    expect(tagById(html, "data-span-id", "w-a")).toContain('data-selected="false"');
  });
});
