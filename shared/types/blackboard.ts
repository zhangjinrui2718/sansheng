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
  | "note" // free-form knowledge (alignment memos, observer reports)
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
  "evidence",
  "critique",
  "reflection",
];

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