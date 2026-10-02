/**
 * Sansheng Harness · 管理面抽象(facet)
 *
 * ── 这是「为 skills / rag 预留可扩展性」的落点 ──────────────────────────
 * 7-G 之前 harness 的每个面各写各的:tools 走 `tools.ts` + `GET /api/harness`
 * 的 `toolSets` 字段,prompts 走 `loader.ts` + `prompts` 字段,skills 和 rag
 * 什么都没有。加一个新面意味着:改 loader、改 http、改 Harness 页三处,
 * 而且每处的形状都得手写一遍 —— 这是「五项管理」迟迟落不了地的结构原因。
 *
 * `HarnessFacet` 把这件事收敛成**一个接口 + 一行注册**:
 *   1. 实现 `{ id, title, implemented, ensure(dataDir), describe(dataDir) }`
 *   2. 在 `FACETS` 数组里加一行
 * 之后 manager、API、UI、diagnose 全部自动认识这个面 —— **不改它们**。
 *
 * ── 三个刻意的设计选择 ──────────────────────────────────────────────
 *
 * 1. **`implemented: false` 是一等状态。** skills / rag 现在还没做,但它们必须
 *    **出现在管理面里并明说「未实现」**,而不是不存在。理由与 7-E/7-G 一路
 *    坚持的同款:管理面里「有这一行但写着未实现」和「这一行根本没有」,
 *    对用户的意义天差地别 —— 前者告诉你系统缺什么,后者让你以为没这回事。
 *    假实现的代价由 `describe()` 返回空条目承担(而不是编造示例数据)。
 *
 * 2. **`describe()` 只能读、只能失败成「退回出厂」。** 它是 API / UI /
 *    diagnose 的唯一数据源,三处共用。任何面在读盘出错时都必须退回内置默认
 *    并把原因写进 `entry.warnings` —— 与 tools 的 fail-closed、prompts 的
 *    「空 → 内置常量」是同一个原则的两种形态(权限面收紧,内容面回退)。
 *
 * 3. **`apply()` 不在 v1。** 「让 UI 改 harness」等于开一个写权限的攻击面,
 *    且会与「绝不覆盖用户手笔」的三分支语义正面冲突(写入 = 用户手笔,而
 *    三分支恰恰靠「内容是否命中出厂串」判断用户有没有编辑过)。**先把只读
 *    面做对、把「在生效」变成可验证的断言,再谈写。** 真要写,应该是独立的
 *    `applyFacet()` + 备份 + 显式确认,不是给 describe 顺带加个 setter。
 */
import type { HarnessEntry } from "./facetTypes.js";

export type { HarnessEntry };

/** 五个受管面。**闭合 union** —— 加面要显式扩这里,不能靠字符串糊过去。 */
export type HarnessFacetId = "tools" | "prompts" | "skills" | "rag";

export interface HarnessFacet {
  id: HarnessFacetId;
  title: string;
  /** 该面是否已实现。false 时 UI 显式标「未实现」,不假装有内容 */
  implemented: boolean;
  /** implemented=false 时必填 —— 缺什么、什么时候做 */
  notImplementedNote?: string;
  /** 补齐出厂文件。幂等,**永不覆盖用户手笔**(与 ensureHarness 同款三分支) */
  ensure(dataDir: string): void;
  /** 只读全量条目。读盘出错必须退回内置默认 + warnings,不得抛 */
  describe(dataDir: string): HarnessEntry[];
}

import { toolsFacet } from "./facets/tools.js";
import { promptsFacet } from "./facets/prompts.js";
import { skillsFacet } from "./facets/skills.js";
import { ragFacet } from "./facets/rag.js";

/**
 * 面注册表。**加一个新面 = 写一个模块 + 在这里加一行。**
 * 顺序即 UI 展示顺序。
 */
const FACETS: readonly HarnessFacet[] = [toolsFacet, promptsFacet, skillsFacet, ragFacet];

const FACET_INDEX: ReadonlyMap<HarnessFacetId, HarnessFacet> = new Map(
  FACETS.map((f) => [f.id, f]),
);

export function harnessFacets(): readonly HarnessFacet[] {
  return FACETS;
}

export function getFacet(id: HarnessFacetId): HarnessFacet {
  const f = FACET_INDEX.get(id);
  if (!f) throw new Error(`unknown harness facet: ${id}`);
  return f;
}

/** 一个面的完整快照(UI / API / diagnose 共用同一形状)。 */
export interface HarnessFacetSnapshot {
  id: HarnessFacetId;
  title: string;
  implemented: boolean;
  notImplementedNote?: string;
  entries: HarnessEntry[];
}

/**
 * 全量快照。**单个面出错不影响其余面** —— 与 `loadHarness` 里
 * 「一个 prompt 文件读失败只丢那一个 prompt」同款容错。
 * 面本身崩了(不该发生,describe 契约要求不抛)→ 该面 entries 为空 +
 * 一条 synthetic warning,而不是让整个管理面 500。
 */
export function describeHarness(dataDir: string): HarnessFacetSnapshot[] {
  return FACETS.map((facet) => {
    try {
      return {
        id: facet.id,
        title: facet.title,
        implemented: facet.implemented,
        ...(facet.notImplementedNote !== undefined
          ? { notImplementedNote: facet.notImplementedNote }
          : {}),
        entries: facet.describe(dataDir),
      };
    } catch (err) {
      return {
        id: facet.id,
        title: facet.title,
        implemented: facet.implemented,
        entries: [
          {
            id: "__facet_error__",
            enforced: false,
            basis: "describe() 抛异常 —— 这是 facet 实现方的 bug,不是数据问题",
            chars: 0,
            lines: 0,
            source: "factory",
            warnings: [`读取 ${facet.id} 面失败:${err instanceof Error ? err.message : String(err)}`],
          },
        ],
      };
    }
  });
}

/** 幂等补齐全部面的出厂文件。server boot 调一次。 */
export function ensureHarnessFacets(dataDir: string): void {
  for (const facet of FACETS) {
    try {
      facet.ensure(dataDir);
    } catch {
      // 与 ensureHarness 同款:补齐失败不崩 server,且不覆盖用户已有文件
    }
  }
}
