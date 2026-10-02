/**
 * Sansheng Harness · prompts facet
 *
 * 把 `loader.ts` 的提示词面包装成受管面。**不含任何降级逻辑** —— loader 已经
 * 决定了「文件缺失/为空 → 空串 → 消费方回退到 `BUILTIN_PROMPTS[id]`」,
 * 本文件只负责把 `describePrompts` 的结果翻译成 `HarnessEntry`。
 *
 * 批次 7-G 相比 7-E 的一处**行为变更**:多了一个 `orphan` 状态。
 * critic / memory / reflection 三份文件此前被报成 `default`(看起来像生效中的
 * 配置),实际上零消费方。现在它们被如实标成 orphan 并附上原因。
 */
import type { HarnessFacet } from "../facet.js";
import type { HarnessEntry } from "../facetTypes.js";
import { describePrompts, ensureHarness } from "../loader.js";

export const promptsFacet: HarnessFacet = {
  id: "prompts",
  title: "提示词",
  implemented: true,
  ensure(dataDir) {
    // ensureHarness 同时补齐 prompt 与 tools;这里不重复调用,避免两处都能改盘
    ensureHarness(dataDir);
  },
  describe(dataDir): HarnessEntry[] {
    return describePrompts(dataDir).map((p) => ({
      id: p.role,
      enforced: p.enforced,
      basis: p.enforced ? p.consumer : (p.orphanReason ?? "无消费方(未标注原因 —— 这是注册表的 bug)"),
      chars: p.chars,
      lines: p.lines,
      source: p.state === "user_edited" ? "user" : "factory",
      warnings: p.state === "orphan" ? [`零消费方:${p.orphanReason ?? "未标注"}`] : [],
      detail: {
        owner: p.owner,
        state: p.state,
        apply: p.apply,
        sensitivity: p.sensitivity,
        ...(p.orphanReason !== undefined ? { orphanReason: p.orphanReason } : {}),
      },
    }));
  },
};
