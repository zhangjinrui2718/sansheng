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
 * 3. **`apply()` 已于批次 7-O 落地,但形态就是当初写下的那一句。** 7-G 说
 *    「让 UI 改 harness」等于开一个写权限的攻击面,且会与「绝不覆盖用户手笔」的
 *    三分支语义正面冲突(写入 = 用户手笔,而三分支恰恰靠「内容是否命中出厂串」
 *    判断用户有没有编辑过)。7-O 兑现的前置条件是**「在生效」已经变成可验证的
 *    断言**:每条 entry 都带 enforced / basis / apply,orphan 与 empty 分开报,
 *    blockedByCeiling 画在脸上 —— 也就是说,现在能诚实地回答「改完什么时候生效、
 *    这条现在生效吗」,才有资格开写。
 *
 *    落地形态照旧是那三个字:**独立的** `applyFacet()`(不是给 describe 顺带加
 *    setter)+ **备份**(写前覆盖到 harness/backups/)+ **显式确认**(reset 与
 *    写入是两条独立动作,UI 上是两个按钮)。冲突本身是这样解的:写入的内容就是
 *    「用户手笔」,state 如实变 user_edited(ensureHarness 永不覆盖它);
 *    「想回到出厂」不需要另一套语义,恢复出厂写回的就是出厂字节串,
 *    state 随之变回 default / factory —— 与读路径的判定同源,不需要第二套真相。
 *
 *    写面的实现全部在 ./apply.ts(备份 / 原子写 / id 白名单 / fail-closed 校验),
 *    本文件只做分发:面没实现 apply → 如实回 not_implemented,不给假实现。
 */
import { log } from "../../shared/log.js";
import type {
  HarnessApplyInput,
  HarnessApplyResult,
  HarnessDetailResult,
  HarnessEntry,
  HarnessEntryDetail,
  HarnessFacetId,
} from "./facetTypes.js";

export type {
  HarnessEntry,
  HarnessEntryDetail,
  HarnessApplyInput,
  HarnessApplyResult,
  HarnessDetailResult,
};

/** 五个受管面。**闭合 union** 定义在 facetTypes.ts(写面类型要与它同处一文件),
 * 这里转出去,调用方仍从 facet.js 拿。 */
export type { HarnessFacetId } from "./facetTypes.js";

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
  /**
   * 批次 7-O:写面。**刻意是可选的** —— 7-E 的教训是「给没有执行点的角色写一份
   * 非空名单 = 换个姿势继续撒谎」,同一个道理:没实现的写面不写一个假的空实现,
   * 而是让 applyFacet 如实回 not_implemented。当前只有 tools / prompts 两面有。
   *
   * 契约:不抛。成功返回 HarnessApplyOk(带写完后的 entry 快照),
   * 失败返回 HarnessApplyErr({ error, message })。
   */
  apply?(dataDir: string, input: HarnessApplyInput): HarnessApplyResult;
  /**
   * 批次 7-O:单条目完整内容(编辑器初值)。可选:skills / rag 还没有可编辑内容,
   * 就没有这一项,describeFacetEntry 会回 unknown_entry 而不是给一份空壳。
   * 返回 null = 面里有这个 id,但本面不提供详情(而不是 404 —— id 是真的)。
   */
  detail?(dataDir: string, id: string): HarnessEntryDetail | null;
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

/**
 * 批次 7-O:单条目详情(编辑器初值)。与 applyFacet 同一套错误语义:
 * 面不存在 → unknown_facet;面里没这个 id(或该面不提供详情)→ unknown_entry。
 *
 * entry 复用 describe() 的结果 —— **详情与总表不可能对不上**,因为它们
 * 是同一次读盘算出来的。UI 打开编辑器时不必担心「详情里的 state 和列表里不一样」。
 */
export function describeFacetEntry(
  id: HarnessFacetId,
  dataDir: string,
  entryId: string,
): HarnessDetailResult {
  const facet = FACET_INDEX.get(id);
  if (!facet) {
    return { ok: false, error: "unknown_facet", message: `未知的受管面「${id}」` };
  }
  if (!facet.detail) {
    return {
      ok: false,
      error: "unknown_entry",
      message: `「${facet.title}」面不提供条目详情${facet.notImplementedNote ? `(${facet.notImplementedNote})` : ""}`,
    };
  }
  let detail: HarnessEntryDetail | null;
  try {
    detail = facet.detail(dataDir, entryId);
  } catch (err) {
    log.error(`harness: ${id}/${entryId} 详情读取抛异常:`, err);
    return { ok: false, error: "unknown_entry", message: `读取 ${entryId} 详情失败` };
  }
  if (!detail) {
    return { ok: false, error: "unknown_entry", message: `「${facet.title}」面里没有条目「${entryId}」` };
  }
  return { ok: true, facet: id, id: entryId, detail };
}

/**
 * 批次 7-O:写面唯一入口。**不抛** —— HTTP 层要把错误码翻译成 4xx/5xx,
 * 一个抛到 handler 外面就变成 500 + 失去语义。
 *
 * 三种失败,三种错误码,各有各的理由,绝不含糊:
 *   - `unknown_facet`  面 id 不在注册表(404)
 *   - `not_implemented` 面在,但没有实现 apply —— 当前是 skills / rag(409)
 *   - 别的由各面自己的 apply 决定(unknown_entry 404 / invalid_payload 400 /
 *     io_error 500)
 *
 * 「面崩了」也不该让整个管理面 500:各面 apply 的契约是不抛,但真抛了
 * (实现方 bug)→ 兜成 io_error 并记日志,语义仍然是「没写成」。
 */
export function applyFacet(
  id: HarnessFacetId,
  dataDir: string,
  input: HarnessApplyInput,
): HarnessApplyResult {
  const facet = FACET_INDEX.get(id);
  if (!facet) {
    return { ok: false, error: "unknown_facet", message: `未知的受管面「${id}」` };
  }
  if (!facet.apply) {
    return {
      ok: false,
      error: "not_implemented",
      message: `「${facet.title}」面没有写接口${facet.notImplementedNote ? `(${facet.notImplementedNote})` : ""}`,
    };
  }
  try {
    return facet.apply(dataDir, input);
  } catch (err) {
    log.error(`harness: ${id} 面 apply 抛异常(实现方 bug,未改动任何文件):`, err);
    return {
      ok: false,
      error: "io_error",
      message: `${facet.title} 面写入失败:${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
