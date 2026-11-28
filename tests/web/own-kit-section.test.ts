/**
 * 「自己的工具与经验」折叠块(040,2026-11-28)· 判据
 *
 * ── 钉住什么 ──────────────────────────────────────────────────
 *
 *   ① **只有三个执行角色有这一块**:视图里带 `own` 的角色才出现;业务经理没有。
 *   ② **读不到 ≠ 没有**:仓库 / 经验读失败时上屏的是「加载失败:… + 这不是『他没有工具』」,
 *      不许出现「还没有工具」「没有条目」;`repoState: "unavailable"` 同理。
 *   ③ **三种工具状态长得不一样**:在用 / 已停用 / 格式不对(+ 原因);停用要两步确认
 *      (第一下按钮上写的是「停用」,不是「确认停用」)。
 *   ④ **卡里角色名只出现一次**:这一块一律说「他」。
 *   ⑤ **默认折叠**、卡片只有一个外壳(与 `harness-by-role.test.ts` 同两条纪律)。
 *   ⑥ 标题后缀只来自卡片头那份快照,且读不到时不编数字。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessView, OwnKitView, OwnToolView, RoleHarnessView } from "@shared/types/platform";
import { RoleHarnessDisclosure } from "@/components/members/RoleHarness";
import { OwnKitSection, ownKitSummarySuffix, ownToolStateLabel } from "@/components/harness/OwnKitSection";
import type { OwnKitModel } from "@/components/harness/useOwnKit";
import { remoteListOf, remoteOf } from "@/components/ui/DataState";

const tool = (over: Partial<OwnToolView>): OwnToolView => ({
  name: "rag", kind: "mcp", description: "检索我自己的调研笔记", state: "usable",
  problem: null, disabledAt: null, fileCount: 3, ...over,
});
const own = (over: Partial<OwnKitView>): OwnKitView => ({
  repoDir: "/work/roles/research_worker", repoState: "ready", tools: [], notes: { lesson: 0, research: 0 }, ...over,
});
const model = (over: Partial<OwnKitModel> = {}): OwnKitModel => ({
  state: remoteOf(own({}), null, false),
  notes: remoteListOf([], false, null),
  input: "", setInput: vi.fn(), submitSearch: vi.fn(), actionError: null,
  toggle: vi.fn(), removeNote: vi.fn(),
  ...over,
});
const render = (m: OwnKitModel): string => renderToStaticMarkup(createElement(OwnKitSection, { model: m }));

describe("ownKitSummarySuffix / ownToolStateLabel · 纯判据", () => {
  it("⑥ 后缀:视图里没有 / 读不到 ⇒ 空串(不编数字);有数 ⇒ 工具与经验的个数", () => {
    expect(ownKitSummarySuffix(undefined)).toBe("");
    expect(ownKitSummarySuffix(own({ repoState: "unavailable", problem: "x" }))).toBe("");
    expect(ownKitSummarySuffix(own({}))).toBe(" · 工具 0 个 · 经验 0 条");
    expect(ownKitSummarySuffix(own({ tools: [tool({}), tool({ name: "b" })], notes: { lesson: 2, research: 1 } }))).toBe(" · 工具 2 个 · 经验 3 条");
    expect(ownKitSummarySuffix(own({ notes: null }))).toBe(" · 工具 0 个");
  });

  it("③ 三种状态各有一句话与一种颜色", () => {
    expect(ownToolStateLabel(tool({}))).toEqual({ text: "在用", tone: "jade" });
    expect(ownToolStateLabel(tool({ state: "disabled", disabledAt: 1 }))).toEqual({ text: "已停用", tone: "bone" });
    expect(ownToolStateLabel(tool({ state: "invalid", problem: "缺 description" }))).toEqual({ text: "格式不对", tone: "cinnabar" });
  });
});

describe("OwnKitSection · 排版", () => {
  it("仓库路径、工具三种状态与原因、停用日期、经验条目都在;④ 角色名一个都不出现", () => {
    const html = render(model({
      state: remoteOf(own({
        repoDir: "/work/roles/research_worker",
        tools: [
          tool({ name: "rag", kind: "mcp" }),
          tool({ name: "old", kind: "skill", state: "disabled", disabledAt: 1_700_000_000_000 }),
          tool({ name: "nodesc", state: "invalid", description: "", problem: "SKILL.md 缺 description" }),
        ],
        notes: { lesson: 1, research: 2 },
      }), null, false),
      notes: remoteListOf([
        { id: "an_1", kind: "research", title: "某站要 referer", content: "不带 referer 打不开", source: "https://e.com/a", sourceProjectId: null, status: "active", retireReason: null, createdAt: 1, updatedAt: 1 },
        { id: "an_2", kind: "lesson", title: "旧做法", content: "已过时", source: null, sourceProjectId: null, status: "retired", retireReason: "被 an_1 取代", createdAt: 1, updatedAt: 2 },
      ], false, null),
    }));
    expect(html).toContain("/work/roles/research_worker");
    expect(html).toContain("rag");
    expect(html).toContain("MCP 服务");
    expect(html).toContain("说明 + 脚本");
    expect((html.match(/在用/g) ?? []).length).toBe(1);
    expect(html).toContain("已停用");
    expect(html).toContain("停用于");
    expect(html).toContain("格式不对");
    expect(html).toContain("SKILL.md 缺 description");
    expect(html).toContain("恢复");
    // ③ 停用与删除都是两步:首屏按钮上写的是「停用」「删除」,不是「确认…」
    expect(html).toContain(">停用<");
    expect(html).toContain(">删除<");
    expect(html).not.toContain("确认停用");
    expect(html).not.toContain("确认删除");
    // 经验条目:类型 / 标题 / 出处 / 退休标记
    expect(html).toContain("某站要 referer");
    expect(html).toContain("https://e.com/a");
    expect(html).toContain("旧做法(已退休)");
    // ④ 这里一律说「他」:五个角色中文名一个都不许出现
    for (const name of ["业务经理", "项目经理", "研究员", "工程师", "质检"]) {
      expect(html, `角色名「${name}」出现在这一块里`).not.toContain(name);
    }
    expect(html).toContain("仓库:");
    expect(html).not.toContain("加载失败");
  });

  it("空仓库与空经验库:说「还没有工具」「没有条目」—— 只有**读到了**才这么说", () => {
    const html = render(model({ state: remoteOf(own({ tools: [] }), null, false) }));
    expect(html).toContain("还没有工具");
    expect(html).toContain("没有条目");
    const missing = render(model({ state: remoteOf(own({ repoState: "missing" }), null, false) }));
    expect(missing).toContain("目录还没建出来");
    expect(missing).not.toContain("还没有工具");
  });

  it("② 读不到 ≠ 没有:仓库读失败 ⇒ 错误原文 + 「不是『他没有工具』」,不出现「还没有工具」", () => {
    const html = render(model({ state: remoteOf(null, "boom", false) }));
    expect(html).toContain("加载失败:boom");
    expect(html).toContain("不是「他没有工具」");
    expect(html).not.toContain("还没有工具");
    const notes = render(model({ notes: remoteListOf([], false, "库锁住了") }));
    expect(notes).toContain("加载失败:库锁住了");
    expect(notes).toContain("不是「还没有经验」");
    expect(notes).not.toContain("没有条目");
  });

  it("② 仓库这一趟算不出来(repoState unavailable):原因是红字,且不说「还没有工具」", () => {
    const html = render(model({ state: remoteOf(own({ repoState: "unavailable", problem: "这次运行没有装配工作区" }), null, false) }));
    expect(html).toContain("这次运行没有装配工作区");
    expect(html).not.toContain("还没有工具");
  });

  it("动作失败单独一行:原文上屏", () => {
    const html = render(model({ actionError: "他的仓库里没有叫「x」的工具目录" }));
    expect(html).toContain("操作失败:他的仓库里没有叫「x」的工具目录");
  });
});

// ── 卡片层:谁有这一块、折叠、角色名 ──────────────────────────

const roleView = (r: RoleHarnessView["role"], displayName: string, over: Partial<RoleHarnessView>): RoleHarnessView => ({
  role: r, displayName, clientFacing: false, ceiling: [], writeKinds: [], boundaryDeny: [],
  promptUnits: [], tools: [], toolsSolved: true, blockedByCeiling: [], unknownTools: [],
  toolSet: { path: "/x.json", state: "absent", allow: [], deny: [], removedByToolSet: [] },
  ...over,
});
const viewWith = (...roles: RoleHarnessView[]): HarnessView => ({
  roles, promptDir: "/d/system_prompts/", toolsDir: "/d/tools/", strayToolSetFiles: [], writable: true,
});
const renderCard = (role: RoleHarnessView["role"], view: HarnessView): string =>
  renderToStaticMarkup(createElement(RoleHarnessDisclosure, {
    role, view, loading: false, error: null, drafts: {}, backups: {}, onDraftChange: vi.fn(), onApplied: vi.fn(),
  }));

describe("角色 harness 卡 · 「自己的工具与经验」这一块", () => {
  const WK = roleView("research_worker", "研究员", {
    own: own({ tools: [tool({})], notes: { lesson: 0, research: 1 } }),
  });
  const BM = roleView("business_manager", "业务经理", { clientFacing: true });

  it("① 三个执行角色才有:标题带工具与经验的个数;业务经理的卡里没有这一块", () => {
    const wk = renderCard("research_worker", viewWith(BM, WK));
    expect(wk).toContain("自己的工具与经验 · 工具 1 个 · 经验 1 条");
    const bm = renderCard("business_manager", viewWith(BM, WK));
    expect(bm).not.toContain("自己的工具与经验");
  });

  it("⑤ 默认折叠、卡片只有一个外壳、④ 角色名只出现一次", () => {
    const html = renderCard("research_worker", viewWith(BM, WK));
    const mine = html.slice(html.indexOf("自己的工具与经验") - 20, html.indexOf("自己的工具与经验") + 60);
    expect(mine).not.toMatch(/<details[^>]*\sopen/);
    expect((html.match(/sansheng-card/g) ?? []).length).toBe(1);
    const text = html.replace(/<[^>]+>/g, "");
    expect((text.match(/研究员/g) ?? []).length).toBe(1);
  });

  it("视图读不到时(还没拿到 / 读失败)整块不出 —— 不画一块空的", () => {
    const loading = renderToStaticMarkup(createElement(RoleHarnessDisclosure, {
      role: "research_worker", view: null, loading: true, error: null, drafts: {}, backups: {},
      onDraftChange: vi.fn(), onApplied: vi.fn(),
    }));
    expect(loading).not.toContain("自己的工具与经验");
  });
});
