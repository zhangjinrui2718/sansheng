/**
 * `EntityInspector` —— 实体抽屉(右侧)
 *
 * ── 测什么、不测什么 ──────────────────────────────────────────────
 *
 * **测**:① 三段(事实 / 关系 / 内容)各归各位;② 拿不到的那一段**整段不出现**
 *   (不是「空的一段」——「没有关系」与「关系读不到」在屏幕上长得一样);
 *   ③ **抽屉不许自己算事实、不许自己拼地址**(源码级);
 *   ④ 接线:工件详情**只住在抽屉里**,开关是地址里的 `artifact=`。
 *
 * **不测**:样式好不好看(审美不是判据)、点一下会不会动
 * —— 本仓的 web 测试跑在 `environment: "node"`,没有 DOM,
 * 所以交互只能**源码级**断言(判据写在下面,不假装测过)。
 *
 * ⚠️ **扫描器自检**:每条源码级判据都带一个**正样本**(必须命中)与
 * 一个**负样本**(必须不命中)—— 否则「0 命中」可能只是扫描器写错了
 * (AGENTS.md 第三节:一个坏掉的检查返回一个看起来正常的答案)。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { EntityInspector } from "../../web/src/components/shell/EntityInspector";
import { artifactMeta } from "../../web/src/lib/entityMeta";
import type { RelationContext } from "../../web/src/lib/relations";
import type { ArtifactView, WorkView } from "../../shared/types/platform";

const artifact: ArtifactView = {
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

const work: WorkView = {
  id: "w_1",
  projectId: "p_1",
  parentWorkId: null,
  title: "调研",
  goal: "把问题搞清楚",
  status: "done",
  assigneeAgentId: "a_9",
  assigneeName: "研究员",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  dependsOn: [],
};

const context: RelationContext = {
  projectId: "p_1",
  works: { data: [work], loading: false, error: null },
  artifacts: { data: [artifact], loading: false, error: null },
};

const render = (props: Partial<Parameters<typeof EntityInspector>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(EntityInspector, {
      title: "调研结论",
      items: artifactMeta(artifact, { workTitle: "调研" }),
      subject: { kind: "artifact", artifact },
      context,
      onClose: () => {},
      ...props,
    }),
  );

/**
 * 剥掉注释再扫。
 *
 * ⚠️ **必须剥** —— 判据那句话本身写在抽屉的注释里
 * (「抽屉文件里不许出现 `fmtTime(`」),不剥就等于**判据把自己判红了**。
 * 这不是扫得太宽,是扫的对象错了:注释不是代码。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n"'`]*$/gm, "$1");
}

const inspectorSrc = stripComments(
  readFileSync("web/src/components/shell/EntityInspector.tsx", "utf8"),
);
const worksSrc = stripComments(readFileSync("web/src/routes/Works.tsx", "utf8"));

describe("EntityInspector:三段各归各位", () => {
  it("事实段来自 entityMeta 的构造器(标签照原样出现)", () => {
    const html = render();
    expect(html).toContain("事实");
    expect(html).toContain("作者");
    expect(html).toContain("产出于");
  });

  it("关系段在场(关系项是**地址**,不是纯文本)", () => {
    const html = render();
    expect(html).toContain("关系");
    // 「产出于」那条关系指向工作项 ⇒ 抽屉里有一条能点的地址
    expect(html).toContain('href="#/works?work=w_1"');
  });

  it("内容槽按调用点给的东西渲染", () => {
    const html = render({ children: createElement("p", null, "正文在这儿") });
    expect(html).toContain("正文在这儿");
  });

  it("遮罩与面板是两个元素(点面板不许关抽屉)", () => {
    const html = render();
    expect(html).toContain("ss-inspector-overlay");
    expect(html).toContain("ss-inspector");
  });
});

describe("EntityInspector:拿不到的那一段整段不出现", () => {
  it("`items = []` ⇒ 没有「事实」这一段(不是一段空的)", () => {
    const html = render({ items: [] });
    expect(html).not.toContain("事实");
    expect(html).toContain("关系");
  });

  it("`subject = null` ⇒ 没有「关系」这一段(不是「没有关系」)", () => {
    const html = render({ subject: null });
    expect(html).not.toContain("关系");
    expect(html).toContain("事实");
  });
});

describe("EntityInspector:它不许自己算事实、不许自己拼地址", () => {
  it("⚠️ 事实只能来自 entityMeta —— 抽屉里不许出现格式化调用", () => {
    // 扫描器自检:**正样本**必须命中(否则下面那个「0 命中」可能只是扫描器写错了)
    expect(/\bfmtTime\(/.test("const x = fmtTime(123);")).toBe(true);
    expect(/\bartifactKindLabel\(/.test("const y = artifactKindLabel(a.kind);")).toBe(true);
    // 负样本:抽屉文件里一个都不许有
    expect(inspectorSrc).not.toMatch(/\bfmtTime\(/);
    expect(inspectorSrc).not.toMatch(/\bartifactKindLabel\(/);
    expect(inspectorSrc).not.toMatch(/\bworkStatusLabel\(/);
    expect(inspectorSrc).not.toMatch(/\bblockerStatusLabel\(/);
  });

  it("⚠️ 地址只能来自 lib —— 抽屉里不许自己拼 href", () => {
    // 扫描器自检:正样本必须命中
    expect(/\btoHash\(/.test('const h = toHash(loc);')).toBe(true);
    // 负样本
    expect(inspectorSrc).not.toMatch(/\btoHash\(/);
    expect(inspectorSrc).not.toContain("href=");
  });

  it("关抽屉的三条路都在(关闭按钮 / 遮罩 / ESC)", () => {
    // 正样本:ESC 的判据
    expect(inspectorSrc).toContain('e.key === "Escape"');
    // 三处绑定
    expect(inspectorSrc.match(/onClose/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("工件详情:只住在抽屉里", () => {
  it("⚠️ 工件行不再内联展开详情(否则同一实体有两个渲染面)", () => {
    expect(worksSrc).toContain("<EntityInspector");
    expect(worksSrc).not.toContain("<ArtifactDetail");
  });

  it("开关仍然是地址里的 `artifact=` ⇒ 深链接照旧成立", () => {
    const at = worksSrc.indexOf("<EntityInspector");
    const guard = worksSrc.indexOf("openId !== null &&");
    expect(at).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(at);
  });
});
