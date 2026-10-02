/**
 * Sansheng Harness · tools facet
 *
 * 把已有的 `tools.ts`(7-E 集合层 + 7-F 桥接层)包装成受管面。**本文件不含
 * 任何授权逻辑** —— 它只负责把 `loadToolSets` 的结果翻译成 `HarnessEntry`。
 * 授权裁决仍然全部在 `tools.ts`(ceiling + fail-closed 解析器),一行没动。
 */
import type { HarnessFacet } from "../facet.js";
import type { HarnessEntry } from "../facetTypes.js";
import { TOOL_ROLES, ensureToolSets, loadToolSets } from "../tools.js";

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
        },
      };
    });
  },
};
