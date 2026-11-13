/**
 * 设置页「供应商切换历史」· 折叠段的行为与接线哨兵
 *
 * ── 为什么这样分工(而不是整面板渲染)────────────────────────────
 *
 * `SettingsPanel` 从 zustand store 取数,而 zustand 在 `renderToStaticMarkup`
 * 下用的是 server snapshot(`setState` 再多次也读不到 —— 实测纪律写在
 * `tests/web/message-list.test.ts` 文件头);且懒加载判据活在 `useEffect` 里,
 * SSR **根本不执行 effect**。所以这里拆成两层:
 *
 *   · **纯函数 / 纯展示面**(导出自 `SettingsPanel.tsx`)用
 *     `renderToStaticMarkup` 真渲染 —— kind 标签、一行格式、空态文案;
 *   · **懒加载接线**用源码哨兵(stripComments,与 annotation-budget 同一
 *     剥法)钉住:`listProviderFailovers` 全文件**只出现一次**,且必须坐在
 *     带 `providerFailoverShouldFetch` 守卫的 `useEffect` 里 ——
 *     「常驻一次请求」(每次挂载就拉)或「多处各自拉」都会让哨兵变红。
 *
 * 哨兵的两条辅助判定都带**正负样本自检** —— 没有负样本的哨兵可能永远绿。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ProviderFailoverEntries,
  providerFailoverKindLabel,
  providerFailoverShouldFetch,
} from "../../web/src/components/settings/SettingsPanel";
import type { ProviderFailoverEntryView } from "@shared/types/platform";

const here = dirname(fileURLToPath(import.meta.url));
const settingsPanelSrc = readFileSync(
  join(here, "..", "..", "web", "src", "components", "settings", "SettingsPanel.tsx"),
  "utf8",
);

/** 与 `tests/web/annotation-budget.test.ts` 同一条剥法(剥少了 → 假红;剥多了 → 假绿)。 */
function stripComments(src: string): string {
  return (
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/(^|[^:"'`\\])\/\/[^\n"'`]*$/gm, "$1")
  );
}

const src = stripComments(settingsPanelSrc);

function entry(kind: ProviderFailoverEntryView["kind"], summary: string, createdAt = 1_700_000_000_000): ProviderFailoverEntryView {
  return { projectId: "p-1", sessionId: "s-1", createdAt, kind, summary };
}

const renderEntries = (entries: readonly ProviderFailoverEntryView[]): string =>
  renderToStaticMarkup(createElement(ProviderFailoverEntries, { entries }));

describe("kind 的一行话:已切换 / 已暂停,其它不猜", () => {
  it("failover ⇒ 已切换;brake ⇒ 已暂停;other ⇒ 其他(如实,不编)", () => {
    expect(providerFailoverKindLabel("failover")).toBe("已切换");
    expect(providerFailoverKindLabel("brake")).toBe("已暂停");
    expect(providerFailoverKindLabel("other")).toBe("其他");
  });
});

describe("懒加载判据 providerFailoverShouldFetch:展开了、且还没拉到过", () => {
  it("四个象限:折叠永不拉;展开且没拉过才拉;成功或失败之后都不再拉", () => {
    expect(providerFailoverShouldFetch(false, false)).toBe(false);
    expect(providerFailoverShouldFetch(false, true)).toBe(false);
    expect(providerFailoverShouldFetch(true, false)).toBe(true);
    expect(providerFailoverShouldFetch(true, true)).toBe(false);
  });
});

describe("列表本体:一行 = 时间 · 类别 · 通知首行", () => {
  it("failover 与 brake 各成一行,标签与首行原文都在", () => {
    const html = renderEntries([
      entry("failover", "⚠️ 供应商:已从 minimax-main 切到备用 provider deepseek-backup(原因:429)。"),
      entry("brake", "⚠️ 供应商:连续遇到 provider 故障(限流/断网类),自动派发已暂停,预计约 120 秒后自动重试(provider 恢复后无需人工干预)。"),
    ]);
    expect(html).toContain("已切换");
    expect(html).toContain("已暂停");
    expect(html).toContain("已从 minimax-main 切到备用 provider deepseek-backup");
    expect(html).toContain("自动派发已暂停");
  });

  it("空态:真的是拉过之后 0 条才说「还没有切换记录」", () => {
    const html = renderEntries([]);
    expect(html).toContain("还没有切换记录 —— 供应商一直在好好干活。");
    expect(html).not.toContain("已切换");
  });
});

describe("接线哨兵:懒加载必须真的懒(源码级)", () => {
  /**
   * 判定「拉取是否坐在带守卫的 effect 里」—— 抽成函数才能给它喂**正负样本**:
   * 没有负样本的哨兵,坏掉时(比如抽取逻辑失效)的表现是**永远绿**。
   */
  function failoverFetch(stripped: string): { count: number; guarded: boolean } {
    const calls = [...stripped.matchAll(/listProviderFailovers\(/g)];
    if (calls.length === 0) return { count: 0, guarded: false };
    const idx = stripped.indexOf("listProviderFailovers(");
    const effectStart = stripped.lastIndexOf("useEffect(", idx);
    const guarded =
      effectStart !== -1 &&
      stripped.slice(effectStart, idx).includes("providerFailoverShouldFetch(");
    return { count: calls.length, guarded };
  }

  // 自检的正负样本(合成源码,不依赖真实文件长什么样)
  const GOOD = `useEffect(() => {
    if (!providerFailoverShouldFetch(open, done)) return;
    const p = listProviderFailovers();
  }, [open, done]);`;
  const UNGUARDED = `const p = listProviderFailovers();`;
  const EAGER_PLUS_LAZY = `const eager = listProviderFailovers();
  useEffect(() => { if (!providerFailoverShouldFetch(open, done)) return; listProviderFailovers(); }, [open]);`;

  it("自检:好样本通过,无守卫 / 双重拉取被抓出来", () => {
    expect(failoverFetch(GOOD)).toEqual({ count: 1, guarded: true });
    expect(failoverFetch(UNGUARDED)).toEqual({ count: 1, guarded: false });
    expect(failoverFetch(EAGER_PLUS_LAZY).count).toBe(2);
  });

  it("SettingsPanel:拉取恰好一次,且在守卫之内(常驻请求 / 多处拉取都红)", () => {
    const r = failoverFetch(src);
    expect(r.count, "listProviderFailovers 全文件只许出现一次(多一处 = 多一次请求)").toBe(1);
    expect(r.guarded, "拉取必须坐在 providerFailoverShouldFetch 守卫的 useEffect 里").toBe(true);
  });

  it("折叠段与四态构造器都在:Disclosure 摘要 + remoteListOf(不手写三元链)", () => {
    expect(src).toContain('summary="供应商切换历史(近 20 条)"');
    expect(src).toContain("remoteListOf(");
    expect(src).toContain("<DataState");
  });
});
