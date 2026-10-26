/**
 * 「关于」页 —— 说明书的三张表,以及它与页签的边界
 *
 * ── 它盯的是什么 ────────────────────────────────────────────────────
 *
 * 第一刀把 27 处悬停解释收进 `lib/glossary.ts`(页面上不再有长注解),于是解释
 * **必须有一个查得到的地方**,否则「删注释」就变成了「删信息」。这一页是那地方。
 *
 * 三条判据,每条都是「看起来正常但其实空了」的那种失败:
 *
 *   ① **条目全渲染** —— `GLOSSARY` 的键是闭合联合,少渲染一条**不会报错**,
 *      只是用户永远读不到它。所以逐条比对,不是数个数。
 *   ② **没有空条目** —— `line / basis / source` 任一为空 ⇒ 屏幕上出现一行空白,
 *      而空白在 chrome 里与「这页坏了」长得一样。
 *   ③ **「关于」不是第七个页签** —— 导航恒 6 项(`AGENTS.md` 那条判据)。
 *      它由顶栏末尾的 `?` 打开;哪天有人图省事把它塞进 `TABS`,导航就变成 7 项了。
 *
 * ⚠️ 源码扫描先剥注释:这几份文件里都有解释「为什么这么放」的注释,裸 grep 会
 * 命中注释里的反面教材(交付物 iframe 那条判据吃过这个亏:报 3 处,剥完是 0)。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AboutPage } from "../../web/src/routes/About";
import { GLOSSARY, KNOWN_GAPS } from "../../web/src/lib/glossary";
import type { GlossaryId } from "../../web/src/lib/glossary";

const WEB_SRC = join(process.cwd(), "web/src");
const readWebSrc = (rel: string): string => readFileSync(join(WEB_SRC, rel), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const source = (rel: string): string => stripComments(readWebSrc(rel));

const html = (): string => renderToStaticMarkup(createElement(AboutPage));
const IDS = Object.keys(GLOSSARY) as GlossaryId[];

describe("关于页 · 词汇表全渲染", () => {
  it("每一条 `line` 都在页面上(逐条比对,不是数个数)", () => {
    const s = html();
    for (const id of IDS) expect(s, `缺 ${id}`).toContain(GLOSSARY[id].line);
  });

  it("每一条 `basis` 与 `id` 也在(`?` 点开看到的是同一份数据)", () => {
    const s = html();
    for (const id of IDS) {
      expect(s).toContain(id);
      // basis 里有 `<` / `>` 的会被转义,只验前 12 个字符这一段足够定位
      expect(s).toContain(GLOSSARY[id].basis.slice(0, 12));
    }
  });

  it("**没有空条目** —— 空的行在界面上等于「这页坏了」", () => {
    for (const id of IDS) {
      expect(GLOSSARY[id].line.trim(), id).not.toBe("");
      expect(GLOSSARY[id].basis.trim(), id).not.toBe("");
      expect(GLOSSARY[id].source.trim(), id).not.toBe("");
    }
  });

  it("自检:上一次渲染**真的**进了 html(否则上面几条是恒真的)", () => {
    const s = html();
    expect(s).toContain("词汇表");
    expect(s).not.toContain("__不存在的条目__");
    // 负样本:一个真条目的 line 必须能在 html 里找到,改一个字符就找不到 ⇒ 比对有效
    const first = GLOSSARY[IDS[0]].line;
    expect(s).toContain(first);
    expect(s).not.toContain(`${first}__x`);
  });
});

describe("关于页 · 四态", () => {
  it("四支各有一行,**顺序即判据**(还没查过 / 读失败 / 读不到 / 拿到了)", () => {
    const s = html();
    for (const word of ["还没查过", "读失败", "查完了但读不到", "拿到了"]) {
      expect(s, `缺 ${word}`).toContain(word);
    }
    // 顺序 = 判据:先问「拿到了吗」,再问「为什么没拿到」
    expect(s.indexOf("还没查过")).toBeLessThan(s.indexOf("读失败"));
    expect(s.indexOf("读失败")).toBeLessThan(s.indexOf("查完了但读不到"));
    expect(s.indexOf("查完了但读不到")).toBeLessThan(s.indexOf("拿到了"));
  });

  it("四态指向的落点是真的(`DataState.tsx` 里确实有这个判别联合)", () => {
    const ds = source("components/ui/DataState.tsx");
    for (const kind of ["loading", "error", "unavailable", "ready"]) {
      expect(ds, `DataState 缺 ${kind}`).toContain(`kind: "${kind}"`);
    }
  });
});

describe("关于页 · 已知不实之处", () => {
  it("每一条的 `what` / `where` 都渲染出来(缺口写成清单,不留给读者猜)", () => {
    const s = html();
    for (const g of KNOWN_GAPS) {
      expect(s, `缺 ${g.what}`).toContain(g.what);
      expect(s, `缺落点:${g.what}`).toContain(g.where.slice(0, 12));
    }
  });

  it("**没有空条目** —— 一条空缺口比没有缺口更糟", () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
    for (const g of KNOWN_GAPS) {
      expect(g.what.trim()).not.toBe("");
      expect(g.why.trim()).not.toBe("");
      expect(g.where.trim()).not.toBe("");
    }
  });

  it("不重复:同一个 `what` 只许出现一条", () => {
    const whats = KNOWN_GAPS.map((g) => g.what);
    expect(new Set(whats).size).toBe(whats.length);
  });
});

describe("接线 · 「关于」是 `?`,不是第七个页签", () => {
  it("TopBar 里有那个入口,且它走 `onRoute(\"about\")`", () => {
    const tb = source("components/shell/TopBar.tsx");
    expect(tb).toContain('label="?"');
    expect(tb).toContain('onRoute("about")');
  });

  it("**`TABS` 仍然恒 6 项,且里面没有 about**", () => {
    const tb = source("components/shell/TopBar.tsx");
    const block = tb.slice(tb.indexOf("const TABS"), tb.indexOf("];", tb.indexOf("const TABS")));
    const routes = block.match(/\{ route: "/g) ?? [];
    expect(routes.length).toBe(6);
    expect(block).not.toContain('"about"');
    // 变异自检:把 about 塞进 TABS ⇒ 上面两条当场变红(这里模拟一次)
    const mutated = block.replace('{ route: "chat", label: "对话" },', '{ route: "chat", label: "对话" },\n  { route: "about", label: "关于" },');
    expect(mutated).toContain('"about"');
    expect((mutated.match(/\{ route: "/g) ?? []).length).toBe(7);
  });

  it("App 里 `about` 是一条真的路由(不是只在 union 里声明)", () => {
    const app = source("App.tsx");
    expect(app).toMatch(/\| "about"/);
    expect(app).toContain('import { AboutPage } from "./routes/About"');
    expect(app).toContain('<AboutPage />');
    // 变异自检:只加 union 不接分支 ⇒ 这一格必须能抓到
    const unionOnly = app.replace("        <AboutPage />\n", "");
    expect(unionOnly).not.toContain("<AboutPage />");
  });
});
