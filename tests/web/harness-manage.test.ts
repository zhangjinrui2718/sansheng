/**
 * 「Harness 管理」页的判据(2026-11-14)—— 跨角色的单元总览与编辑一屏
 *
 * ── 这一页是什么 ────────────────────────────────────────────────
 *
 * 路由 `#/harness`(**没有页签** —— 导航恒 6 项是用户裁决;入口在成员页 harness 卡
 * 的 aside 链接上,地址可分享):左列 5 角色清单(告警角标),右列选中角色三段
 * (提示词单元 / 工具面 / 代码内常量),顶部一行跨角色的全局问题。
 *
 * ── 钉住的都是会悄悄退回去的东西 ─────────────────────────────────
 *
 *  ① **路由与入口**:地址能解析、App 真的挂了这一页、TopBar **没有**页签
 *     (「有路由必有页签」的惯性回潮)、成员页 harness 卡有真 `<a href>` 入口。
 *  ② **第二套判据不许出现**:这一页的事实必须来自 `GET /api/harness`(经共享
 *     hook)与共享组件 —— 状态词(已加载 / 缺失 / 求解不了 / 生效中)、角标公式
 *     (`roleIssueCount` 的四类之和)、编辑器都不许在本文件里再写一遍。
 *     成员页与这一页是**同一批判据的两个读者**,不是两份事实。
 *  ③ **深链接的读法**:`?role=` 点名了就精确找,**找不到不编**(不静默退到第一个
 *     角色 —— 那会把「指向空气的地址」伪装成「成功打开」)。
 *  ④ **全局状态**:三类问题(缺单元 / 集合文件坏 / 陌生文件)在顶部就看得见;
 *     干净时的「没有」是有据的「没有」(数据已 ready)。
 *  ⑤ **左列角标**:`roleIssueCount` 与成员页签同源;0 处不渲染。
 *  ⑥ **右列三段**:单元行状态词来自共享编辑器;三段标题;工具面注明
 *     「集合文件直接编辑」;常量段标注「改不了」。
 *
 * 纯组件(`GlobalStatusBar` / `RoleListNav` / `RoleDetailPane`)导出给测试,
 * 与 `HarnessRolePane` / `RoleHarnessDisclosure` 同一处置 —— 不起服务、不 stub fetch。
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  HarnessView, ProjectRole, PromptUnitView, RoleHarnessView, ToolSetFileView,
} from "@shared/types/platform";
import { parseHash, toHash, toRoute } from "../../web/src/lib/route";
import {
  GlobalStatusBar,
  HarnessManagePage,
  RoleDetailPane,
  RoleListNav,
} from "@/routes/HarnessManage";
import { RoleHarnessDisclosure } from "@/components/members/RoleHarness";
import {
  harnessGlobalIssues,
  resolveSelectedRole,
} from "@/components/harness/judgments";

const WEB_SRC = join(process.cwd(), "web/src");

/**
 * 与 annotation-budget / text-budget 同一把剥注释的尺:本文件钉的判据本身也写在
 * 页面文件的注释里(「不许出现这些词」),不剥的话**判据会把自己判红**。
 */
function stripComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n"'`]*$/gm, "$1")
  );
}

const source = (rel: string): string => stripComments(readFileSync(join(WEB_SRC, rel), "utf8"));

/** 只留可见正文(与 harness-by-role.test.ts 同一把尺:剥属性与 SSR 注释)。 */
const visible = (html: string): string =>
  html
    .replace(/ title="[^"]*"/g, "")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]*>/g, "");

// ── 夹具(与 harness-by-role.test.ts 同一形状)────────────────────

const unit = (id: string, over: Partial<PromptUnitView> = {}): PromptUnitView => ({
  id,
  loaded: true,
  chars: id.length * 10,
  content: `# ${id}\n正文`,
  path: `/data/harness/system_prompts/${id}.md`,
  ...over,
});

const toolSet = (over: Partial<ToolSetFileView> = {}): ToolSetFileView => ({
  path: `/data/harness/tools/x.json`,
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

const BM = role("business_manager", "业务经理", {
  clientFacing: true,
  promptUnits: [unit("business_manager.core"), unit("collaboration.ask")],
});

const WK = role("research_worker", "研究员", {
  ceiling: ["c1", "c2"],
  tools: ["c1", "c2", "c3"],
  promptUnits: [unit("collaboration.ask"), unit("research_worker.core", { loaded: false, content: "" })],
  toolSet: toolSet({ state: "invalid", problem: "JSON 解析失败:第 3 行多了个逗号", path: "/data/harness/tools/research_worker.json" }),
  blockedByCeiling: ["code.delete"],
  unknownTools: ["board_writee"],
});

const FULL: HarnessView = {
  roles: [BM, WK],
  promptDir: "/data/harness/system_prompts/",
  toolsDir: "/data/harness/tools/",
  strayToolSetFiles: [],
  writable: true,
};

const detailProps = (over: Partial<Parameters<typeof RoleDetailPane>[0]> = {}) => ({
  role: WK,
  view: FULL,
  requested: "research_worker",
  drafts: {},
  backups: { "collaboration.ask": 3 },
  onDraftChange: vi.fn(),
  onApplied: vi.fn(),
  ...over,
});

// ── ① 路由与入口 ────────────────────────────────────────────────

describe("① 路由注册:地址可解析,页签不加", () => {
  it("parseHash / toHash 往返:`#/harness?role=…` 是一个合法地址", () => {
    expect(parseHash("#/harness")).toEqual({ route: "harness", params: {} });
    expect(parseHash("#/harness?role=research_worker")).toEqual({
      route: "harness",
      params: { role: "research_worker" },
    });
    const loc = toRoute("harness", { role: "research_worker" });
    expect(parseHash(toHash(loc))).toEqual(loc); // 深链接可分享的前提:往返不丢东西
  });

  it("App 真的挂了这一页(路由写了不接线 = 指向空气的地址)", () => {
    const app = source("App.tsx");
    expect(app).toContain('route === "harness"');
    expect(app).toContain("HarnessManagePage");
  });

  it("TopBar **没有**这个页签(导航恒 6 项的用户裁决不回潮)", () => {
    const tabs = source("components/shell/TopBar.tsx");
    // 正样本自检:扫描器认得出「页签表里的一条」
    expect(/route:\s*"chat"/.test(tabs)).toBe(true);
    expect(/route:\s*"harness"/.test(tabs), "harness 混进了顶栏页签表").toBe(false);
  });

  it("✅ 正样本:把 harness 塞进页签表,哨兵必须当场变红(证明上一条不是空转)", () => {
    const probe = 'const TABS = [{ route: "harness", label: "管理" }];';
    expect(/route:\s*"harness"/.test(probe)).toBe(true);
  });
});

describe("① 入口:成员页 harness 卡有真 <a href>,带当前角色参数", () => {
  it("链接的地址逐字等于 `#/harness?role=<当前角色>`(地址由 toHash 序列化,不手拼)", () => {
    const html = renderToStaticMarkup(
      createElement(RoleHarnessDisclosure, {
        role: "research_worker",
        view: FULL,
        loading: false,
        error: null,
        drafts: {},
        backups: {},
        onDraftChange: vi.fn(),
        onApplied: vi.fn(),
      }),
    );
    // ⚠️ 断言**标记形状**而不是裸词:状态行里也可能出现「Harness 管理」这样的字,
    // 裸 toContain 抓不住「入口丢了但文字还在」的退化(与 interrupt-stop 的教训同一格)。
    expect(html).toMatch(/<a[^>]*href="#\/harness\?role=research_worker"/);
    expect(visible(html)).toContain("打开 Harness 管理");
    // 地址指向真的路由(不是拼错的半个地址)
    expect(parseHash("#/harness?role=research_worker").route).toBe("harness");
  });
});

// ── ② 全局状态(顶部一行)────────────────────────────────────────

describe("② 全局状态:三类问题在顶部就看得见", () => {
  it("缺单元:点名到「哪个角色的哪个单元」", () => {
    const issues = harnessGlobalIssues(FULL);
    const missing = issues.find((i) => i.kind === "missing_units");
    expect(missing, "缺单元没被报出来").toBeDefined();
    expect(missing!.headline).toContain("1 个提示词单元");
    expect(missing!.detail).toContain("研究员·research_worker.core");
  });

  it("集合文件无效:点名到角色与原因;陌生文件:点名到文件名", () => {
    const withStray: HarnessView = { ...FULL, strayToolSetFiles: ["workers.json"] };
    const issues = harnessGlobalIssues(withStray);
    const invalid = issues.find((i) => i.kind === "invalid_toolset");
    expect(invalid!.headline).toContain("1 个角色");
    expect(invalid!.detail).toContain("JSON 解析失败");
    const stray = issues.find((i) => i.kind === "stray_files");
    expect(stray!.detail).toContain("workers.json");
    expect(stray!.headline).toContain("不会被读取");
  });

  it("干净视图 ⇒ 空数组(渲染成「没有」,那是有据的「没有」);有问题时干净话**不许**出现", () => {
    const clean = harnessGlobalIssues({
      ...FULL,
      roles: [BM],
      strayToolSetFiles: [],
    });
    expect(clean).toEqual([]);
    const cleanHtml = renderToStaticMarkup(createElement(GlobalStatusBar, { view: { ...FULL, roles: [BM] } }));
    expect(visible(cleanHtml)).toContain("无缺失单元");

    const dirtyHtml = renderToStaticMarkup(createElement(GlobalStatusBar, { view: FULL }));
    expect(visible(dirtyHtml)).toContain("research_worker.core");
    expect(visible(dirtyHtml), "有问题却写着「无缺失」").not.toContain("无缺失单元");
  });
});

// ── ③ 深链接的读法:找不到不编 ──────────────────────────────────

describe("③ `?role=` 的读法:点名了精确找,找不到不编", () => {
  it("没点名 ⇒ 第一个角色(默认,不是「选错了」)", () => {
    expect(resolveSelectedRole(null, FULL.roles)).toBe(FULL.roles[0]);
  });

  it("点名了存在的角色 ⇒ 那一个", () => {
    expect(resolveSelectedRole("research_worker", FULL.roles)?.role).toBe("research_worker");
    expect(resolveSelectedRole("business_manager", FULL.roles)?.role).toBe("business_manager");
  });

  it("点名了不存在的角色 ⇒ null(**不静默退到第一个**),页面如实说「没有这个角色」", () => {
    expect(resolveSelectedRole("nope", FULL.roles)).toBeNull();
    expect(resolveSelectedRole("nope", FULL.roles), "找不到却退回了第一个角色 —— 指向空气的地址被伪装成成功").not.toBe(FULL.roles[0]);
    const html = renderToStaticMarkup(
      createElement(RoleDetailPane, detailProps({ role: null, requested: "nope" })),
    );
    expect(visible(html)).toContain("没有角色 nope");
    expect(visible(html), "页面上画出了别的角色 —— 静默替换了地址点名的对象").not.toContain("业务经理");
  });

  it("视图里没有任何角色 ⇒ 明说(与「点名了不存在」是两句话)", () => {
    const empty: HarnessView = { ...FULL, roles: [] };
    expect(resolveSelectedRole(null, empty.roles)).toBeNull();
    const html = renderToStaticMarkup(
      createElement(RoleDetailPane, detailProps({ role: null, view: empty, requested: null })),
    );
    expect(visible(html)).toContain("没有任何角色");
  });
});

// ── ④ 左列清单:角标与成员页签同源 ────────────────────────────────

describe("④ 左列角色清单:一行一角色,角标来自 roleIssueCount", () => {
  it("有问题的角色带角标(WK 四处),干净的角色没有 Pill(0 处不渲染)", () => {
    const html = renderToStaticMarkup(
      createElement(RoleListNav, {
        roles: [BM, WK],
        active: "research_worker",
        onSelect: vi.fn(),
      }),
    );
    expect((html.match(/data-tone="cinnabar"/g) ?? []).length, "角标数不是每个问题角色一个").toBe(1);
    expect(html).toMatch(/data-tone="cinnabar"[^>]*>4</);
  });

  it("选中态是 aria-current(键盘 / 读屏读得到「现在在看谁」)", () => {
    const html = renderToStaticMarkup(
      createElement(RoleListNav, {
        roles: [BM, WK],
        active: "business_manager",
        onSelect: vi.fn(),
      }),
    );
    expect((html.match(/aria-current="true"/g) ?? []).length).toBe(1);
    // ✅ 正样本自检:扫描器真的认得出这个属性
    expect(/aria-current="true"/.test('<button aria-current="true">x</button>')).toBe(true);
  });
});

// ── ⑤ 右列三段:同一批事实,不是第二套 ───────────────────────────

describe("⑤ 右列三段:单元 / 工具面 / 常量(事实全部来自共享件)", () => {
  it("三段标题齐全;单元行的状态词来自共享编辑器(已加载 / 缺失 / 备份数)", () => {
    const html = renderToStaticMarkup(createElement(RoleDetailPane, detailProps()));
    const text = visible(html);
    expect(text).toContain("提示词单元");
    expect(text).toContain("工具面");
    expect(text).toContain("代码内常量");
    // 单元行:状态词与数字都是 PromptUnitEditor 画的(共享件),这一页只是摆
    expect(text).toContain("已加载");
    expect(text).toContain("缺失");
    expect(text).toContain("备份 3");
    // 头部状态摘要与成员页签同一个判据(harnessStatusText)
    expect(text).toContain("单元 1/2 已加载");
    expect(text).toContain("文件无效 · 已退化成 ceiling 全集");
  });

  it("工具面段:注明「集合文件直接编辑」,路径原样给出,越权清单可见", () => {
    const html = renderToStaticMarkup(createElement(RoleDetailPane, detailProps()));
    const text = visible(html);
    expect(text).toContain("集合文件直接编辑上面这个文件");
    expect(text).toContain("/data/harness/tools/research_worker.json");
    expect(text).toContain("超出架构上界");
    expect(text).toContain("code.delete");
    expect(text).toContain("不存在的工具名");
    expect(text).toContain("board_writee");
  });

  it("常量段:标注「代码内常量,改不了」,ceiling 条目逐个摆出", () => {
    const text = visible(renderToStaticMarkup(createElement(RoleDetailPane, detailProps())));
    expect(text).toContain("代码内常量,改不了");
    expect(text).toContain("边界拒");
  });

  it("「求解不了」不许在这一页被显示成「0 个」(判据仍是共享的 toolCountText)", () => {
    const unsolved = role("coding_worker", "工程师", {
      toolsSolved: false,
      tools: [],
      promptUnits: [unit("coding_worker.core")],
    });
    const text = visible(
      renderToStaticMarkup(
        createElement(RoleDetailPane, detailProps({ role: unsolved, requested: "coding_worker" })),
      ),
    );
    expect(text).toContain("求解不了(组织未播种)");
    expect(text, "把「算不出来」显示成了「实得工具 0 个」").not.toContain("实得工具 0 个");
  });

  it("页面骨架(SSR):四态壳存在,取数失败的话是「读不到」不是「没有角色」", () => {
    const html = renderToStaticMarkup(createElement(HarnessManagePage));
    // SSR 下 useEffect 不跑 ⇒ 停在 loading;这一条钉的是「页面用的是 DataState」
    expect(html).toContain("正在读取 harness 视图");
    // 正样本自检:同一组件喂一份 error,ReadError 的前缀必须在
    expect(html).not.toContain("这个角色没有声明任何提示词单元");
  });
});

// ── ⑥ 源码哨兵:第二套状态判据不许出现 ────────────────────────────

describe("⑥ 哨兵:这一页的事实只来自 /api/harness(共享 hook)与共享组件", () => {
  const manage = source("routes/HarnessManage.tsx");

  it("编辑器是**复用**的(import 共享件),页面里没有自己的 textarea", () => {
    expect(manage).toContain('from "@/components/harness/PromptUnitEditor"');
    expect(manage).toContain('from "@/components/harness/Blocks"');
    expect(manage).toContain('from "@/components/harness/judgments"');
    expect(manage, "页面里手写了一个编辑区 —— 第二套编辑器").not.toContain("<textarea");
    // ✅ 正样本自检:扫描器认得出 textarea
    expect("<textarea".includes("<textarea")).toBe(true);
  });

  it("状态词不许在本页出现(它们只住在共享判据/编辑器里)", () => {
    // 这些词是共享件的输出;在页面里再写一遍 = 第二套判据(会漂开的那种)
    expect(manage, "「求解不了」写进了页面层").not.toContain("求解不了");
    expect(manage, "「已加载」的 Pill 写进了页面层").not.toMatch(/>\s*已加载/);
    expect(manage, "「缺失」的 Pill 写进了页面层").not.toMatch(/>\s*缺失/);
    expect(manage, "集合文件状态词写进了页面层").not.toContain("生效中");
    expect(manage, "集合文件状态词写进了页面层").not.toContain("文件无效");
    // ✅ 正样本自检:这些正则对真形态必须命中
    expect(/>\s*已加载/.test("<Pill>已加载</Pill>")).toBe(true);
    expect(/>\s*缺失/.test("<Pill>缺失</Pill>")).toBe(true);
  });

  it("`!u.loaded` 这个公式全站只许出现在共享判据一份里(missingUnits 的唯一实现)", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx") || p.endsWith(".ts")) {
          // 与本文件其余断言同一把尺:剥注释再扫(别处注释里讨论这个公式不该被误判)。
          if (stripComments(readFileSync(p, "utf8")).includes("!u.loaded")) {
            files.push(p.slice(WEB_SRC.length + 1));
          }
        }
      }
    };
    walk(WEB_SRC);
    // ✅ 正样本自检:扫描器认得出这个公式(否则上面那条「只有一份」是假绿)
    expect(stripComments("const x = a.filter((u) => !u.loaded);").includes("!u.loaded")).toBe(true);
    expect(files).toEqual(["components/harness/judgments.ts"]);
  });

  it("页面不直接 import api:读经共享 hook,写经共享编辑器", () => {
    expect(manage).not.toContain('from "@/lib/api"');
    expect(manage).toContain("useHarnessWorkspace");
  });

  it("选中态住在地址里(paramOf 读 `?role=`,setParam 写回)", () => {
    expect(manage).toContain('paramOf(loc, "role")');
    expect(manage).toContain('setParam("role"');
    // ✅ 正样本自检
    expect('paramOf(loc, "role")'.includes('paramOf(loc, "role")')).toBe(true);
  });
});
