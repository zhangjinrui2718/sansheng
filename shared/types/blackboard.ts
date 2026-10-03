/**
 * Sansheng · 共享类型:Blackboard + BlackboardArtifact v3
 *
 * M3+ 引入(2026-09-29 锁定):
 *   - BlackboardArtifact 作为 first-class 类型(10 kinds · 6 status)
 *   - 双 scope(global + conversation)区分共享 vs 会话局部
 *   - D8 execution tracking 字段(executors / dependsOn / parentIntent)
 *   - D13 structured metadata(callbackReason / category / riskLevel / filesToChange)
 *
 * 与 v4 Blackboard 的兼容性:legacy `Blackboard` 接口在 `shared/types/agents.ts`
 * 保留(M3b tests 仍引用);本文件新增的 `BlackboardShape` 是**结构子集**,只在
 * artifact CRUD 层使用 — 不替换 legacy interface。
 */

// ───────────────────────────── Scope ─────────────────────────────

export type BlackboardScope = "global" | "conversation";

// ───────────────────────────── Artifact kind ─────────────────────────────

export type ArtifactKind =
  | "decision" // resolved decision
  | "hypothesis" // open hypothesis (executor raised; needs resolution)
  | "harness_proposal" // D13: proposal to upgrade harness → Harness Manager
  | "implementation_preview" // D15: Harness Manager preview (v0 不写文件)
  | "intent" // triggers Planner
  | "todo" // DAG step within intent
  | "note" // free-form knowledge; **协议专用**(executor 失败说明 / planner 失败 note)
  /**
   * 批次 7-J:沉淀专用 kind。
   *
   * **为什么要有它**:`hypothesis` / `intent` / `decision` 此前被**两套互不相容的
   * 语义**同时占用 ——
   *   协议侧(executor):带 callbackReason + 父 todo 转 waiting_for_decision +
   *                    发 executor_callback,是**有流程会处理的升级信号**;
   *   沉淀侧(sedimentation):从对话里提炼的推测,status=open、**永远没人处理**。
   * 两者在 UI 上是同一种卡片(都叫「假设」),语义却完全相反 —— 用户完全无法分辨
   * 「这个会有人来问我」和「这个躺在这没人管」。
   *
   * 所以把记忆分类法与工作流分类法**拆开**:
   *   工作流 kind(intent / todo / hypothesis / decision / evidence …)→ 协议专用
   *   记忆 kind(insight)→ 沉淀专用,认知状态(目标/决定/推测/事实)搬进
   *                      metadata.sedimentForm,闭合联合只 +1 而不是 +4。
   */
  | "insight"
  | "evidence" // observation from Executor
  | "critique" // Critic's review of evidence batch
  | "reflection"; // Reflection session's summary

export const ARTIFACT_KINDS: ReadonlyArray<ArtifactKind> = [
  "decision",
  "hypothesis",
  "harness_proposal",
  "implementation_preview",
  "intent",
  "todo",
  "note",
  "insight",
  "evidence",
  "critique",
  "reflection",
];

/**
 * 批次 7-J:沉淀认知状态。沉淀的 D7 提示词原本让模型在 intent/decision/hypothesis/
 * note 四者里选 —— 那是一套**记忆分类法**(这条认知是什么性质),和工作流 kind
 * 混在一起才造成了串味。拆开后:kind 恒为 `insight`,性质由本字段承载。
 *
 * `goal` / `decision` / `hypothesis` / `fact` 四值与 D7 的四形态一一对应
 * (intent→goal 是因为 intent 在工作流里已另有含义「触发 Planner」)。
 */
export type SedimentForm = "goal" | "decision" | "hypothesis" | "fact";
export const SEDIMENT_FORMS: ReadonlyArray<SedimentForm> = ["goal", "decision", "hypothesis", "fact"];

export function isSedimentForm(value: unknown): value is SedimentForm {
  return typeof value === "string" && (SEDIMENT_FORMS as ReadonlyArray<string>).includes(value);
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as ReadonlyArray<string>).includes(value);
}

// ───────────────────────────── Artifact status ─────────────────────────────

export type ArtifactStatus =
  | "open"
  | "in_progress"
  | "waiting_for_decision" // D9/D13: Executor paused on callback
  | "resolved"
  | "superseded"
  | "failed";

export const ARTIFACT_STATUSES: ReadonlyArray<ArtifactStatus> = [
  "open",
  "in_progress",
  "waiting_for_decision",
  "resolved",
  "superseded",
  "failed",
];

export function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return typeof value === "string" && (ARTIFACT_STATUSES as ReadonlyArray<string>).includes(value);
}

// ───────────────────────────── Author ─────────────────────────────

export type ArtifactAuthor =
  | "user"
  | "communicator"
  | "planner"
  | "executor"
  | "critic"
  | "memory"
  | "reflection"
  | "harness_manager";

export const ARTIFACT_AUTHORS: ReadonlyArray<ArtifactAuthor> = [
  "user",
  "communicator",
  "planner",
  "executor",
  "critic",
  "memory",
  "reflection",
  "harness_manager",
];

export function isArtifactAuthor(value: unknown): value is ArtifactAuthor {
  return typeof value === "string" && (ARTIFACT_AUTHORS as ReadonlyArray<string>).includes(value);
}

// ───────────────────────────── D9/D13 metadata sub-types ─────────────────────────────

export type CallbackReason = "judgment" | "harness_proposal";
export const CALLBACK_REASONS: ReadonlyArray<CallbackReason> = ["judgment", "harness_proposal"];

export type HarnessCategory = "tool" | "cli" | "prompt" | "policy" | "red_line" | "budget";
export const HARNESS_CATEGORIES: ReadonlyArray<HarnessCategory> = [
  "tool",
  "cli",
  "prompt",
  "policy",
  "red_line",
  "budget",
];

export type RiskLevel = "low" | "medium" | "high";
export const RISK_LEVELS: ReadonlyArray<RiskLevel> = ["low", "medium", "high"];

export type FileChangeType = "create" | "modify" | "delete";
export const FILE_CHANGE_TYPES: ReadonlyArray<FileChangeType> = ["create", "modify", "delete"];

export interface FileChange {
  path: string;
  changeType: FileChangeType;
  diffPreview?: string;
}

export interface BlackboardArtifactMetadata {
  /** 仅 hypothesis artifact 用:Executor 阻塞原因。 */
  callbackReason?: CallbackReason;
  /** 仅 harness_proposal / implementation_preview 用。 */
  category?: HarnessCategory;
  /** 仅 harness_proposal 用。 */
  riskLevel?: RiskLevel;
  estimatedEffort?: string;
  evidenceCount?: number;
  relatedArtifacts?: string[];
  filesToChange?: FileChange[];
  /** 允许额外 metadata 字段(向后兼容)。 */
  [k: string]: unknown;
}

// ───────────────────────────── BlackboardArtifact (v3) ─────────────────────────────

export interface BlackboardArtifact {
  id: string;
  scope: BlackboardScope;
  /** 仅 scope='conversation' 时必填;scope='global' 时省略或等于 '__global__'。 */
  conversationId?: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  refs?: string[];
  author: ArtifactAuthor;
  status: ArtifactStatus;

  // D8: execution tracking
  executors?: string[];
  dependsOn?: string[];
  parentIntent?: string;

  // D13: structured metadata
  metadata?: BlackboardArtifactMetadata;

  createdAt: number;
  updatedAt: number;
}

// ───────────────────────────── BlackboardShape (artifact-aware subset) ─────────────────────────────

/**
 * Blackboard v3 artifact-aware shape(向后兼容 — artifacts 数组可空)。
 * 与 legacy `Blackboard`(M3b, shared/types/agents.ts)并存:
 *   - legacy `Blackboard`:goal/plan/todos/evidence/critique + decisions/producedArtifacts
 *   - v3 `BlackboardShape`:artifacts[] + artifactIndex(可与 legacy 字段共存)
 *
 * B1 storage 使用 v3 字段;legacy `Blackboard` 仍然写入同表 `blackboards`
 * (additive — 新加 `artifacts_json` 列,默认 '[]')。
 */
export interface BlackboardShape {
  conversationId: string;
  artifacts?: BlackboardArtifact[];
  artifactIndex?: Record<string, number>;
  /** Legacy field — 老 Blackboard 也用 conversationId。 */
  scope?: BlackboardScope;
}