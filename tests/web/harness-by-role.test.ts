/**
 * Harness 屏的**按角色分栏**(2026-10-05)—— 可读性改造的判据
 *
 * ── 为什么要这份测试 ────────────────────────────────────────────
 *
 * 改的是**摆放**:以前四个角色同时铺开(每个 5 行 KV + 每个单元一个展开的
 * textarea ⇒ 一屏十几段长正文,而且共用单元会重复出现多次)。「摆放」最容易
 * 悄悄退回去 —— 没有一条断言的话,下次有人「顺手」把 mapping 改成 all-roles-inline
 * 也不会有任何东西红,而页面上看起来只是「又变长了」。
 *
 * 钉住的四条(每条都对应一个具体的可读性承诺):
 *
 *   1. **一次只渲染一个角色** —— 传入 worker 时,业务经理独有的单元**不许出现**;
 *   2. **编辑器默认折叠** —— `<details>` 不带 `open`(否则又是一屏长正文)。
 *      ⚠️ 这一条自带正样本:同一个 `Disclosure` 组件在 `defaultOpen` 时**必须**
 *      渲染出 `open`,否则「没有 open」可能只是因为属性从来没被渲染过;
 *   3. **共用单元标注** —— `collaboration.ask` 被 2 个角色声明 ⇒ 显示「共用于 2 个角色」,
 *      而独有单元**不许**显示这个标注(负样本);
 *   4. **四类需要注意的东西都可见** —— 缺单元 / 集合文件坏 / 越权被拒 / 未知工具名,
 *      并且页签角标把它们的**和**显示出来。
 *
 * 组件是纯 props 的(`HarnessRoleTabs` / `HarnessRolePane`),与 `ConversationStream`
 * / `TurnView` 同一处置 —— 导出给测试,不需要起服务、不需要 stub fetch。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ProjectRole, PromptUnitView, RoleHarnessView, ToolSetFileView,
} from "@shared/types/platform";
import {
  HarnessRolePane,
  HarnessRoleTabs,
  roleIssueCount,
  sharedUnitOwners,
} from "@/routes/Harness";
import { Disclosure } from "@/components/ui/primitives";

// ── 夹具 ────────────────────────────────────────────────────────

const unit = (id: string, over: Partial<PromptUnitView> = {}): PromptUnitView => ({
  id,
  loaded: true,
  chars: id.length * 10,
  content: `# ${id}\n正文`,
  path: `/data/harness/system_prompts/${id}.md`,
  ...over,
});

const toolSet = (over: Partial<ToolSetFileView> = {}): ToolSetFileView => ({
  path: "/data/harness/tools/x.json",
  state: "absent",
  allow: [],
  deny: [],
  removedByToolSet: [],
  ...over,
});

function role(
  r: ProjectRole,
  displayName: string,
  over: Partial<RoleHarnessView> = {},
): RoleHarnessView {
  return {
    role: r,
    displayName,
    clientFacing: false,
    ceiling: ["c1", "c2", "c3"],
    writeKinds: [],
    boundaryDeny: [],
    promptUnits: [],
    tools: ["c1"],
    blockedByCeiling: [],
    unknownTools: [],
    toolSet: toolSet(),
    ...over,
  };
}

/** 两个角色,共同声明 `collaboration.ask`;worker 那条 `worker.core` 盘上没有。 */
const BM = role("business_manager", "业务经理", {
  clientFacing: true,
  tools: ["c1", "c2"],
  promptUnits: [unit("business_manager.core"), unit("collaboration.ask")],
});

const WK = role("worker", "工程师", {
  promptUnits: [unit("collaboration.ask"), unit("worker.core", { loaded: false, content: "" })],
  // ⚠️ 刻意让「工具名个数(3)」≠「能力条目数(2)」—— 真机上就是这样
  // (一条能力展开成多个工具:blackboard.read → board_list + board_read)。
  // 这两个数**不许**被渲染成分数,下面的断言钉这一点。
  ceiling: ["c1", "c2"],
  tools: ["c1", "c2", "c3"],
  toolSet: toolSet({ state: "invalid", problem: "JSON 解析失败:第 3 行多了个逗号" }),
  blockedByCeiling: ["code.delete"],
  unknownTools: ["board_writee"],
});

const ROLES = [BM, WK];
const OWNERS = sharedUnitOwners(ROLES);

const paneProps = (r: RoleHarnessView) => ({
  role: r,
  owners: OWNERS,
  drafts: {},
  backups: { "collaboration.ask": 3 },
  onDraftChange: vi.fn(),
  onApplied: vi.fn(),
});

const renderPane = (r: RoleHarnessView) =>
  renderToStaticMarkup(createElement(HarnessRolePane, paneProps(r)));

// ── 判据 1:一次只渲染一个角色 ──────────────────────────────────

describe("① 一次只渲染一个角色(这一版要修的正是「四个角色同时铺开」)", () => {
  it("传 worker ⇒ 业务经理**独有**的单元不许出现", () => {
    const html = renderPane(WK);
    expect(html, "worker 面板里出现了 business_manager.core").not.toContain("business_manager.core");
    expect(html).toContain("collaboration.ask");
    expect(html).toContain("worker.core");
  });

  it("传业务经理 ⇒ worker 独有的单元不许出现", () => {
    const html = renderPane(BM);
    expect(html).not.toContain("worker.core");
    expect(html).toContain("business_manager.core");
  });

  it("页签:每个角色一个 tab,只有选中的那个 aria-selected=true", () => {
    const html = renderToStaticMarkup(
      createElement(HarnessRoleTabs, { roles: ROLES, active: "worker", onSelect: vi.fn() }),
    );
    expect((html.match(/role="tab"/g) ?? []).length, "两个角色 ⇒ 两个 tab").toBe(2);
    expect((html.match(/aria-selected="true"/g) ?? []).length, "只有一个选中").toBe(1);
    expect(html).toContain("业务经理");
    expect(html).toContain("工程师");
  });
});

// ── 判据 2:编辑器默认折叠 ──────────────────────────────────────

describe("② 提示词编辑器**默认折叠**(否则又是一屏十几段长正文)", () => {
  it("负样本:面板里的 `<details>` 一个都不带 open", () => {
    const html = renderPane(WK);
    expect((html.match(/<details/g) ?? []).length, "折叠块存在(details 渲染出来了)").toBeGreaterThan(0);
    expect(
      /<details[^>]*\sopen/.test(html),
      "有 details 是展开的 —— 默认折叠的承诺破了",
    ).toBe(false);
  });

  it("✅ 正样本:`Disclosure defaultOpen` 时**必须**渲染出 open(证明上一条不是空转)", () => {
    const opened = renderToStaticMarkup(
      createElement(Disclosure, { summary: "x", defaultOpen: true }, "内容"),
    );
    expect(/<details[^>]*\sopen/.test(opened), "defaultOpen 没渲染 open ⇒ 上一条断言无意义").toBe(true);
  });
});

// ── 判据 3:共用单元标注 ────────────────────────────────────────

describe("③ 共用单元标注「共用于 N 个角色」", () => {
  it("`collaboration.ask` 被 2 个角色声明 ⇒ 标注出来", () => {
    const html = renderPane(WK);
    expect(html).toContain("共用于 2 个角色");
  });

  it("负样本:独有单元(只被一个角色声明)**不许**带这个标注", () => {
    const owners = sharedUnitOwners([BM]);
    expect(owners.get("business_manager.core")).toEqual(["业务经理"]);
    const html = renderToStaticMarkup(
      createElement(HarnessRolePane, { ...paneProps(BM), owners }),
    );
    expect(html, "单角色声明也标了「共用」").not.toContain("共用于");
  });

  it("`sharedUnitOwners` 自身:同一个单元出现在多个角色时列全,且不重复", () => {
    expect(OWNERS.get("collaboration.ask")).toEqual(["业务经理", "工程师"]);
    expect(OWNERS.get("business_manager.core")).toEqual(["业务经理"]);
    // 非空自检:夹具真的有两个角色、三个不同单元
    expect(OWNERS.size).toBe(3);
  });
});

// ── 判据 4:四类「需要注意」都可见 + 页签角标 ────────────────────

describe("④ 缺单元 / 集合文件坏 / 越权被拒 / 未知工具名 —— 四类都可见", () => {
  it("四类告警都在 worker 面板里出现,且缺失单元点了名", () => {
    const html = renderPane(WK);
    expect(html).toContain("有 1 个单元声明了但盘上没有文件");
    expect(html).toContain("worker.core"); // 点名了哪一个
    expect(html).toContain("集合文件无效");
    expect(html).toContain("JSON 解析失败"); // problem 原样显示
    expect(html).toContain("超出架构上界");
    expect(html).toContain("code.delete");
    expect(html).toContain("不存在的工具名");
    expect(html).toContain("board_writee");
  });

  it("干净的角色:一条红告警都没有(负样本)", () => {
    const clean = role("project_manager", "项目经理", { promptUnits: [unit("project_manager.core")] });
    const html = renderPane(clean);
    expect(html).not.toContain("集合文件无效");
    expect(html).not.toContain("超出架构上界");
    expect(html).not.toContain("不存在的工具名");
    expect(html).not.toContain("盘上没有文件");
  });

  it("页签角标 = 四类之和(worker 1+1+1+1 = 4;业务经理 = 0 ⇒ 不显示角标)", () => {
    expect(roleIssueCount(WK)).toBe(4);
    expect(roleIssueCount(BM)).toBe(0);
    const html = renderToStaticMarkup(
      createElement(HarnessRoleTabs, { roles: ROLES, active: "worker", onSelect: vi.fn() }),
    );
    expect(html).toContain(">4<");
    // 干净的角色不该有角标 —— 数一下 cinnabar 语气的小标签正好一个
    expect((html.match(/data-tone="cinnabar"/g) ?? []).length).toBe(1);
  });

  it("摘要行给出「能力面 / 集合文件」的现状(判断这角色正常吗,三个数就够)", () => {
    const html = renderPane(WK);
    expect(html).toContain("提示词单元");
    expect(html).toContain("1/2"); // 2 个单元、1 个已加载 —— 这才是真分数
    // 能力 / 工具**分开写**,而且各自点明单位;绝不许出现「3/2」这种把两个
    // 不同量纲的东西写成比值的形状(真机数据里 tools 26 > ceiling 22)。
    expect(html).toMatch(/能力 <span[^>]*>2<\/span> 项 · 实得工具\s*<span[^>]*>3<\/span> 个/);
    expect(html, "把工具数写成了能力数的分子 —— 会被读成 3 用掉了 2 里的 3").not.toContain("3/2");
    expect(html).toContain("文件无效 · 已退化成 ceiling 全集");
  });
});
