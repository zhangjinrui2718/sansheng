/**
 * Sansheng · 共享类型:Harness Manager v0 (M3+ B4)
 *
 * `shared/types/blackboard.ts` 已锁定(`harness_proposal` / `implementation_preview`
 * 是 10 种 ArtifactKind 之一,`riskLevel` / `category` 已在
 * `BlackboardArtifactMetadata` 中定义)。本文件**只新增** Harness Manager v0
 * 内部使用的辅助类型,**不修改** blackboard.ts / bus.ts:
 *
 *   - `ImplementationPreviewMode` — preview 描述的改动性质(create / modify / refactor)
 *   - `ImplementationPreviewPayload` — LLM 输出的结构化字段(写回 metadata)
 *   - `RawHarnessPreview` — LLM 原始 JSON 反序列化形态(parse 阶段用)
 *
 * 架构承诺(M3+ D15):v0 **不写文件**,只 emit `implementation_preview` artifact。
 * 真正的 apply 是 M6 后续 plan。
 */

import type { RiskLevel } from "./blackboard.js";

// ───────────────────────────── Mode ─────────────────────────────

/**
 * 预览描述的改动性质(语义清晰,比 `FileChangeType` 高一层)。
 *   - create   : 新增文件 / 模块
 *   - modify   : 改既有代码(局部)
 *   - refactor : 重构(不改外部行为)
 *
 * 注意:刻意不引入 "delete" — Harness Manager v0 不建议删文件,
 * 真正的删除由 M6+ apply 阶段 + 红线策略二次把关。
 */
export type ImplementationPreviewMode = "create" | "modify" | "refactor";
export const IMPLEMENTATION_PREVIEW_MODES: ReadonlyArray<ImplementationPreviewMode> = [
  "create",
  "modify",
  "refactor",
];

export function isImplementationPreviewMode(
  value: unknown,
): value is ImplementationPreviewMode {
  return (
    typeof value === "string" &&
    (IMPLEMENTATION_PREVIEW_MODES as ReadonlyArray<string>).includes(value)
  );
}

// ───────────────────────────── LLM 输出协议 ─────────────────────────────

/**
 * LLM (HarnessManager decideFn) 的结构化 JSON 输出契约。
 * `parseHarnessPreview()` 校验后转 `ImplementationPreviewPayload`。
 */
export interface RawHarnessPreview {
  /** Markdown 预览主体(代码块用 ```ts ``` 包裹,带 path header 注释)。 */
  previewMarkdown: string;
  /** 风险等级 — 由 LLM 根据改动范围 / 是否改红线 / 是否改共享模块自动评估。 */
  riskLevel: RiskLevel;
  /** 涉及的目标文件路径(相对 repo root)。 */
  targetFiles: string[];
  /** 估算改动行数(总增删 +)。 */
  estimatedLines: number;
  /** 改动性质。 */
  mode: ImplementationPreviewMode;
}

// ───────────────────────────── Metadata 写入形态 ─────────────────────────────

/**
 * 写进 `BlackboardArtifact.metadata` 的字段。
 * (其它字段如 `category` / `filesToChange` 由上游 `harness_proposal` 决定,
 * 这里只多写 preview-specific 的 4 个键。)
 */
export interface ImplementationPreviewPayload {
  /** 反向引用 — 这个 preview 对应哪条 proposal。 */
  proposalId: string;
  /** 同 RawHarnessPreview.riskLevel。 */
  riskLevel: RiskLevel;
  /** 同 RawHarnessPreview.targetFiles。 */
  targetFiles: string[];
  /** 同 RawHarnessPreview.estimatedLines。 */
  estimatedLines: number;
  /** 同 RawHarnessPreview.mode。 */
  mode: ImplementationPreviewMode;
}

// ───────────────────────────── parse helper ─────────────────────────────

export interface ParsedHarnessPreviewOk {
  ok: true;
  value: RawHarnessPreview;
}
export interface ParsedHarnessPreviewErr {
  ok: false;
  error: string;
  /** 原始字符串(若可定位)— 用于 fallback note artifact。 */
  raw?: string;
}
export type ParsedHarnessPreview =
  | ParsedHarnessPreviewOk
  | ParsedHarnessPreviewErr;

/**
 * 校验 LLM 输出。容错策略:
 *   - JSON.parse 失败 → 返回 ok:false
 *   - 字段缺失 / 类型错 → 返回 ok:false(尝试填默认值失败则 fail)
 *   - riskLevel 非法 → 降级为 "medium"
 *   - mode 非法 → 降级为 "modify"
 *   - targetFiles / estimatedLines 容错(空数组 / 0)
 *
 * 返回 ok:true 时 `value` 是经过清洗的 RawHarnessPreview。
 */
export function parseHarnessPreview(raw: string): ParsedHarnessPreview {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: "empty output", raw };
  }

  // 尝试抽 ```json ... ``` 代码块(LLM 偶尔把 JSON 包在 fenced block)
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1]!.trim() : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      error: `JSON parse failed: ${(err as Error).message}`,
      raw: trimmed.slice(0, 200),
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "output is not a JSON object", raw: trimmed.slice(0, 200) };
  }
  const obj = parsed as Record<string, unknown>;

  // previewMarkdown 必填
  const previewMarkdown =
    typeof obj.previewMarkdown === "string"
      ? obj.previewMarkdown.trim()
      : "";
  if (!previewMarkdown) {
    return { ok: false, error: "previewMarkdown missing or empty", raw: trimmed.slice(0, 200) };
  }

  // riskLevel 容错
  const riskRaw = obj.riskLevel;
  const riskLevel: RiskLevel =
    riskRaw === "low" || riskRaw === "medium" || riskRaw === "high"
      ? riskRaw
      : "medium";

  // mode 容错
  const modeRaw = obj.mode;
  const mode: ImplementationPreviewMode = isImplementationPreviewMode(modeRaw)
    ? modeRaw
    : "modify";

  // targetFiles
  let targetFiles: string[] = [];
  if (Array.isArray(obj.targetFiles)) {
    targetFiles = obj.targetFiles
      .filter((x): x is string => typeof x === "string" && x.length > 0)
      .map((x) => x.trim());
  }

  // estimatedLines
  let estimatedLines = 0;
  if (typeof obj.estimatedLines === "number" && Number.isFinite(obj.estimatedLines)) {
    estimatedLines = Math.max(0, Math.floor(obj.estimatedLines));
  }

  return {
    ok: true,
    value: { previewMarkdown, riskLevel, targetFiles, estimatedLines, mode },
  };
}
