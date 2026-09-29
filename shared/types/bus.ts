/**
 * Sansheng · Bus Events (M3+ Rebalance)
 *
 * BlackboardArtifact + 生命周期状态定义在 `./blackboard.ts`(B1)。
 * 本文件负责:
 *   - 5 个 BlackboardArtifact 生命周期 event payload
 *   - Communicator plan-producer 协议(JSON 输出 schema)
 *   - 验证辅助(IMPERATIVE_VERBS 等)
 */

// ── BlackboardArtifact / 子类型 re-export(避免重复定义,都从 blackboard.ts 取) ──
export type {
  BlackboardArtifact,
  BlackboardScope,
  BlackboardArtifactMetadata,
  BlackboardShape,
  ArtifactKind,
  ArtifactStatus,
  ArtifactAuthor,
  FileChange,
  FileChangeType,
  HarnessCategory,
  RiskLevel,
  CallbackReason,
} from "./blackboard.js";
export {
  ARTIFACT_KINDS,
  ARTIFACT_STATUSES,
  ARTIFACT_AUTHORS,
  CALLBACK_REASONS,
  HARNESS_CATEGORIES,
  RISK_LEVELS,
  FILE_CHANGE_TYPES,
  isArtifactKind,
  isArtifactStatus,
  isArtifactAuthor,
} from "./blackboard.js";

import type { ArtifactAuthor, ArtifactStatus } from "./blackboard.js";

/* ─────────────────────────────────────────────────────────────
 * Communicator 输出协议 (plan producer)
 * ───────────────────────────────────────────────────────────── */

/** Imperative verb 检测集合(用于 Intent 验证) */
export const IMPERATIVE_VERBS: ReadonlySet<string> = new Set([
  // 中文动作词
  "重构", "修复", "实现", "添加", "删除", "迁移", "部署", "写", "测试", "跑",
  "安装", "配置", "查", "分析", "总结", "创建", "更新", "拆分", "合并",
  "改", "改写", "补充", "移除", "切换", "启用", "禁用", "评估", "设计",
  // 英文动作词
  "fix", "refactor", "implement", "add", "remove", "delete", "deploy",
  "write", "test", "run", "install", "configure", "check", "analyze",
  "summarize", "create", "update", "split", "merge", "rewrite", "migrate",
  "switch", "enable", "disable", "evaluate", "design", "build", "ship",
]);

/** Communicator 单次响应 JSON schema */
export interface CommunicatorResponse {
  /** 对用户的直接回复文本(可省略 → 纯 producer 模式) */
  userReply?: string;
  /** 本次产出的 BlackboardArtifact 列表 */
  artifacts: Array<import("./blackboard.js").BlackboardArtifact>;
}

/** 已验证的 artifact */
export interface ValidatedArtifact {
  artifact: import("./blackboard.js").BlackboardArtifact;
  /** Intent 验证是否通过 */
  intentValid: boolean;
  /** 若 Intent 降级为 hypothesis,记录原因 */
  downgraded?: "imperative-missing";
}

/** 完整响应(已解析 + 已验证) */
export interface ParsedCommunicatorResponse {
  userReply?: string;
  artifacts: ValidatedArtifact[];
  /** JSON parse 失败 → 整个响应降级为单 note */
  parseError?: string;
}

/* ─────────────────────────────────────────────────────────────
 * Bus Events (5 个)
 * ───────────────────────────────────────────────────────────── */

/** Artifact 创建(新 BlackboardArtifact 落地) */
export interface ArtifactCreatedEvent {
  type: "artifact_created";
  artifact: import("./blackboard.js").BlackboardArtifact;
}

/** Artifact 状态变化 */
export interface ArtifactStatusChangedEvent {
  type: "artifact_status_changed";
  artifactId: string;
  oldStatus: ArtifactStatus;
  newStatus: ArtifactStatus;
  /** 触发状态变化的角色(可选) */
  actor?: ArtifactAuthor;
}

/** Executor 回调请求(judgment / harness_proposal) */
export interface ExecutorCallbackEvent {
  type: "executor_callback";
  executorSessionId: string;
  hypothesisId: string;
  reason: import("./blackboard.js").CallbackReason;
}

/** Executor resume 信号(Communicator 决策后) */
export interface ExecutorResumeEvent {
  type: "executor_resume";
  executorSessionId: string;
  decisionArtifactId: string;
}

/** Harness Proposal 创建(Harness Manager 预备) */
export interface HarnessProposalCreatedEvent {
  type: "harness_proposal_created";
  artifact: import("./blackboard.js").BlackboardArtifact;
}

/** 5 个 Bus Event 总联合 */
export type BusEvent =
  | ArtifactCreatedEvent
  | ArtifactStatusChangedEvent
  | ExecutorCallbackEvent
  | ExecutorResumeEvent
  | HarnessProposalCreatedEvent;

export type BusEventType = BusEvent["type"];

/** ArtifactBusEvent alias(供 shared/index 透出) */
export type ArtifactBusEvent = BusEvent;

/* ─────────────────────────────────────────────────────────────
 * Bus Event Payload TypeMap (helper)
 * ───────────────────────────────────────────────────────────── */

export type BusEventPayload<T extends BusEventType> = Extract<BusEvent, { type: T }>;

/** publish(eventType, payload) → handler(payload) 类型签名 */
export type BusEventHandler<T extends BusEventType = BusEventType> = (
  payload: BusEventPayload<T>,
) => void;

/** typed handler(避免签名类型丢失) */
export type BusEventHandlerOf<T extends BusEventType> = (
  payload: BusEventPayload<T>,
) => void;

/** 运行时 type guard */
export const BUS_EVENT_TYPES = [
  "artifact_created",
  "artifact_status_changed",
  "executor_callback",
  "executor_resume",
  "harness_proposal_created",
] as const satisfies ReadonlyArray<BusEventType>;

export function isArtifactBusEventType(value: unknown): value is BusEventType {
  return (
    typeof value === "string" &&
    (BUS_EVENT_TYPES as ReadonlyArray<string>).includes(value)
  );
}