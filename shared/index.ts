export * from "./types/chat";
export * from "./types/agents";
export * from "./types/artifacts";
export * from "./types/goals";
export * from "./types/ws";
export * from "./types/settings";
// M3+ B1 — explicit re-exports to avoid ArtifactKind clash between
// legacy `shared/types/artifacts.ts` (M5) and new `shared/types/blackboard.ts` (M3+).
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
} from "./types/blackboard.js";
export type {
  BlackboardScope,
  ArtifactKind,
  ArtifactStatus,
  ArtifactAuthor,
  CallbackReason,
  HarnessCategory,
  RiskLevel,
  FileChangeType,
  FileChange,
  BlackboardArtifactMetadata,
  BlackboardArtifact,
  BlackboardShape,
} from "./types/blackboard.js";
export type {
  ArtifactCreatedEvent,
  ArtifactStatusChangedEvent,
  ExecutorCallbackEvent,
  ExecutorResumeEvent,
  HarnessProposalCreatedEvent,
  ArtifactBusEvent,
} from "./types/bus.js";
export { isArtifactBusEventType } from "./types/bus.js";