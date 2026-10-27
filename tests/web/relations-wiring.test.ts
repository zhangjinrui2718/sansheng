/**
 * 「一圈邻居」的**接线** —— 源码级哨兵
 *
 * ── 为什么要有这一份 ──────────────────────────────────────────────
 *
 * `tests/web/relations.test.ts` 测的是判据(`relationsOf`)与排版(`RelationsRail`)。
 * 但**没有读者**的判据等于没有判据 —— 本仓库吃过这个亏:
 * `project_close` 逻辑写得好好的、零自动触发方;`useProjectUsage` 钩子写好了、
 * 零渲染点。
 *
 * ⇒ 这一份钉的是**「谁在用」**:
 *   1. 三个页面都真的挂了关系栏(不是「判据在那儿」而已);
 *   2. 关系词**只在** `lib/relations.ts` 出现一次(别处自己写一遍 = 两个事实来源);
 *   3. 地址参数**真的有人读** —— `?blocker=` / `?project=` 曾经是**指向空气的地址**:
 *      参数写进地址,但没有任何页面读它 ⇒ 点得动、跳得过去、落点没有那条东西;
 *   4. **深链接不许被自己抹掉** —— `#/works?work=w_1` 一打开就被清空,
 *      而症状是「页面就是没选中」,看着像用户自己点错了。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { shouldClearSelection } from "../../web/src/lib/route";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string =>
  readFileSync(join(here, "..", "..", rel), "utf8");

const works = read("web/src/routes/Works.tsx");
const members = read("web/src/routes/Members.tsx");
const projectDetail = read("web/src/routes/ProjectDetail.tsx");
const relations = read("web/src/lib/relations.ts");
const rail = read("web/src/components/relations/RelationsRail.tsx");
const deepLink = read("web/src/lib/deepLink.ts");
const app = read("web/src/App.tsx");

/** 去掉注释再找 —— 注释里写着反面教材会让 grep 命中假阳性。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("接线:三个页面都挂了关系栏", () => {
  it("工作项页 / 成员页 / 项目页都用了 <RelationsRail", () => {
    expect(works).toContain("<RelationsRail");
    expect(members).toContain("<RelationsRail");
    expect(projectDetail).toContain("<RelationsRail");
  });

  it("⚠️ 关系词只能在 lib/relations.ts 里写一次 —— 别处自己写一遍就是第二个事实来源", () => {
    // 「卡住它的阻塞」这一串是关系栏的**组名**,只允许出现在判据里。
    const inWorks = stripComments(works).includes("卡住它的阻塞");
    const inMembers = stripComments(members).includes("卡住它的阻塞");
    const inProject = stripComments(projectDetail).includes("卡住它的阻塞");
    expect([inWorks, inMembers, inProject].filter(Boolean)).toHaveLength(0);
    expect(relations).toContain("卡住它的阻塞");
  });

  it("⚠️ 关系栏不许自己决定事实 —— 判据只从 relationsOf 来", () => {
    // 排版那一半只 import `relationsOf`,不 import 任何判据表。
    expect(rail).toContain("relationsOf");
    expect(rail).not.toContain("ARTIFACT_REL_WORDS");
  });
});

describe("接线:地址参数真的有人读", () => {
  it("`?blocker=` 被项目页读 —— 曾经是**指向空气的地址**", () => {
    expect(projectDetail).toContain('paramOf(loc, "blocker")');
    // 而产出这个地址的地方必须带项目 id(阻塞只存在于某一个项目里)。
    expect(relations).toContain("blockerLocation(b.id, data.projectId)");
  });

  it("`?project=` 被**应用外壳**读 —— 深链接要能落到别的项目上", () => {
    // ⚠️ **判据没变、落点变了**（2026-10-26,Wave 2e）：改版前这一条判据落在
    // `routes/ProjectDetail.tsx`（那一页自己读 `?project=` 并切项目）。
    // 那个落点有一个**真 bug**：它每次渲染都看地址里的项目 ⇒ **用户从左栏切了项目**
    // （地址没变）⇒ 那个效果又把他拽回去 ⇒ 「切项目」这个动作被撤销，
    // 症状是「点左栏没反应」。
    // ⇒ 落点搬到 `lib/deepLink.ts`（**只有一处**），由 `App.tsx` 挂一次。
    expect(deepLink).toContain('paramOf(loc, "project")');
    expect(app).toContain("useProjectCoordinate()");
    // ⚠️ 而且**不许**再有第二个判据：页面自己切项目 = 两处判断互相撤销。
    expect(stripComments(projectDetail)).not.toContain("selectProject(wantedProject)");
  });

  it("⚠️ 产出 `?blocker=` 的地方必须带项目 id,否则那是一条半个地址", () => {
    // `blockerLocation(b.id)` 不带 project ⇒ 只能在「正好看着那个项目」时成立。
    expect(relations).not.toContain("blockerLocation(b.id)");
  });
});

describe("接线:深链接不许被自己抹掉", () => {
  it("判据:首帧不清(否则 `#/works?work=w_1` 一打开就没了)", () => {
    expect(shouldClearSelection({ mounted: false, projectId: "p_1" }, "p_1")).toBe(false);
    expect(shouldClearSelection({ mounted: false, projectId: null }, "p_1")).toBe(false);
  });

  it("判据:项目没变 ⇒ 不清;真换了 ⇒ 清", () => {
    expect(shouldClearSelection({ mounted: true, projectId: "p_1" }, "p_1")).toBe(false);
    expect(shouldClearSelection({ mounted: true, projectId: "p_1" }, "p_2")).toBe(true);
    expect(shouldClearSelection({ mounted: true, projectId: "p_1" }, null)).toBe(true);
  });

  it("页面用的是这一处判据(不是自己写一遍)", () => {
    expect(works).toContain("shouldClearSelection");
  });

  it("⚠️ 清参数的两行必须在判据之后(不是无条件执行)", () => {
    const body = stripComments(works);
    // ⚠️ **不写收尾的右括号** —— 2026-10-26(Wave 2e)给这个判据加了第三格
    // (地址里的项目坐标),写成 `shouldClearSelection(prev, scope)` 就会因为
    // 少一个逗号而找不到 ⇒ 判据自己被一次无关的签名变化弄红了。
    // 判据是「**守卫在清理之前**」,不是「第三个参数长什么样」。
    const guardAt = body.indexOf("shouldClearSelection(prev, scope");
    const clearAt = body.indexOf("setPicked(undefined)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(guardAt);
  });
});

describe("接线:只有一个「当前项目」", () => {
  it("⚠️ 工作项页不再有页面私有的 scope —— 两个「当前项目」会让链接落在别的项目里", () => {
    const body = stripComments(works);
    expect(body).not.toMatch(/const \[scope, setScope\] = useState/);
    expect(body).toContain('const scope = useChatStore((s) => s.projectId)');
  });

  it("范围下拉切的是**全局**当前项目(与左栏同一个动作)", () => {
    expect(stripComments(works)).toContain("selectProject(next)");
  });
});
