/**
 * Sansheng Harness · tools facet
 *
 * 把已有的 `tools.ts`(7-E 集合层 + 7-F 桥接层)包装成受管面。**本文件不含
 * 任何授权逻辑** —— 它只负责把 `loadToolSets` 的结果翻译成 `HarnessEntry`。
 * 授权裁决仍然全部在 `tools.ts`(ceiling + fail-closed 解析器),一行没动。
 */
import type { HarnessFacet } from "../facet.js";
import type {
  HarnessApplyInput,
  HarnessApplyResult,
  HarnessEntry,
  HarnessEntryDetail,
} from "../facetTypes.js";
import { applyToolSet, isToolRole } from "../apply.js";
import {
  TOOL_CATALOG,
  TOOL_ROLES,
  ensureToolSets,
  factoryToolSet,
  loadToolSets,
  roleToolCeiling,
  type ToolName,
} from "../tools.js";

/**
 * 批次 7-O:工具集合的「改动生效时机」。**只写一份**,describe 的 detail 与
 * detail() 的 payload 共用 —— 同一件事说两遍,迟早有一处忘了改。
 * 依据:orchestrator.ts:421(每次 plan 构造时 loadHarness().toolSets[role].allowed)
 * 与 agentKernel.ts:1071(每次 createPiSession 读 toolSets.communicator)。
 */
const TOOLS_APPLY_NOTE =
  "下一次该角色构造时读盘 —— planner/executor 每次 plan(orchestrator 构造),communicator 下次建 session(需 kernel.invalidate())。不用重启 server。";

export const toolsFacet: HarnessFacet = {
  id: "tools",
  title: "工具集合",
  implemented: true,
  ensure(dataDir) {
    ensureToolSets(dataDir);
  },
  describe(dataDir): HarnessEntry[] {
    const sets = loadToolSets(dataDir);
    return TOOL_ROLES.map((role) => {
      const s = sets[role];
      return {
        id: role,
        enforced: s.enforced,
        basis: s.enforceBasis,
        // 工具集合是 JSON 而非文本,不给 chars/lines —— 给了就是在编数字
        source: s.source,
        warnings: s.warnings,
        detail: {
          allow: s.allow,
          deny: s.deny,
          allowed: s.allowed,
          blockedByCeiling: s.blockedByCeiling,
          // 批次 7-O:集合文件改动后什么时候被重新读到 —— 取自真实消费点
          // (orchestrator.ts:421 每次 plan 构造 / agentKernel.ts:1071 每次建 session),
          // 不是 UI 上一句「保存即生效」的安慰话。
          apply: TOOLS_APPLY_NOTE,
          enforced: s.enforced,
        },
      };
    });
  },
  /**
   * 批次 7-O:勾选矩阵的初值。**ceiling 逐项标在每个工具上**(inCeiling),
   * 而不是只给一个总表 —— 用户在矩阵里点开一个勾不上的工具,必须当场知道
   * 「这个角色的架构上界里没有它」,否则这就是一个骗人的复选框。
   *
   * catalog 只带 **ceiling ∪ 当前 allow** 的并集:上界外的工具不给展示位,
   * 想看它们只能靠自己手改文件(那正好会落进 blockedByCeiling 被如实报出来)。
   */
  detail(dataDir, id): HarnessEntryDetail | null {
    if (!isToolRole(id)) return null;
    const set = loadToolSets(dataDir)[id];
    const ceiling = roleToolCeiling(id);
    const wanted = new Set<string>([...ceiling, ...set.allow, ...set.deny]);
    const names = (Object.keys(TOOL_CATALOG) as ToolName[]).filter((n) => wanted.has(n));
    return {
      entry: toolsFacet.describe(dataDir).find((e) => e.id === id) ?? {
        id,
        enforced: set.enforced,
        basis: set.enforceBasis,
        source: set.source,
        warnings: set.warnings,
      },
      payload: {
        allow: set.allow,
        deny: set.deny,
        allowed: set.allowed,
        blockedByCeiling: set.blockedByCeiling,
        factory: factoryToolSet(id),
        enforced: set.enforced,
        basis: set.enforceBasis,
        apply: TOOLS_APPLY_NOTE,
        ceiling,
        catalog: names.map((n) => ({
          name: n,
          ...TOOL_CATALOG[n],
          inCeiling: ceiling.includes(n),
          inAllow: set.allow.includes(n),
        })),
      },
    };
  },
  /**
   * 批次 7-O:写面。**授权裁决一行没动** —— 全部仍在 tools.ts(ceiling +
   * fail-closed 解析器);写面只负责把 allow/deny 落成规范字节,以及把
   * 「上界拒绝了什么」如实带回给 UI。
   *
   * enforceBasis 在写后仍然由 describe 现算,所以「改了但这个角色没有工具
   * 执行点」这件事在保存后第一眼就能看到,不需要用户去翻代码。
   */
  apply(dataDir, input: HarnessApplyInput): HarnessApplyResult {
    const raw = applyToolSet(dataDir, input.id, input.payload, input.reset === true);
    if (!raw.ok) return raw;
    const role = isToolRole(input.id) ? input.id : null;
    const entry = role ? toolsFacet.describe(dataDir).find((e) => e.id === role) : undefined;
    if (!role || !entry) {
      return {
        ok: false,
        error: "io_error",
        message: `写入成功但拿不到 ${input.id} 的写后快照 —— 注册表与磁盘不一致`,
      };
    }
    return {
      ok: true,
      facet: "tools",
      id: role,
      changed: raw.changed,
      backupPath: raw.backupPath,
      filePath: raw.filePath,
      apply: String((entry.detail as { apply: string }).apply),
      warnings: [...raw.warnings, ...entry.warnings],
      entry,
    };
  },
};
