/**
 * 「实体脊」的接线判据 —— **同一组事实不许有两处来源**
 *
 * ── 这份测试守的是什么 ────────────────────────────────────────────
 *
 * 实体条(`lib/entityMeta.ts` + `components/ui/MetadataStrip.tsx`)把
 * 「一个工件是什么」收成**一份**判据。收进来之后,真正的风险是**腐坏**:
 * 过一阵子有人在某个页面上又手写了一遍「作者 / 状态」,或者某处自己造了一
 * 串 `MetaItem` —— 那时同一个工件又开始有两种说法,而**界面上看不出差别**。
 *
 * 所以这里钉的是**接线**而不是渲染:
 *
 *   ① **身份字段只在一处被格式化** —— `authorName ||` / `assigneeName ||` /
 *      `raisedByName` 这三个「带兜底的写法」只允许出现在 `lib/entityMeta.ts`;
 *   ② **每个页面都走这条带子** —— 三个出现实体卡片的页面都用了
 *      `<MetadataStrip`;
 *   ③ **没有页面自己造事实** —— 每一处 `<MetadataStrip items={…}` 的内容
 *      都必须来自 `entityMeta` 的某个构造器(不许手写 `items={[{label:…}]}`)。
 *
 * ⚠️ ① 之所以挑「带兜底的写法」而不是字段名本身:字段名在**原始字段**区块
 * (`契约 ArtifactView.authorName`)与 SVG 的 `title=` 提示里**本来就该出现**
 * —— 那两处是「原始坐标」,不是「身份的说法」。禁掉它们会逼着人把原始字段藏起来,
 * 那比重复更糟。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = (rel: string): string =>
  readFileSync(resolve(__dirname, "../../web/src", rel), "utf8");

/** 出现实体卡片的三处(工件 / 工作项 / 阻塞的读面)。 */
const PAGES = ["routes/Works.tsx", "routes/ProjectDetail.tsx", "routes/Members.tsx"] as const;

describe("实体脊:身份字段只在一处被格式化", () => {
  it("authorName || / assigneeName || / raisedByName 只出现在 lib/entityMeta.ts", () => {
    for (const rel of PAGES) {
      const src = source(rel);
      expect(src, `${rel} 里不该自己兜底 authorName`).not.toContain("authorName ||");
      expect(src, `${rel} 里不该自己兜底 assigneeName`).not.toContain("assigneeName ||");
      expect(src, `${rel} 里不该自己渲染 raisedByName`).not.toContain("raisedByName");
    }
    const meta = source("lib/entityMeta.ts");
    expect(meta).toContain("authorName ||");
    expect(meta).toContain("assigneeName ||");
    expect(meta).toContain("raisedByName");
  });
});

describe("实体脊:每个页面都走这条带子", () => {
  it("三个页面都用了 <MetadataStrip", () => {
    for (const rel of PAGES) {
      expect(source(rel), `${rel} 没用 MetadataStrip`).toContain("<MetadataStrip");
    }
  });
});

describe("实体脊:没有页面自己造事实", () => {
  it("每一处 <MetadataStrip items={…} 的内容都来自 entityMeta 的构造器", () => {
    for (const rel of PAGES) {
      const src = source(rel);
      const uses = src.match(/<MetadataStrip\s+items=\{([^}]*)\}/g) ?? [];
      expect(uses.length, `${rel} 一处 MetadataStrip 都没有 —— 接线断了?`).toBeGreaterThan(0);
      for (const u of uses) {
        // 允许的形状:`items={artifactMeta(...)}` / `items={workMeta(...)}` / `items={blockerMeta(...)}`
        expect(
          u,
          `${rel} 里的 ${u} 不是从 entityMeta 来的 —— 页面不许自己造事实`,
        ).toMatch(/items=\{(artifactMeta|workMeta|blockerMeta)\(/);
      }
    }
  });

  it("⚠️ 手写一份 items 就会在这里变红(变异自检:把构造器换成字面量)", () => {
    const src = source("routes/Works.tsx");
    const handMade = `<MetadataStrip items={[{ label: "作者", value: "x" }]} />`;
    expect(handMade).not.toMatch(/items=\{(artifactMeta|workMeta|blockerMeta)\(/);
    // 反向:真的从构造器来,就必须匹配
    expect(`<MetadataStrip items={artifactMeta(a)} />`).toMatch(
      /items=\{(artifactMeta|workMeta|blockerMeta)\(/,
    );
    // 而源码里的每一处都必须匹配(这是上面那条的真实落点)
    for (const rel of PAGES) {
      const s = source(rel);
      for (const u of s.match(/<MetadataStrip\s+items=\{[^}]*\}/g) ?? []) {
        expect(u).toMatch(/items=\{(artifactMeta|workMeta|blockerMeta)\(/);
      }
    }
  });
});

describe("实体脊:邻居的地址只有一处生成", () => {
  it("memberLocation / workLocation / artifactLocation 只在 entityMeta.ts 里被定义", () => {
    const meta = source("lib/entityMeta.ts");
    expect(meta).toContain("export const memberLocation");
    expect(meta).toContain("export const workLocation");
    expect(meta).toContain("export const artifactLocation");
    // 页面**不许**手拼地址(拼错与拼对在屏幕上长得一样)
    for (const rel of PAGES) {
      const src = source(rel);
      expect(src, `${rel} 里不该手拼成员地址`).not.toContain('"#/members?member=');
      expect(src, `${rel} 里不该手拼工作项地址`).not.toContain('"#/works?work=');
    }
  });
});
