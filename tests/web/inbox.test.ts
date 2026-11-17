/**
 * 「等你表态」收件箱(R-A,2026-11-17 IA v4)—— 原 acceptance-dock 判据的继承与变更
 *
 * ⚠️ **判据变更记录**(2026-11-17,用户裁决「完完全全重构」):
 *   · 原两个 dock(待你验收 / 待答)**融合成一个收件箱队列**(一条、一个计数、
 *     类型徽章:验收 / 提问 / 收口提议);
 *   · 「AgentPanel」已删(S-A);「先在左栏选一个项目」→ 名称式「未选项目」;
 *   · 空态文案 → 「暂无待表态」;隐藏判据不变:**两处取数都拿到终值且全空才隐藏**
 *     (加载中/读失败不许藏 —— 这条是原判据的核心,逐字继承);
 *   · 「只拉一次详情」判据:文件集合随融合收缩为 ChatRightRail + Inbox。
 *
 * 继承的负样本(不许变):加载中/读失败不许渲染成「没有」;空态不给按钮。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectDetail } from "@shared/types/platform";
import type { ProjectDetailState } from "../../web/src/lib/data";
import { InboxPanel } from "@/components/client/Inbox";

const WEB_SRC = join(process.cwd(), "web/src");
const source = (rel: string): string =>
  readFileSync(join(WEB_SRC, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 收件箱的数据来源:ChatRightRail(取数提升层)+ Inbox(渲染层)。 */
const RAIL_FILES = [
  "components/shell/ChatRightRail.tsx",
  "components/client/Inbox.tsx",
] as const;

const detail = (over: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: "p1",
  name: "美股量化平台",
  client: "甲方",
  goal: "g",
  status: "awaiting_acceptance",
  createdAt: 1_700_000_000_000,
  counts: {
    works: 2, openWorks: 1, artifacts: 3,
    pendingQuestions: 0, openBlockers: 0, pendingAcceptance: 1, unconfirmedWorks: 0, failedWorks: 0,
  },
  members: [],
  works: [],
  pendingQuestions: [],
  awaitingAcceptance: [
    { artifactId: "art_1", title: "最终交付物", deliveredAt: 1_700_000_100_000, deliverableType: "html_report" },
  ],
  ...over,
});

const state = (over: Partial<ProjectDetailState> = {}): ProjectDetailState => ({
  projectId: "p1", detail: null, blockers: [], loading: false, error: null,
  ...over,
});

const questions = (over: { loading?: boolean; error?: string | null } = {}) => ({
  data: [], loading: over.loading ?? false, error: over.error ?? null,
  fromClosedProjects: 0, closedProjectQuestions: [], answeredUnconsumed: {},
});

const render = (s: ProjectDetailState, q = questions()): string =>
  renderToStaticMarkup(createElement(InboxPanel, { state: s, questions: q, projectId: s.projectId }));

describe("收件箱 · 渲染三态(继承:没查过 ≠ 没有)", () => {
  it("有件等你表态 ⇒ 类型徽章「验收」+ 标题 + 两个动作", () => {
    const html = render(state({ detail: detail() }));
    expect(html).toContain("等你表态");
    expect(html).toContain("1 件等你拍板");
    expect(html).toContain("最终交付物");
    expect(html).toContain(">接受<");
    expect(html).toContain(">要改<");
    expect(html).toContain(">验收<");
  });

  it("**没查过不许渲染成「没有」** —— 首帧必须是「加载中…」", () => {
    const html = render(state({ loading: true, detail: null }), questions({ loading: true }));
    expect(html).toContain("加载中…");
    expect(html).not.toContain("暂无待表态");
  });

  it("查过了、真的没有 ⇒ 「暂无待表态」,不给任何动作", () => {
    const html = render(state({ detail: detail({ awaitingAcceptance: [] }) }));
    expect(html).toContain("暂无待表态");
    expect(html).not.toContain(">接受<");
    expect(html).not.toContain(">要改<");
  });

  it("读失败 ⇒ 如实说失败,不许静默变成「没有」(7-N)", () => {
    const html = render(state({ error: "boom" }));
    expect(html).toContain("boom");
    expect(html).not.toContain("暂无待表态");
  });

  it("自检:四种渲染互不相同", () => {
    const a = render(state({ detail: detail() }));
    const b = render(state({ loading: true, detail: null }), questions({ loading: true }));
    const c = render(state({ detail: detail({ awaitingAcceptance: [] }) }));
    const d = render(state({ error: "boom" }));
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe("收件箱 · 落点与融合判据", () => {
  it("ChatRightRail 挂了收件箱,且旧的两块 dock 不许回来", () => {
    const rail = source("components/shell/ChatRightRail.tsx");
    expect(rail).toContain("InboxPanel");
    expect(rail).not.toContain("AcceptanceDock");
    expect(rail).not.toContain("ClientQuestionDock");
  });

  it("S-A:空栏隐藏的**终值前提**仍在(R-A 继承;判据在 inboxCount)", () => {
    const rail = source("components/shell/ChatRightRail.tsx");
    expect(rail).toContain("return null");
    expect(rail).toContain("inboxCount");
    const inbox = source("components/client/Inbox.tsx");
    expect(inbox).toMatch(/!questions\.loading/);
    expect(inbox).toMatch(/questions\.error === null/);
    expect(inbox).toContain("answeredPending === 0");
  });

  it("**只拉一次详情**:两个文件里 useProjectDetail( 只出现一次", () => {
    const calls = RAIL_FILES.flatMap((f) =>
      (source(f).match(/useProjectDetail\(/g) ?? []).map(() => f),
    );
    expect(calls).toEqual(["components/shell/ChatRightRail.tsx"]);
  });

  it("工作台头部有「详情」入口(项目页签退场后的常驻路径)", () => {
    expect(source("components/chat/ChatSurface.tsx")).toContain('href="#/project"');
  });
});
