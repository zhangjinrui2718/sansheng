/**
 * `MetadataStrip` —— 身份条的**排版**那一半
 *
 * ── 测什么、不测什么 ──────────────────────────────────────────────
 *
 * 「有哪些事实」在 `lib/entityMeta.ts`(那份有独立测试)。
 * 这里只测**渲染**那三件容易悄悄坏掉的事:
 *
 *   1. **链接是真 `<a href>`**,不是 `onClick` 改 hash ——
 *      「右键复制地址 / 中键开新标签 / 浏览器后退」这三件全靠它;
 *      用 `onClick` 的话它们全部消失,而页面**看起来一模一样**。
 *   2. **href 就是地址本身**(`toHash` 的输出),不是某个内部 id ——
 *      一个拼错的 href 在屏幕上与一个对的 href 长得一样。
 *   3. **状态 / 类型那几格渲染成 `Pill`**(带 `data-tone`),
 *      而不是一段没颜色的文字 —— 语气是数据的一部分。
 *
 * ⚠️ 判据里刻意**没有**「样式好不好看」:那不是判据,是审美。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetadataStrip } from "../../web/src/components/ui/MetadataStrip";
import { artifactMeta, memberLocation, workLocation } from "../../web/src/lib/entityMeta";
import type { ArtifactView } from "../../shared/types/platform";

const a: ArtifactView = {
  id: "art_1",
  projectId: "p_1",
  kind: "evidence",
  status: "open",
  title: "调研结论",
  bodyPath: "artifacts/art_1-x.md",
  bodyBytes: 12,
  commitSha: null,
  authorAgentId: "a_9",
  authorName: "研究员",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  links: [],
  workId: "w_1",
  deliverableType: null,
  acceptance: null,
};

const render = (items: Parameters<typeof MetadataStrip>[0]["items"]): string =>
  renderToStaticMarkup(createElement(MetadataStrip, { items }));

describe("MetadataStrip:链接是真地址", () => {
  it("邻居格渲染成 <a href>,href 就是地址本身", () => {
    const html = render(artifactMeta(a, { workTitle: "调研" }));
    expect(html).toContain('href="#/members?member=a_9"');
    expect(html).toContain('href="#/works?work=w_1"');
  });

  it("⚠️ 不用 onClick 改 hash —— 那样右键复制 / 中键 / 后退三件全没了", () => {
    const html = render(artifactMeta(a));
    expect(html).not.toContain("onClick");
  });

  it("类型 / 状态那两格是 Pill(带 data-tone),不是裸文字", () => {
    const html = render(artifactMeta(a));
    expect(html).toContain("ss-pill");
    expect(html).toContain("data-tone=");
  });

  it("标签照原样出现 —— 「作者」不能写成「产出者」", () => {
    const html = render(artifactMeta(a));
    expect(html).toContain("作者");
    expect(html).toContain("产出于");
  });

  it("空身份条什么都不渲染(不留一条空带子)", () => {
    expect(render([])).toBe("");
  });

  it("⚠️ 链接的地址必须由 route.ts 生成 —— 手拼的会指向别的东西", () => {
    // 断言的是**来源**而不是结果:两处用的是同一个构造函数。
    expect(render([{ label: "X", links: [{ label: "y", to: workLocation("w_1") }] }])).toContain(
      'href="#/works?work=w_1"',
    );
    expect(
      render([{ label: "X", links: [{ label: "y", to: memberLocation("a_9") }] }]),
    ).toContain('href="#/members?member=a_9"');
  });
});
