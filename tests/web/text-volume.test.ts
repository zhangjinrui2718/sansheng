/**
 * 批次 UI U4 —— 「默认上屏文字量」的回归守护
 *
 * 背景:2026-10-02 用户提出「前端展示的文字内容太多,而且 view 的结构不太适合人阅读」。
 * 那一批做的事:把大量**开发者自述**从页面正文搬进 `title=`(悬停)/
 * `<Disclosure>`(点开)/ 文件注释,并压掉了几处结构噪声(三段说明共存的分区标题、
 * 重复渲染的错误块、从来没被用过的 placeholder 死 prop …)。
 * 结果:默认上屏的中文字数 **3040 → 2039(-33%)**,一个字都没丢,只是不再
 * 要求所有人读。
 *
 * 为什么要写这个测试:「字变少了」本来是个主观说法,下一批很容易又写回去
 * (本仓库此前就是这样来回漂的 —— 同一个 STATUS_LABEL 在两个页面写着两种读法)。
 * 这里给它一个每次都能重跑的、可断言的口径。
 *
 * 口径见 `scripts/web-text-volume.mjs` 的文件头。要点与**已知偏差**:
 *   - 剥注释后,只数中文字符,且只数字符串字面量 / JSX 文本节点里的;
 *   - `title=` / `hintTitle=` 的值不算(悬停才出现);
 *   - `<Disclosure>` 整块不算(默认收起);
 *   - 只在隐藏位置被引用的 `*_NOTE` / `*_HINT` / `*_TITLE` 类常量不算;
 *   - `Clamp` 的内容**算**(它默认露出 2–3 行);
 *   - 它是静态估算,不等价于「在浏览器里数一遍 DOM」,逐条字面量也有重复计数。
 *   所以下面的预算留了 15–20% 余量,它是**回归线**不是配额。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { measure } from "../../scripts/web-text-volume.mjs";

const REPO = process.cwd();
const WEB_SRC = join(REPO, "web/src");

/** 每页的默认上屏中文字数上限(= 现值 + 约 15–20% 余量)。 */
const BUDGET: Record<string, number> = {
  "App.tsx": 60,
  "components/shell/TopBar.tsx": 25,
  "components/shell/HistoryRail.tsx": 40,
  "components/shell/AgentPanel.tsx": 60,
  "components/chat/ChatSurface.tsx": 60,
  "components/chat/ChatComposer.tsx": 70,
  "components/chat/MessageList.tsx": 35,
  "components/chat/ThinkingBlock.tsx": 10,
  "components/chat/ToolCallCard.tsx": 5,
  "components/settings/SettingsPanel.tsx": 200,
  "routes/Agents.tsx": 460,
  "routes/Artifacts.tsx": 350,
  "routes/Goals.tsx": 100,
  "routes/Harness.tsx": 700,
  "routes/Memory.tsx": 70,
  "routes/Timeline.tsx": 210,
};

/**
 * U4 之前(b30a3d0)的实测值,用来证明这一批确实减了。
 * 记的是**旧页面**的字,不是「旧页面的行数」。
 */
const PRE_U4: Record<string, number> = {
  "routes/Agents.tsx": 639,
  "routes/Artifacts.tsx": 412,
  "routes/Harness.tsx": 1014,
  "routes/Timeline.tsx": 217,
  "routes/Goals.tsx": 131,
  "components/settings/SettingsPanel.tsx": 254,
  "components/chat/MessageList.tsx": 43,
  "components/chat/ChatComposer.tsx": 67,
  "components/shell/AgentPanel.tsx": 71,
};

const counts = new Map<string, number>(
  Object.keys(BUDGET).map((rel) => [rel, measure(readFileSync(join(WEB_SRC, rel), "utf8"))]),
);

const total = [...counts.values()].reduce((a, b) => a + b, 0);

describe("U4 · 默认上屏文字量不超过预算", () => {
  for (const [rel, budget] of Object.entries(BUDGET)) {
    it(`${rel} ≤ ${budget} 字(现 ${counts.get(rel) ?? "?"})`, () => {
      expect(counts.get(rel) ?? 0).toBeLessThanOrEqual(budget);
    });
  }

  it(`全站合计 ≤ 2350 字(U4 之前 3040,现 ${total})`, () => {
    expect(total).toBeLessThanOrEqual(2350);
  });
});

describe("U4 · 重点页面确实比 U4 之前少", () => {
  for (const [rel, before] of Object.entries(PRE_U4)) {
    it(`${rel} < ${before}(现 ${counts.get(rel) ?? "?"})`, () => {
      expect(counts.get(rel) ?? 0).toBeLessThan(before);
    });
  }

  // Memory 页是唯一的例外,且是有意的:它从 29 字的**两列裸列表**变成 50 字的
  // 「按 kind 分组 + 真实计数 + 置信度/证据/观察时间」——多出来的字全部是
  // **以前根本没显示的字段标签**,不是说明文字。它不受「必须变少」约束,
  // 但仍受上面的总量预算约束。
  it("Memory 页的增量是数据字段标签,不是说明文字(受总量预算约束即可)", () => {
    expect(counts.get("routes/Memory.tsx") ?? 0).toBeLessThanOrEqual(70);
  });
});

describe("U4 · 开发者自述不再以正文形态挂在页面上", () => {
  /**
   * 断言针对**代码**,不是注释。各页面的文件头注释里**应该**保留
   * 「原来的 ① 意图头 已删」这类说明(那是搬走文字的正确去处),
   * 所以先剥掉注释再判定,与 tests/web/c10-dead-code.test.ts 同一手法。
   */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("各页面不再出现产品设计文档的行号式分区名", () => {
    for (const rel of ["routes/Agents.tsx", "routes/Artifacts.tsx", "routes/Harness.tsx"]) {
      const src = stripComments(readFileSync(join(WEB_SRC, rel), "utf8"));
      // 「① 意图头」「② DAG 区」这类是 docs/PRODUCT-DESIGN 的行号,对读者零信息量。
      expect(src, rel).not.toMatch(/[①②③④⑤]\s*(意图头|DAG|阻塞队列|沉淀区|雇员手册|配置)/);
    }
  });

  it("工件页不再有每卡 6 段的 LifecycleTrack 装饰", () => {
    expect(stripComments(readFileSync(join(WEB_SRC, "routes/Artifacts.tsx"), "utf8"))).not.toContain(
      "LifecycleTrack",
    );
  });
});
