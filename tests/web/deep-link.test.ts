/**
 * 「项目坐标」—— 跨项目的地址带项目、坐标过期就清掉
 *
 * ── 为什么要有这一份 ──────────────────────────────────────────────
 *
 * 这个应用里的实体大半是**项目级**的(工件、工作项、成员、阻塞、语料块),
 * 而「当前项目」是应用里的一处**全局选择**(store 的 `projectId`)。
 * ⇒ 指向别的项目的地址必须带 `?project=`,否则它是**半个地址**:
 * 「点得动、跳得过去、就是找不到」,而链接**看起来完全正常**。
 *
 * ⚠️ **这个机制踩过一个坑**:改版前 `routes/ProjectDetail.tsx` 有一份自己的
 * `?project=` 效果(每次渲染都看地址里的项目就切过去)⇒ **用户从左栏切了项目**
 * ⇒ 那个效果又把他拽回去 ⇒ 「切项目」这个动作被撤销,症状是「点左栏没反应」。
 * ⇒ 现在这件事**只有一处**做(`lib/deepLink.ts`),并且**坐标过期就清掉**。
 *
 * ── 测什么 ────────────────────────────────────────────────────────
 *
 * 1. **判据**(`shouldApplyProjectCoordinate`,纯函数):五种走法 + 负样本。
 * 2. **接线**(源码级):只有一处判据、页面不再自己切、语料来源是真链接。
 * 3. **地址**:跨项目的那几条**真的带坐标**(逐字比对 href)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  INITIAL_COORDINATE_STATE,
  decideCoordinate,
  shouldApplyProjectCoordinate,
} from "../../web/src/lib/deepLink";
import {
  chunkSourceLabel,
  chunkSourceLocation,
  withProjectCoordinate,
} from "../../web/src/lib/entityMeta";
import { toHash } from "../../web/src/lib/route";
import { shouldClearSelection } from "../../web/src/lib/route";
import type { KnowledgeChunkView } from "../../shared/types/platform";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string =>
  readFileSync(join(here, "..", "..", rel), "utf8");

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const deepLink = read("web/src/lib/deepLink.ts");
const app = read("web/src/App.tsx");
const projectDetail = read("web/src/routes/ProjectDetail.tsx");
const memory = read("web/src/routes/Memory.tsx");
const entityMeta = read("web/src/lib/entityMeta.ts");

const chunk = (over: Partial<KnowledgeChunkView> = {}): KnowledgeChunkView => ({
  id: "chk_1",
  sourceKind: "artifact",
  sourceId: "art_7",
  projectId: "p_2",
  projectName: "第二个项目",
  artifactId: "art_7",
  artifactTitle: "调研结论",
  bodyPath: "artifacts/art_7-x.md",
  commitSha: null,
  messageId: null,
  seq: 0,
  offset: 0,
  length: 120,
  updatedAt: 1_700_000_000_000,
  state: "ok",
  problem: null,
  excerpt: "……",
  text: "……",
  tier: "primary",
  tierNote: null,
  ...over,
});

describe("判据:地址里的项目坐标该不该切", () => {
  it("地址里没有坐标 ⇒ 不切", () => {
    expect(shouldApplyProjectCoordinate(null, "p_1", ["p_1", "p_2"], null)).toBe(false);
  });

  it("已经在看它 ⇒ 不切", () => {
    expect(shouldApplyProjectCoordinate("p_1", "p_1", ["p_1"], null)).toBe(false);
  });

  it("⚠️ 这个坐标已经用过了 ⇒ 不切(用户自己切了项目,地址里的坐标过期了)", () => {
    // 这一条是「切项目」与「地址点名」不再互相撤销的关键。
    expect(shouldApplyProjectCoordinate("p_1", "p_2", ["p_1", "p_2"], "p_1")).toBe(false);
  });

  it("地址点名的项目不在列表里 ⇒ 不切(那是**指向空气的地址**)", () => {
    expect(shouldApplyProjectCoordinate("p_9", "p_1", ["p_1", "p_2"], null)).toBe(false);
  });

  it("⚠️ 列表还没读到(空数组)⇒ 仍然切 —— 列表没到 ≠ 项目不存在", () => {
    expect(shouldApplyProjectCoordinate("p_2", "p_1", [], null)).toBe(true);
  });

  it("正常情况 ⇒ 切", () => {
    expect(shouldApplyProjectCoordinate("p_2", "p_1", ["p_1", "p_2"], null)).toBe(true);
  });
});

describe("决策:三条走法(纯函数,可直接测)", () => {
  const base = { applied: null };

  it("地址点名了别的项目 ⇒ 切过去,并记下「这个坐标用过了」", () => {
    const d = decideCoordinate(base, { wanted: "p_2", projectId: "p_1", known: ["p_1", "p_2"] });
    expect(d.switchTo).toBe("p_2");
    expect(d.clear).toBe(false);
    expect(d.state.applied).toBe("p_2");
  });

  it("已经在看它 ⇒ 什么都不做(但记下坐标用过了)", () => {
    const d = decideCoordinate(base, { wanted: "p_1", projectId: "p_1", known: ["p_1"] });
    expect(d.switchTo).toBeNull();
    expect(d.clear).toBe(false);
    expect(d.state.applied).toBe("p_1");
  });

  it("⚠️ 用户自己切了项目 ⇒ **清掉地址里的坐标**(而不是把他拽回去)", () => {
    // 切过去之后状态是 applied=p_2;现在用户把项目换成了 p_3 ⇒ 坐标过期。
    const d = decideCoordinate(
      { applied: "p_2" },
      { wanted: "p_2", projectId: "p_3", known: ["p_1", "p_2", "p_3"] },
    );
    expect(d.switchTo).toBeNull();
    expect(d.clear).toBe(true);
    expect(d.state.applied).toBeNull();
  });

  it("切过去之后的那一轮 ⇒ 不切、不清(否则会把自己刚做的事撤销)", () => {
    const d = decideCoordinate(
      { applied: "p_2" },
      { wanted: "p_2", projectId: "p_2", known: ["p_1", "p_2"] },
    );
    expect(d.switchTo).toBeNull();
    expect(d.clear).toBe(false);
  });

  it("地址里没有坐标 ⇒ 什么都不做,记据也清掉", () => {
    const d = decideCoordinate({ applied: "p_2" }, { wanted: null, projectId: "p_2", known: [] });
    expect(d.switchTo).toBeNull();
    expect(d.clear).toBe(false);
    expect(d.state.applied).toBeNull();
  });

  it("⚠️ 地址点名的项目不存在 ⇒ 不切、不清(指向空气的地址)", () => {
    const d = decideCoordinate(base, { wanted: "p_9", projectId: "p_1", known: ["p_1"] });
    expect(d.switchTo).toBeNull();
    expect(d.clear).toBe(false);
  });
});

describe("接线:只有一处判据", () => {
  it("应用外壳挂了一次坐标落地", () => {
    expect(app).toContain("useProjectCoordinate()");
  });

  it("⚠️ 页面不许再自己切项目 —— 两处判断会互相撤销", () => {
    expect(stripComments(projectDetail)).not.toContain("selectProject(wantedProject)");
    expect(stripComments(projectDetail)).not.toMatch(/paramOf\(loc, "project"\)/);
  });

  it("坐标过期就清掉(而不是让它把用户拽回去)", () => {
    expect(stripComments(deepLink)).toContain('setParam("project", null)');
  });
});

describe("地址:语料的来源是**真地址**", () => {
  it("工件来源 ⇒ 工作项页 + 工件 + **项目坐标**", () => {
    const to = chunkSourceLocation(chunk());
    expect(to).not.toBeNull();
    expect(toHash(to!)).toBe("#/works?artifact=art_7&project=p_2");
  });

  it("消息来源 ⇒ 那个项目的对话页 + **项目坐标**", () => {
    const to = chunkSourceLocation(
      chunk({
        sourceKind: "message",
        sourceId: "msg_3",
        artifactId: null,
        artifactTitle: null,
        messageId: "msg_3",
      }),
    );
    expect(to).not.toBeNull();
    expect(toHash(to!)).toBe("#/chat?project=p_2");
  });

  it("⚠️ 拿不到项目 ⇒ 不编地址(半个地址比没有地址更坏)", () => {
    expect(chunkSourceLocation(chunk({ projectId: null }))).toBeNull();
  });

  it("标签与地址同源(不许各说各的)", () => {
    expect(chunkSourceLabel(chunk())).toBe("调研结论");
    expect(chunkSourceLabel(chunk({ artifactTitle: null }))).toBe("art_7");
  });

  it("页面把来源渲染成真 `<a href>`", () => {
    const body = stripComments(memory);
    expect(body).toContain("<a href={toHash(sourceTo)}>");
    // ⚠️ 不许用 onClick 改 hash —— 右键复制 / 中键 / 后退三件全靠真 href。
    expect(body).not.toMatch(/onClick=[^>]*sourceTo/);
  });
});

describe("深链接落地:坐标带来的换项目**不许抹掉选中项**", () => {
  it("坐标 = 新项目 ⇒ 不清(地址里的选中项本来就是给那个项目写的)", () => {
    expect(
      shouldClearSelection({ mounted: true, projectId: "p_1" }, "p_2", "p_2"),
    ).toBe(false);
  });

  it("⚠️ 坐标 = 旧项目 ⇒ 清(那是用户自己切的项目)", () => {
    expect(
      shouldClearSelection({ mounted: true, projectId: "p_1" }, "p_2", "p_1"),
    ).toBe(true);
  });

  it("没有坐标 ⇒ 清(项目变了,旧的 id 不再成立)", () => {
    expect(shouldClearSelection({ mounted: true, projectId: "p_1" }, "p_2")).toBe(true);
  });

  it("工作项页把坐标传进去(判据不许只写在 lib 里)", () => {
    expect(stripComments(read("web/src/routes/Works.tsx"))).toContain(
      "shouldClearSelection(prev, scope, addressProject)",
    );
  });
});

describe("地址构造器:坐标只有一处加", () => {
  it("withProjectCoordinate 补上 project,不带项目就不补", () => {
    const loc = { route: "works" as const, params: { artifact: "art_7" } };
    expect(withProjectCoordinate(loc, "p_2").params).toEqual({
      artifact: "art_7",
      project: "p_2",
    });
    expect(withProjectCoordinate(loc, null).params).toEqual({ artifact: "art_7" });
  });

  it("⚠️ 页面不许自己拼 `project=` 参数", () => {
    const pages = ["web/src/routes/Memory.tsx", "web/src/routes/Works.tsx", "web/src/routes/Members.tsx"];
    for (const p of pages) {
      expect(stripComments(read(p))).not.toMatch(/project:\s*[a-zA-Z]/);
    }
    expect(entityMeta).toContain("withProjectCoordinate");
  });
});
