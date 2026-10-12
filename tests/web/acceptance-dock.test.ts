/**
 * 「待你验收」的**位置**(2026-10-12,用户裁决:从项目页搬到对话页)
 *
 * ── 它盯的是「搬家搬对了吗」,不是「验收逻辑对吗」──────────────────
 *
 * 逻辑本身由 `delivery-verdict.test.ts` 钉(那个组件一个字都没改)。这里盯的是
 * **落点**,因为搬家这类改动最容易出的错是「搬了一半」:
 *
 *   ① **只搬不删** —— 两处都在,于是同一个动作有两个入口,而它们各自的空态、
 *      计数、刷新时机都可能不一样(这个项目为「两份定义会漂」付过好几次代价);
 *   ② **搬了但右栏没挂上** —— 项目页没了、对话页也没有,「有事在等你」又变成
 *      没人知道(真机第一条 `client_question` 就是这么被漏掉的);
 *   ③ **右栏三块各拉一份详情** —— 同一份数据在一处写「加载中」、另一处写
 *      「没有等你验收的东西」。那是把「还没查过」渲染成「查过了是空的」。
 *
 * ⚠️ **断言针对代码,不对注释**:三处源码里都有大段注释在解释「为什么这么放」,
 * 而那些注释里必然出现「待你验收」这个词 —— 所以扫描前先 `stripComments`。
 *   (交付物 iframe 那条判据已经吃过一次亏:裸 grep 报 3 处,剥掉注释后是 0。
 *    **错的是仪器,不是代码。**)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectDetail } from "@shared/types/platform";
import type { ProjectDetailState } from "../../web/src/lib/data";
import { AcceptanceDock } from "@/components/client/AcceptanceDock";

const WEB_SRC = join(process.cwd(), "web/src");

const readWebSrc = (rel: string): string => readFileSync(join(WEB_SRC, rel), "utf8");

/** 去掉注释 —— 断言针对**代码**:注释里讨论「不许写成的形态」不该被判为违规。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const source = (rel: string): string => stripComments(readWebSrc(rel));

/** 右栏三块 + 它们的数据来源。**范围是这四个文件**,因为「右栏只拉一次详情」这句话
 *  只在这四个文件之间成立 —— 漏掉一个就看不见第二次 fetch。 */
const RAIL_FILES = [
  "components/shell/ChatRightRail.tsx",
  "components/shell/AgentPanel.tsx",
  "components/client/AcceptanceDock.tsx",
  "components/client/ClientQuestionDock.tsx",
] as const;

// ── 夹具 ──────────────────────────────────────────────────────────

const detail = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1",
  name: "美股量化平台",
  client: "甲方",
  goal: "g",
  status: "awaiting_acceptance",
  createdAt: 1_700_000_000_000,
  counts: {
    works: 2,
    openWorks: 1,
    artifacts: 3,
    pendingQuestions: 0,
    openBlockers: 0,
    pendingAcceptance: 1,
  },
  members: [],
  works: [],
  pendingQuestions: [],
  awaitingAcceptance: [
    {
      artifactId: "art_1",
      title: "最终交付物",
      deliveredAt: 1_700_000_100_000,
      deliverableType: "html_report",
    },
  ],
  ...over,
});

const state = (over: Partial<ProjectDetailState> = {}): ProjectDetailState => ({
  projectId: "p1",
  detail: null,
  blockers: [],
  loading: false,
  error: null,
  ...over,
});

const render = (s: ProjectDetailState): string =>
  renderToStaticMarkup(createElement(AcceptanceDock, { state: s }));

// ── ① 面板自身的三态 + 那条「没查过 ≠ 空」纪律 ────────────────────

describe("待你验收面板 · 渲染", () => {
  it("有件等你表态 ⇒ 标题 + 计数 + 两个动作 + 交付物标题", () => {
    const html = render(state({ detail: detail() }));
    expect(html).toContain("待你验收");
    expect(html).toContain("1 件等你表态");
    expect(html).toContain("最终交付物");
    expect(html).toContain(">接受<");
    expect(html).toContain(">要改<");
  });

  it("**没查过不许渲染成「没有」** —— 首帧必须是「加载中」", () => {
    // 这就是「还没查过」与「查过了是空的」必须分开的那一格。一个慢请求被读成
    // 「没有等你验收的东西」时,用户会以为货已经收完了。
    const html = render(state({ loading: true, detail: null }));
    expect(html).toContain("加载中…");
    expect(html).not.toContain("没有等你验收的东西");
  });

  it("查过了、真的没有 ⇒ 空态,且**一个验收按钮都不给**", () => {
    const html = render(state({ detail: detail({ awaitingAcceptance: [] }) }));
    expect(html).toContain("没有等你验收的东西");
    expect(html).not.toContain(">接受<");
    expect(html).not.toContain(">要改<");
  });

  it("读失败 ⇒ 如实说失败,不许静默变成「没有」(7-N)", () => {
    const html = render(state({ error: "boom" }));
    expect(html).toContain("加载失败:boom");
    expect(html).not.toContain("没有等你验收的东西");
  });

  it("没选项目 ⇒ 说清先选项目(不是「没有等你验收的东西」)", () => {
    const html = render(state({ projectId: null }));
    expect(html).toContain("先在左栏选一个项目");
    expect(html).not.toContain("没有等你验收的东西");
  });

  it("自检:上面四种渲染**真的互不相同**(不是恒真断言)", () => {
    const a = render(state({ detail: detail() }));
    const b = render(state({ loading: true, detail: null }));
    const c = render(state({ detail: detail({ awaitingAcceptance: [] }) }));
    const d = render(state({ error: "boom" }));
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

// ── ② 落点:项目页**不许**再有第二份 ───────────────────────────────

describe("落点 · 项目页已经交出去了", () => {
  it("`routes/ProjectDetail.tsx` 不再渲染验收动作", () => {
    expect(source("routes/ProjectDetail.tsx")).not.toContain("DeliveryVerdictActions");
  });

  it("**牙**:项目页不许再有那张「待你验收」Section(没有 `<Section title=…>)", () => {
    expect(source("routes/ProjectDetail.tsx")).not.toContain('title="待你验收"');
  });

  it("项目页的 `待验收` **计数留着** —— 删掉它等于「有事在等你」在这一页没人知道", () => {
    // 搬走清单 ≠ 搬走事实。这条计数与 `counts.pendingAcceptance` 同源,收口门读的就是它。
    expect(source("routes/ProjectDetail.tsx")).toContain("detail.counts.pendingAcceptance");
  });

  it("负样本对照:`Works.tsx` 那**另一个**挂载点还留着(甲方在工件页读正文时就地表态)", () => {
    // ⚠️ 只搬项目页那一处。工件卡上的入口是另一回事,删掉它 = 在读正文的地方
    // 把「收不收由你说」拿走了。
    expect(source("routes/Works.tsx")).toContain("DeliveryVerdictActions");
  });
});

// ── ③ 落点:对话页右栏**挂上了**,且挂在「本项目」下面 ───────────────

describe("落点 · 对话页右栏", () => {
  it("`ChatRightRail` 挂了验收面板", () => {
    expect(source("components/shell/ChatRightRail.tsx")).toContain("<AcceptanceDock");
  });

  it("顺序 =「本项目」→「待你验收」→「待答」(用户裁决:放在「本项目」下面)", () => {
    const src = source("components/shell/ChatRightRail.tsx");
    const panel = src.indexOf("<AgentPanel");
    const dock = src.indexOf("<AcceptanceDock");
    const ask = src.indexOf("<ClientQuestionDock");
    expect(panel).toBeGreaterThanOrEqual(0);
    expect(panel).toBeLessThan(dock);
    expect(dock).toBeLessThan(ask);
  });

  it("**右栏只拉一次详情**:四个文件里 `useProjectDetail(` 只出现一次", () => {
    // 三个 hook 实例 = 三份 loading = 「一处写加载中、另一处写没有」。这是搬进来
    // 之后最容易顺手犯的错(每块各拉一份最省事),所以钉住。
    const calls = RAIL_FILES.flatMap((f) =>
      (source(f).match(/useProjectDetail\(/g) ?? []).map(() => f),
    );
    expect(calls).toEqual(["components/shell/ChatRightRail.tsx"]);
  });
});

// ── ④ 仪器自检:上面那些扫描器真的在扫 ────────────────────────────

describe("自检 · 扫描器不是恒真的", () => {
  it("把「待你验收」Section 塞回项目页 ⇒ ② 那几条会红", () => {
    const real = source("routes/ProjectDetail.tsx");
    // 前提:变异真的改到了源码。改不动的话下面那条断言毫无意义。
    const mutated = real.replace(
      "return (",
      'return (<Section title="待你验收"><DeliveryVerdictActions artifactId="a" /></Section>, (',
    );
    expect(mutated, "前提:变异真的改到了源码").not.toBe(real);
    expect(mutated).toContain('title="待你验收"');
    expect(mutated).toContain("DeliveryVerdictActions");
  });

  it("把右栏的顺序倒过来 ⇒ ③ 的顺序断言会红", () => {
    const real = source("components/shell/ChatRightRail.tsx");
    const mutated = real.replace(
      /<AgentPanel state=\{state\} \/>[\s\S]*?<AcceptanceDock state=\{state\} \/>/,
      "<AcceptanceDock state={state} />\n      <AgentPanel state={state} />",
    );
    expect(mutated, "前提:变异真的改到了源码").not.toBe(real);
    const panel = mutated.indexOf("<AgentPanel");
    const dock = mutated.indexOf("<AcceptanceDock");
    expect(panel < dock).toBe(false);
  });

  it("负样本:`App.tsx` 里**不该**再出现这三块的直排(它们归 `ChatRightRail` 管)", () => {
    // 搬错了地方会留下这句话的第二份 ⇒ 布局迟早两处不一样。
    const app = source("App.tsx");
    expect(app).not.toContain("<AgentPanel");
    expect(app).not.toContain("<ClientQuestionDock");
    expect(app).toContain("<ChatRightRail");
  });
});