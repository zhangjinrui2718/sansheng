/**
 * 角色 harness 面板的**判据**(2026-10-05 建立;2026-10-06 随「成员 + harness
 * 两个页签合并」从 `@/routes/Harness` 搬到 `@/components/members/RoleHarness`)
 *
 * ── 这一版(2026-10-06)改了什么 ─────────────────────────────────
 *
 * 用户的原话:「成员的 harness 管理可以放在成员的 tab 下面,可以把「成员」
 * 「harness」这两个 tab 也合并了」。于是:
 *
 *   - `routes/Harness.tsx` 搬成 `components/members/RoleHarness.tsx`
 *     ⇒ **import 路径改了**(`@/routes/Harness` → `@/components/members/RoleHarness`);
 *   - 那个路由页面与它那一行角色页签删除
 *     ⇒ 本文件里所有画页签的用例一并删除;
 *   - 「一次只渲染一个角色」这条判据**分成两层**了:
 *       · **面板层**(一个 `HarnessRolePane` 只画一个角色)仍然钉在本文件判据 ①;
 *       · **页签层**(页签一次只选中一个角色、页签上有告警角标)**改由成员页签
 *         承担** —— 断言挪到 `tests/web/members-activity.test.ts` 的判据 ①
 *         (「成员页签一次只渲染一个成员的 harness 面板」)与判据 ⑩
 *         (「页签角标 = 欠活数字 + roleIssueCount 告警」)。**不要在这里再补一份
 *         页签渲染断言** —— 那正是这次要清掉的重复。
 *
 * ── 为什么还需要这份测试 ────────────────────────────────────────
 *
 * 钉住的都是**悄悄退回去**的东西(没有断言的话,下次有人「顺手」改一下也不会有
 * 任何东西红,而页面上看起来只是「又变长了」):
 *
 *   1. **一次只渲染一个角色**(面板层)—— 传入研究工时,业务经理独有的单元
 *      **不许出现**;
 *   2. **编辑器默认折叠** —— `<details>` 不带 `open`(否则又是一屏长正文)。
 *      ⚠️ 这一条自带正样本:同一个 `Disclosure` 组件在 `defaultOpen` 时**必须**
 *      渲染出 `open`,否则「没有 open」可能只是因为属性从来没被渲染过;
 *   3. **共用单元标注** —— `collaboration.ask` 被 2 个角色声明 ⇒ 显示「共用于 2 个角色」,
 *      而独有单元**不许**显示这个标注(负样本);
 *   4. **四类需要注意的东西都可见** —— 缺单元 / 集合文件坏 / 越权被拒 / 未知工具名,
 *      并且 `roleIssueCount` 是它们的**和**(那个数字现在画在**成员页签**的告警
 *      角标上,渲染断言在 members-activity 里);
 *   5. **`toolsSolved=false`(算不出来)≠ `tools=[]`(真的是 0)**。
 *      这一条 2026-10-06 从 `tests/web/members-activity.test.ts` 的判据 ⑧
 *      **整体挪来**(成员页那块只读的「角色能力面」已删,同一条判据现在由
 *      `HarnessRolePane` 承担 —— 它自己就实现了这三例)。
 *
 * 组件是纯 props 的(`HarnessRolePane` / `RoleHarnessDisclosure`),与
 * `ConversationStream` / `TurnView` 同一处置 —— 导出给测试,不需要起服务、
 * 不需要 stub fetch。
 *
 * ── 2026-10-06(同日第三刀):harness **单独成卡**后又补了什么 ─────────
 *
 * 用户的原话:「成员中,角色 harness 单独放一个卡片出来,未来角色的 harness 配置
 * 就放在这个地方」。它从 `MemberPane` 里面搬到下面,卡片本体改由
 * `RoleHarnessDisclosure` 画(标题 + 角色名 + 告警 Pill + 状态摘要 + 默认折叠的配置)。
 * 于是本文件新增两组判据:
 *
 *   - **判据 ⑦ 卡片头状态摘要**(单元 x/y · 能力 n 项 · 实得工具 m 个 · 集合文件
 *     状态)**必须落在第一个 `<details>` 之前** —— 否则用户还是要展开才知道
 *     这个角色的 harness 正不正常;「不知道」的三种(读不到 / 正在读 / 没这个
 *     角色)在卡片头上也各不相同,而且都不许长成「实得工具 0 个」。
 *   - **判据 ⑧ 告警 Pill 只在 `roleIssueCount > 0` 时出现**,以及 `embedded`:
 *     嵌进外层卡片时 `HarnessRolePane` **不再画自己那一份 `Section` 外壳**
 *     (正负样本各一条 —— 否则展开后是卡片套卡片、角色名出现两次)。判据 ② 也
 *     补了卡片层的「配置默认折叠 + `defaultOpen` 正样本」。
 *
 * ── 2026-10-08:判据 ⑨ / ⑩(用户点名的两处)────────────────────────
 *
 * 用户的原话(逐字):
 *
 *   「成员tab下面的harness,
 *     1. 提示词单元可以收起,不要展示那么长,我觉得可以截断前500个字,然后两个
 *        按钮,一个按钮展开全部,一个按钮编辑
 *     2. 工具 做一个表格,按照类型、名称、作用来,现在搞一对英文名称的list,
 *        完全不知道都有些啥」
 *
 *   - **判据 ⑨**:默认只画前 `UNIT_PREVIEW_CHARS`(500)个字,第 501 个字之后
 *     **不在屏幕上**;短正文不许出现「展开全部」(按不动的按钮是装饰);
 *     默认态**没有 textarea**,而「编辑中」的正样本必须有(否则那条负样本空转)。
 *   - **判据 ⑩**:工具面是三列表格(类型 / 名称 / 作用),不再是 `a · b · c`
 *     那一串英文名;`toolBriefs` 缺席(旧后端)⇒ 退化回英文名单,而**不许**
 *     显示成「没有工具」。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  HarnessView, ProjectRole, PromptUnitView, RoleHarnessView, ToolBriefView, ToolSetFileView,
} from "@shared/types/platform";
import {
  HarnessRolePane,
  PromptUnitEditForm,
  RoleHarnessDisclosure,
  harnessStatusText,
  roleIssueCount,
  sharedUnitOwners,
  unitPreview,
  type OpState,
} from "@/components/members/RoleHarness";
import { Disclosure } from "@/components/ui/primitives";

/**
 * 只留**可见正文**:去掉属性与 SSR 插在相邻文本节点之间的 `<!-- -->`。
 *
 * ⚠️ 为什么必须去掉属性:卡片刻意把判断依据写进了 `title=`(例如告警 Pill 的
 * 「4 处需要注意」说明、Section 的 `hintTitle`)。在原始 html 上断言「某个词
 * 不出现」会被自己的说明文字打红,而那种红是假故障(用户看不见 title 里的字)。
 * 所以本文件的**文字**断言走 `visible()`;要断言属性(如 `open`)才用原始 html。
 */
const visible = (html: string): string =>
  html
    .replace(/ title="[^"]*"/g, "")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]*>/g, "");


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
    toolsSolved: true,
    blockedByCeiling: [],
    unknownTools: [],
    toolSet: toolSet(),
    ...over,
  };
}

/** 两个角色,共同声明 `collaboration.ask`;研究工那条 `research_worker.core` 盘上没有。 */
const BM = role("business_manager", "业务经理", {
  clientFacing: true,
  tools: ["c1", "c2"],
  promptUnits: [unit("business_manager.core"), unit("collaboration.ask")],
});

const WK = role("research_worker", "研究员", {
  promptUnits: [unit("collaboration.ask"), unit("research_worker.core", { loaded: false, content: "" })],
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

/**
 * 「角色 harness」那张**卡**的完整夹具 —— `RoleHarnessSection` 取到数据之后画的
 * 就是这一层(`RoleHarnessDisclosure`)。卡片头的状态摘要、告警 Pill、默认折叠
 * 这几条判据都在这里断言(SSR 下 `RoleHarnessSection` 永远停在「加载中」)。
 */
const FULL: HarnessView = {
  roles: ROLES,
  promptDir: "/data/harness/system_prompts/",
  toolsDir: "/data/harness/tools/",
  strayToolSetFiles: [],
  writable: true,
};

const renderDisclosure = (over: Partial<Parameters<typeof RoleHarnessDisclosure>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(RoleHarnessDisclosure, {
      role: "research_worker",
      view: FULL,
      loading: false,
      error: null,
      drafts: {},
      backups: {},
      onDraftChange: vi.fn(),
      onApplied: vi.fn(),
      ...over,
    }),
  );

/**
 * 卡片头那一截标记 —— **第一个 `<details>` 之前**的部分。
 *
 * ⚠️ 这是「不展开也读得到」这条判据的**唯一**硬形式:`<details>` 是闭合的,
 * 里面的字也在 html 里,所以整段 html 上的 `toContain` 无法区分「卡片头」与
 * 「展开后的面板摘要行」。截到第一个 `<details>` 才真的在断言「折叠状态下可见」。
 */
const cardHead = (html: string): string => html.slice(0, html.indexOf("<details"));

// ── 判据 1:一次只渲染一个角色(面板层)──────────────────────────

describe("① 一次只渲染一个角色(面板层;页签层已挪去成员页签的测试)", () => {
  it("传研究工 ⇒ 业务经理**独有**的单元不许出现", () => {
    const html = renderPane(WK);
    expect(html, "研究工面板里出现了 business_manager.core").not.toContain("business_manager.core");
    expect(html).toContain("collaboration.ask");
    expect(html).toContain("research_worker.core");
  });

  it("传业务经理 ⇒ 研究工独有的单元不许出现", () => {
    const html = renderPane(BM);
    expect(html).not.toContain("research_worker.core");
    expect(html).toContain("business_manager.core");
  });

  // ⚠️ 这里原本还有一条「页签:每个角色一个 tab,只有选中的那个 aria-selected=true」。
  // 那个组件(harness 页的角色页签)已随「成员 / harness 两个页签合并」删除,这一条
  // 判据现在由**成员页签**承担:见 `tests/web/members-activity.test.ts` 判据 ①。
});

// ── 判据 2:编辑器默认折叠 ──────────────────────────────────────

describe("② 提示词编辑器 / 配置内容**默认折叠**(否则又是一屏十几段长正文)", () => {
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

  it("【单独成卡】卡片的配置块 summary 是「展开配置(提示词单元 · 工具面 · 常量)」,且默认不展开", () => {
    const html = renderDisclosure();
    expect(html).toContain("展开配置(提示词单元 · 工具面 · 常量)");
    expect((html.match(/<details/g) ?? []).length, "卡里应该有折叠块").toBeGreaterThan(0);
    expect(/<details[^>]*\sopen/.test(html), "卡片的配置默认展开了 —— 承诺破了").toBe(false);
  });

  it("✅ 正样本:`defaultOpen` 时卡片的配置块**必须**带 open(证明上一条不是空转)", () => {
    const opened = renderDisclosure({ defaultOpen: true });
    expect(/<details[^>]*\sopen/.test(opened), "defaultOpen 没透到卡片上").toBe(true);
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
    expect(OWNERS.get("collaboration.ask")).toEqual(["业务经理", "研究员"]);
    expect(OWNERS.get("business_manager.core")).toEqual(["业务经理"]);
    // 非空自检:夹具真的有两个角色、三个不同单元
    expect(OWNERS.size).toBe(3);
  });
});

// ── 判据 5:「求解不了」与「真的是 0」必须分开说 ──────────────────
//
// 2026-10-05 真机现场:成员页显示「实得工具 0 个」,而那一刻库里连 agent 行都没有
// (组织刚被重置)。`tools` 是空数组没错,但「0 个工具」与「算不出来」是两件事,
// 而它们在界面上长得一模一样 —— 这正是本项目反复栽的形态。
//
// ⚠️ 2026-10-06:这三例原先在 `tests/web/members-activity.test.ts` 的判据 ⑧ 里
// (那时它们断言的是成员页那块只读的「角色能力面」)。那块已删,判据整体挪到这里,
// 由 `HarnessRolePane`(它自己就实现了这三例)承担。
describe("⑤ 工具面「求解不了」不许显示成「0 个」", () => {
  /**
   * 「已求解 ⇒ 实得工具 N 个」在标记里的真实形状:数字外面套了一层上色的 span。
   * ⚠️ 必须用这个形状断言 —— 直接找字面量 `实得工具 0 个` **永远匹配不到**,
   * 那样的负样本断言恒真(写这一版时正是被下面的正样本当场抓出来的)。
   */
  const showsSolvedCount = (html: string, n: number) =>
    new RegExp(`实得工具 <span[^>]*>${n}</span> 个`).test(html);

  it("toolsSolved=false ⇒ 显示「求解不了」,而且**不显示计数**", () => {
    const unsolved = role("project_manager", "项目经理", {
      toolsSolved: false,
      tools: [],
      promptUnits: [unit("project_manager.core")],
    });
    const html = renderPane(unsolved);
    expect(html).toContain("求解不了");
    expect(
      showsSolvedCount(html, 0),
      "把「算不出来」显示成了「实得工具 0 个」",
    ).toBe(false);
  });

  it("字段缺失(前端比后端新)⇒ 退化回旧行为显示计数,**不许**误报成「求解不了」", () => {
    // 旧后端(没有 toolsSolved 这个字段)与只增字段的契约:absent ⇒ 按旧行为走。
    const legacy = role("project_manager", "项目经理", {
      tools: ["c1", "c2"],
      promptUnits: [unit("project_manager.core")],
    });
    delete (legacy as { toolsSolved?: boolean }).toolsSolved;
    const html = renderPane(legacy);
    expect(html, "字段缺失被误报成「组织未播种」").not.toContain("求解不了");
    expect(showsSolvedCount(html, 2)).toBe(true);
  });

  it("正样本:toolsSolved=true 且 tools 真的为空 ⇒ **这才是**「0 个」(接待阶段的合法形状)", () => {
    const solvedEmpty = role("project_manager", "项目经理", {
      toolsSolved: true,
      tools: [],
      promptUnits: [unit("project_manager.core")],
    });
    const html = renderPane(solvedEmpty);
    expect(showsSolvedCount(html, 0), "求解过了、确实是 0 —— 该显示 0").toBe(true);
    expect(html).not.toContain("求解不了");
  });

  it("越界项与 ceiling 的条目都如实显示(从 members-activity 的判据 ⑧ 第三例挪来)", () => {
    // 那一例断言的是「`blockedByCeiling` 与 ceiling 的条目名都在屏幕上」——
    // 成员页那块只读视图删掉后,它必须由这里继续钉住。
    const html = renderPane(
      role("research_worker", "研究员", {
        ceiling: ["board_list", "board_read", "code_write"],
        blockedByCeiling: ["org.reset"],
        promptUnits: [unit("research_worker.core")],
      }),
    );
    expect(html).toContain("超出架构上界");
    expect(html).toContain("org.reset");
    expect(html, "ceiling 的条目名没有逐条列出").toContain("code_write");
  });
});

// ── 判据 4:四类「需要注意」都可见 + roleIssueCount 是它们的和 ────

describe("④ 缺单元 / 集合文件坏 / 越权被拒 / 未知工具名 —— 四类都可见", () => {
  it("四类告警都在研究工面板里出现,且缺失单元点了名", () => {
    const html = renderPane(WK);
    expect(html).toContain("有 1 个单元声明了但盘上没有文件");
    expect(html).toContain("research_worker.core"); // 点名了哪一个
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

  it("`roleIssueCount` = 四类之和(研究工 1+1+1+1 = 4;业务经理 = 0)", () => {
    expect(roleIssueCount(WK)).toBe(4);
    expect(roleIssueCount(BM)).toBe(0);
    // ⚠️ 这个数字**渲染**在哪里,断言就在哪里:它是**成员页签**上的告警角标
    // (原来 harness 页的角色页签已删)。渲染断言在
    // `tests/web/members-activity.test.ts` 判据 ⑩,这里只钉「它是四类之和」。
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

// ── 判据 6:三种「不知道」不许说成「这个角色没有单元」────────────────
//
// `RoleHarnessSection`(成员面板里那一块)自己取整份 `GET /api/harness`。取数失败、
// 还在取、取回来的视图里根本没有这个角色 —— 这三种都**不是**「它没有提示词单元」。
// 本项目反复栽的形态就是「把不知道显示成一切正常」,所以这三种状态在这里各钉一条。
describe("⑥ 取数失败 / 还没取到 / 视图里没有这个角色 —— 都不许说成「没有单元」", () => {
  it("默认折叠,而且配置块的 summary 是那句写死的话", () => {
    const html = renderDisclosure({ role: "project_manager" }); // 视图里没有它
    expect(html).toContain("展开配置(提示词单元 · 工具面 · 常量)");
    expect(/<details[^>]*\sopen/.test(html), "默认折叠的承诺破了").toBe(false);
  });

  it("有需要注意的处数时,卡片头上带出那个数(研究工 4 处)", () => {
    const html = renderDisclosure({});
    expect(cardHead(html)).toContain("4 处需要注意");
  });

  it("取数失败 ⇒ 一句错误,并明说「不是这个角色没有提示词单元」", () => {
    const html = renderDisclosure({ view: null, error: "internal: 连接被拒绝" });
    expect(html).toContain("加载失败");
    expect(html).toContain("连接被拒绝");
    expect(html, "把「读不到」说成了「这个角色没有单元」").toContain("不是「这个角色没有提示词单元」");
    expect(html).not.toContain("这个角色没有声明任何提示词单元");
  });

  it("还在取 ⇒ 「正在读取」,不许留白也不许说没有", () => {
    const html = renderDisclosure({ view: null, loading: true });
    expect(html).toContain("正在读取 harness 视图");
    expect(html).not.toContain("这个角色没有声明任何提示词单元");
  });

  it("视图里没有这个角色 ⇒ 明说与「它没有单元」是两件事(负样本)", () => {
    const html = renderDisclosure({ role: "project_manager" });
    expect(html).toContain("这一份 harness 视图里没有角色 project_manager");
    expect(html).toContain("与「它没有提示词单元」是两件事");
    expect(html).not.toContain("这个角色没有声明任何提示词单元");
  });

  it("文件名写错的工具集合文件必须报出来(原来在 harness 页页级,合并后不能丢)", () => {
    const html = renderDisclosure({
      view: { ...FULL, strayToolSetFiles: ["workers.json"] },
    });
    expect(html).toContain("workers.json");
    expect(html).toContain("不会被读取");
  });
});

// ── 判据 7:卡片头的**状态摘要**(用户「不展开就知道正不正常」的那一行)──
//
// 2026-10-06(第三刀):harness 从成员面板里搬出来**单独成卡**(用户原话:
// 「成员中,角色 harness 单独一个卡片出来,未来角色的 harness 配置就放在这个
// 地方」)。搬出来之后多了一条必须钉住的东西:**卡片头**在不展开时就要能回答
// 「这个角色的 harness 正不正常」—— 否则用户只能靠展开一大堆正文去猜。
describe("⑦ 卡片头状态摘要:不展开也读得到(单元 x/y · 能力 n 项 · 实得工具 m 个 · 集合文件状态)", () => {
  it("研究工(1/2 单元、能力 2、工具 3、集合文件坏)在**第一个 `<details>` 之前**就写明", () => {
    const head = visible(cardHead(renderDisclosure()));
    expect(head, "标题不在卡片头").toContain("角色 harness");
    expect(head, "角色名不在卡片头").toContain("研究员");
    expect(head).toContain("单元 1/2 已加载");
    expect(head).toContain("能力 2 项");
    expect(head).toContain("实得工具 3 个");
    expect(head).toContain("集合文件 文件无效 · 已退化成 ceiling 全集");
  });

  it("三种「不知道」在卡片头上也各不相同(读不到 / 正在读 / 没这个角色)", () => {
    const failed = visible(cardHead(renderDisclosure({ view: null, error: "internal: 连接被拒绝" })));
    const loading = visible(cardHead(renderDisclosure({ view: null, loading: true })));
    const missingRole = visible(cardHead(renderDisclosure({ role: "project_manager" })));
    expect(failed).toContain("状态摘要读不到");
    expect(loading).toContain("正在读取 harness 视图");
    expect(missingRole).toContain("没有角色 project_manager");
    // ⚠️ 三种都不许长得像「一切正常」的一个 0
    for (const text of [failed, loading, missingRole]) {
      expect(text, "把「不知道」显示成了「实得工具 0 个」").not.toContain("实得工具 0 个");
      expect(text, "把「不知道」显示成了「单元 0/0」").not.toContain("单元 0/0");
    }
  });

  it("`toolsSolved === false` ⇒ 卡片头是「求解不了(组织未播种)」,**不是**「0 个」", () => {
    const unsolved = role("project_manager", "项目经理", {
      toolsSolved: false,
      tools: [],
      promptUnits: [unit("project_manager.core")],
    });
    const head = visible(
      cardHead(renderDisclosure({ role: "project_manager", view: { ...FULL, roles: [unsolved] } })),
    );
    expect(head).toContain("求解不了(组织未播种)");
    expect(head, "把「算不出来」显示成了「实得工具 0 个」").not.toContain("实得工具 0 个");
  });

  it("✅ 正样本:求解过了、确实一个都没有 ⇒ 卡片头就该写「实得工具 0 个」", () => {
    const solvedEmpty = role("project_manager", "项目经理", {
      toolsSolved: true,
      tools: [],
      promptUnits: [unit("project_manager.core")],
    });
    const head = visible(
      cardHead(renderDisclosure({ role: "project_manager", view: { ...FULL, roles: [solvedEmpty] } })),
    );
    expect(head).toContain("实得工具 0 个");
    expect(head, "求解过了却报「求解不了」").not.toContain("求解不了");
  });

  it("字段缺失(前端比后端新)⇒ 退化回显示计数,不许误报「求解不了」", () => {
    const legacy = role("project_manager", "项目经理", {
      tools: ["c1", "c2"],
      promptUnits: [unit("project_manager.core")],
    });
    delete (legacy as { toolsSolved?: boolean }).toolsSolved;
    expect(harnessStatusText(legacy)).toContain("实得工具 2 个");
    expect(harnessStatusText(legacy)).not.toContain("求解不了");
  });
});

// ── 判据 8:卡片头告警 Pill + `embedded` 不许卡片套卡片 ─────────────

describe("⑧ 卡片头告警 Pill 与 `embedded`(同一个角色名/标题不许画两遍)", () => {
  it("`roleIssueCount > 0` ⇒ 卡片头出现那个处数;= 0 ⇒ 一个字都不出现(负样本)", () => {
    const dirtyHead = cardHead(renderDisclosure()); // 研究工 4 处
    expect(dirtyHead).toContain("4 处需要注意");
    expect(roleIssueCount(WK), "角标数字必须真的来自 roleIssueCount").toBe(4);

    const clean = role("project_manager", "项目经理", {
      promptUnits: [unit("project_manager.core")],
    });
    expect(roleIssueCount(clean)).toBe(0);
    const cleanHtml = renderDisclosure({ role: "project_manager", view: { ...FULL, roles: [clean] } });
    expect(cleanHtml, "0 处也刷了一条要读的字").not.toContain("处需要注意");
  });

  it("卡片里角色名只出现**一次**(嵌入的面板不再画一遍自己的标题)", () => {
    const text = visible(renderDisclosure());
    expect(
      (text.match(/研究员/g) ?? []).length,
      "角色名在卡片里出现了两次 —— 卡片套卡片了",
    ).toBe(1);
  });

  it("卡片套卡片:**只有一个** `sansheng-card` 外壳(嵌进来的面板不再套第二层)", () => {
    const html = renderDisclosure();
    expect(
      (html.match(/sansheng-card/g) ?? []).length,
      "卡片里还有第二层 sansheng-card —— 展开后会看到卡中卡",
    ).toBe(1);
  });

  it("`embedded` 为真 ⇒ `HarnessRolePane` **不渲染**自己的 `Section` 外壳,内容照旧(正负样本)", () => {
    const embedded = renderToStaticMarkup(
      createElement(HarnessRolePane, { ...paneProps(WK), embedded: true }),
    );
    expect(embedded, "embedded 时还画了自己的 Section 外壳").not.toContain("<section");
    // ⚠️ 断言走**可见正文** —— 「共用于 N 个角色」那个 Pill 的 `title=` 里列着
    // 声明它的角色名(那是悬停才看得见的字,不是画出来的标题)。
    expect(visible(embedded), "角色名被画了第二遍").not.toContain(WK.displayName);
    // 内容还在 —— 证明上面两条不是「整块没渲染」的空转
    expect(embedded).toContain("research_worker.core");
    expect(embedded).toContain("提示词单元");
    expect(embedded).toContain("文件无效 · 已退化成 ceiling 全集");

    // ✅ 正样本:默认(不传 embedded = 老形状)时 Section 外壳与角色名**必须**在
    const full = renderPane(WK);
    expect(full).toContain("<section");
    expect(full).toContain(WK.displayName);
  });
});

// ── 判据 9:提示词单元默认只给前 500 个字 + 两个按钮 ─────────────────
//
// 2026-10-08,用户原话:「提示词单元可以收起,不要展示那么长,我觉得可以截断前 500
// 个字,然后两个按钮,一个按钮展开全部,一个按钮编辑」。
//
// 旧形状是 `Clamp lines={2}`(**按行**截断)—— 同一个单元在窄窗口与宽窗口下截掉的
// 内容不一样,而「截掉的是哪一截」正是用户判断要不要展开的唯一依据。所以判据落在
// **字数**上,而且边界拿 499 / 500 / 501 三个样本钉(只测一个长正文的话,
// 「到底截到第几个字」没有任何东西在管)。
describe("⑨ 提示词单元:默认前 500 字,两个按钮(展开全部 / 编辑)", () => {
  const HEAD = "甲".repeat(500);
  const LONG_TEXT = `${HEAD}尾部哨兵`;
  const LONG = unit("research_worker.core", { content: LONG_TEXT, chars: LONG_TEXT.length });
  const SHORT = unit("collaboration.ask", { content: "短短一段正文", chars: 6 });

  it("`unitPreview`:500 字边界三个样本(499 / 500 / 501)", () => {
    expect(unitPreview("甲".repeat(499))).toEqual({ text: "甲".repeat(499), truncated: false, hidden: 0 });
    // 恰好 500:一个字都没被截掉 ⇒ 不该出现「展开全部」
    expect(unitPreview(HEAD)).toEqual({ text: HEAD, truncated: false, hidden: 0 });
    // 501:截到 500,少显示 1 个 —— `hidden` 是算出来的,不是猜的
    expect(unitPreview(`${HEAD}尾`)).toEqual({ text: HEAD, truncated: true, hidden: 1 });
    // 非空自检:夹具真的跨过了那条线
    expect(LONG_TEXT.length).toBe(504);
  });

  it("长单元:第 501 个字之后**不在屏幕上**,并如实报出少显示了几个字", () => {
    const text = visible(renderPane(role("research_worker", "研究工", { promptUnits: [LONG] })));
    expect(text, "前 500 个字没有画出来").toContain(HEAD);
    expect(text, "第 501 个字之后的正文被画出来了 —— 截断没生效").not.toContain("尾部哨兵");
    expect(text).toContain("还有 4 字符没显示");
    expect(text).toContain("上面是前 500 个");
  });

  it("长单元:两个按钮都在(「展开全部」与「编辑」,都是真按钮不是页面上碰巧出现的字)", () => {
    const html = renderPane(role("research_worker", "研究工", { promptUnits: [LONG] }));
    // ⚠️ 断言按钮的**标记形状**而不是裸词:面板里还有一句「提示词单元 · 可编辑」,
    // 裸 `toContain("编辑")` 会被它满足 —— 那样的正样本是空转的。
    expect(html).toMatch(/>展开全部<\/button>/);
    expect(html).toMatch(/>编辑<\/button>/);
  });

  it("负样本:短单元(≤500 字)**不许**出现「展开全部」(没有可展开的东西)", () => {
    const html = renderPane(role("research_worker", "研究工", { promptUnits: [SHORT] }));
    expect(visible(html)).toContain("短短一段正文");
    // ⚠️ 按钮的断言走**原始 html**:`visible()` 会把标签剥掉,那样断言
    // `>展开全部</button>` 永远不匹配 —— 一条恒真的负样本(写这一版时被下面
    // 「编辑」那条正样本当场抓出来的)。
    expect(html).not.toMatch(/>展开全部<\/button>/);
    // 「编辑」在两种长度下都在 —— 证明上一条不是「整块没渲染」
    expect(html).toMatch(/>编辑<\/button>/);
  });

  it("默认态没有 textarea(编辑区不出现)—— 而「编辑中」**必须**有(正样本)", () => {
    const pane = renderPane(role("research_worker", "研究工", { promptUnits: [LONG] }));
    expect(pane, "默认态就画了 textarea —— 一屏又是长正文").not.toContain("<textarea");

    // ✅ 正样本:同一个渲染路径喂一份「编辑中」的 props ⇒ textarea 与保存/恢复出厂都在。
    // 没有这一条,上面那句「默认态没有 textarea」在整块被删掉时也会通过。
    const form = renderToStaticMarkup(createElement(PromptUnitEditForm, formProps(LONG)));
    expect(form).toContain("<textarea");
    expect(form).toContain("保存");
    expect(form).toContain("恢复出厂");
    expect(visible(form)).toContain("单次请求,没有自动保存");
  });

  it("编辑区仍是老行为:两段式确认与失败原文原样显示", () => {
    const confirming = renderToStaticMarkup(
      createElement(PromptUnitEditForm, { ...formProps(LONG), confirming: true, edited: true }),
    );
    expect(confirming).toContain("确认恢复出厂");
    expect(confirming).toContain("取消");
    expect(confirming).toContain("放弃改动");

    const failed = renderToStaticMarkup(
      createElement(PromptUnitEditForm, {
        ...formProps(LONG),
        edited: true,
        op: { kind: "failed", message: "unknown_unit: 不认识这个 id", validIds: ["a.b"] },
      }),
    );
    const text = visible(failed);
    expect(text).toContain("操作失败:unknown_unit: 不认识这个 id");
    expect(text, "后端回灌的合法 id 清单没显示").toContain("a.b");
  });
});

/** `PromptUnitEditForm`(编辑区)的 props 夹具 —— 纯展示组件,一个回调都不真的跑。 */
function formProps(unitFixture: PromptUnitView) {
  const idle: OpState = { kind: "idle" };
  return {
    unit: unitFixture,
    value: unitFixture.content,
    busy: false,
    confirming: false,
    op: idle,
    edited: false,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onReset: vi.fn(),
    onConfirmReset: vi.fn(),
    onCancelConfirm: vi.fn(),
    onDiscard: vi.fn(),
  };
}

// ── 判据 10:工具面是「类型 / 名称 / 作用」三列表格 ──────────────────
//
// 2026-10-08,用户原话:「工具 做一个表格,按照类型、名称、作用来,现在搞一对英文
// 名称的 list,完全不知道都有些啥」。
//
// ⚠️ 说明文字**来自服务端**(`RoleHarnessView.toolBriefs`,转写自工具注册表的
// `description`),前端不另写一张中文表 —— 那会得到第二份会漂开的「这工具是干嘛的」。
// 服务端那一侧的覆盖判据在 `tests/platform/tool-briefs.test.ts`。
describe("⑩ 工具面:类型 / 名称 / 作用三列表格(不再是一串英文名)", () => {
  const BRIEFS: ToolBriefView[] = [
    {
      name: "board_list", source: "platform", capability: "blackboard.read",
      group: "工件", purpose: "列项目黑板上的工件。",
    },
    {
      name: "read", source: "sdk", capability: "code.read",
      group: "本机操作", purpose: "读文件正文。",
    },
  ];

  const withBriefs = role("research_worker", "研究工", {
    promptUnits: [unit("research_worker.core")],
    tools: ["board_list", "read"],
    toolBriefs: BRIEFS,
  });

  it("三列表头都在,且逐条给出类型 / 名称 / 作用", () => {
    const html = renderPane(withBriefs);
    expect(html).toContain("<table");
    expect(html).toMatch(/<th[^>]*>类型<\/th>/);
    expect(html).toMatch(/<th[^>]*>名称<\/th>/);
    expect(html).toMatch(/<th[^>]*>作用<\/th>/);

    const text = visible(html);
    expect(text, "类型列(能力的中文分组)没画出来").toContain("工件");
    expect(text, "名称列没画出来").toContain("board_list");
    expect(text, "作用列没画出来").toContain("列项目黑板上的工件。");
    expect(text, "SDK 内置的工具没有标出来").toContain("SDK 内置");
    expect(text).toContain("本机操作");
    expect(text).toContain("读文件正文。");
  });

  it("负样本:老形状「a · b · c」那一串英文名不许再出现", () => {
    const text = visible(renderPane(withBriefs));
    expect(text, "还是把工具名单拼成一行 —— 用户看不懂的那一版回来了").not.toContain("board_list · read");
  });

  it("旧读面(没有 toolBriefs 这一栏)⇒ 退化回英文名单,**不许**显示成「没有工具」", () => {
    const legacy = role("research_worker", "研究工", {
      promptUnits: [unit("research_worker.core")],
      tools: ["board_list", "read"],
    });
    const html = renderPane(legacy);
    const text = visible(html);
    expect(text, "旧后端的名单没显示出来").toContain("board_list · read");
    expect(text).toContain("工具名单");
    expect(html, "没说明却画了一张空表").not.toContain("<table");
  });

  it("briefs 为空数组(读面自相矛盾)⇒ 同样退化,不画空表", () => {
    const broken = role("research_worker", "研究工", {
      promptUnits: [unit("research_worker.core")],
      tools: ["board_list"],
      toolBriefs: [],
    });
    const html = renderPane(broken);
    expect(html).not.toContain("<table");
    expect(visible(html)).toContain("board_list");
  });
});
