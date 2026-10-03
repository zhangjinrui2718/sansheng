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
import type {
  HarnessApplyInput,
  HarnessApplyResult,
  HarnessEntry,
  HarnessEntryDetail,
} from "../facetTypes.js";
import { applyPromptUnit, isPromptUnitId } from "../apply.js";
import {
  BUILTIN_PROMPTS,
  describePrompts,
  ensureHarness,
  getPromptUnit,
  loadHarness,
} from "../loader.js";

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
  /**
   * 批次 7-O:编辑器初值。content 取**当前落盘内容**(缺文件 = 空串,与
   * loadHarness 同一读法);factory 取当前出厂默认全文,UI 才有得做「对比出厂」。
   * 两者都只在这一条详情里返回,GET /api/harness 总表不带。
   */
  detail(dataDir, id): HarnessEntryDetail | null {
    if (!isPromptUnitId(id)) return null;
    const unit = getPromptUnit(id);
    const info = describePrompts(dataDir).find((p) => p.role === id);
    if (!info) return null;
    const content = loadHarness(dataDir).systemPrompts[id] ?? "";
    return {
      entry: promptsFacet.describe(dataDir).find((e) => e.id === id) ?? {
        id,
        enforced: info.enforced,
        basis: info.enforced ? info.consumer : (info.orphanReason ?? "无消费方"),
        chars: content.length,
        lines: content ? content.split("\n").length : 0,
        source: "factory",
        warnings: [],
      },
      payload: {
        content,
        factory: BUILTIN_PROMPTS[id],
        state: info.state,
        owner: info.owner,
        apply: info.apply,
        sensitivity: info.sensitivity,
        consumer: info.consumer,
        enforced: info.enforced,
        ...(info.orphanReason !== undefined ? { orphanReason: info.orphanReason } : {}),
      },
    };
  },
  /**
   * 批次 7-O:写面。逻辑全在 ../apply.ts(备份 / 原子写 / id 白名单 / 上限),
   * 本方法只做三件翻译:调它、把「写完后的内容」喂进 describe 拿真实快照、
   * 把「生效时机」从提示词注册表搬过来(那句话是系统事实,不许在 UI 里另编)。
   *
   * **orphan 单元照样能写**(它是一份合法的用户手笔),但写完的 entry 仍带
   * 「零消费方」告警 —— 写面不制造「以为生效了」的错觉,那由 describe 负责。
   */
  apply(dataDir, input: HarnessApplyInput): HarnessApplyResult {
    const payload = isRecord(input.payload) ? input.payload : {};
    const raw = applyPromptUnit(
      dataDir,
      input.id,
      payload["content"],
      input.reset === true,
    );
    if (!raw.ok) return raw;
    // raw.ok 已经证明 id 过了白名单;这里的收窄只是为了让 TS 认出 `PromptUnitId`
    const unit = isPromptUnitId(input.id) ? input.id : null;
    const entry = unit ? promptsFacet.describe(dataDir).find((e) => e.id === unit) : undefined;
    if (!unit || !entry) {
      return {
        ok: false,
        error: "io_error",
        message: `写入成功但拿不到 ${input.id} 的写后快照 —— 注册表与磁盘不一致`,
      };
    }
    return {
      ok: true,
      facet: "prompts",
      id: unit,
      changed: raw.changed,
      backupPath: raw.backupPath,
      filePath: raw.filePath,
      apply: getPromptUnit(unit).apply,
      warnings: raw.warnings,
      entry,
    };
  },
};

/** module-level type guard:body 是不是 JSON 对象。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
