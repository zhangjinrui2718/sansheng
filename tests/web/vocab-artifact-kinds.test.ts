/**
 * C2 · 前端工件词表是**活的**(设计 1 §2.11.5 的同步面之一)
 *
 * `web/src/lib/vocab.ts` 的 `ARTIFACT_KIND_LABEL` / `ARTIFACT_KIND_TONE` 是
 * `Record<ArtifactKind, …>` —— 漏一个 key 时 `tsconfig.web.json` 会红,这是
 * 加 kind 时**唯一一处编译器替我们守着的**面(设计 1 §2.11.5 末)。
 *
 * 但类型守卫只保证「key 集合 ⊇ 联合」这半个方向,而且它守的是
 * `shared/types/platform.ts` 的联合,**不是** `identity/role.ts` 的
 * `ARTIFACT_KINDS` —— 两个闭集今天逐字相同,却没有任何东西钉住这件事。
 * 这个文件就是那颗钉子:三方(契约联合 / 代码闭集 / 前端词表)在**运行期**
 * 逐个对齐,和 `tests/platform/design-conformance.test.ts` 的代码↔文档 diff 配对。
 *
 * 为什么可以放 tests/web:vocab.ts 的 import 全是 `import type`(编译后不剩
 * 任何运行时依赖),`@` 别名在 vitest.config.ts 里已配好,node 环境足够。
 * 不需要 jsdom —— 这里测的是词表,不是 DOM。
 */
import { describe, expect, it } from "vitest";
import type { ArtifactKind } from "@shared/types/platform";
import { ARTIFACT_KINDS } from "../../src/platform/identity/role.js";
import { ARTIFACT_KIND_LABEL, ARTIFACT_KIND_TONE } from "@/lib/vocab";

/** 编译期钉子:代码侧闭集的每个取值都必须是契约联合的成员。 */
const _contractCheck: readonly ArtifactKind[] = ARTIFACT_KINDS;
void _contractCheck;

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("C2 · 前端词表 ↔ 代码侧 ARTIFACT_KINDS", () => {
  it("标签表覆盖全部 kind,且不多不少", () => {
    expect(sorted(Object.keys(ARTIFACT_KIND_LABEL))).toEqual(sorted(ARTIFACT_KINDS));
  });

  it("色表覆盖全部 kind,且不多不少", () => {
    expect(sorted(Object.keys(ARTIFACT_KIND_TONE))).toEqual(sorted(ARTIFACT_KINDS));
  });

  it("deliverable 有中文读法(不是英文原文透出)", () => {
    // `artifactKindLabel` 的兜底是原样透出 —— 词表漏了谁,页面上就出现英文
    expect(ARTIFACT_KIND_LABEL.deliverable).toBe("交付物");
  });

  it("闭集是 11 个取值(016 的 schema CHECK 也是 11 个)", () => {
    expect(ARTIFACT_KINDS.length).toBe(11);
    expect(new Set(ARTIFACT_KINDS).size, "闭集里有重复取值").toBe(11);
  });
});
