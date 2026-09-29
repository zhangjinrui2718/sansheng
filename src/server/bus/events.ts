/**
 * Sansheng · BlackboardArtifact Bus Events (M3+)
 *
 * 5 event types from shared/types/bus.ts:
 *   - artifact_created
 *   - artifact_status_changed
 *   - executor_callback
 *   - executor_resume
 *   - harness_proposal_created
 *
 * 与 MessageBus(BusMessage 通信)分离:本 bus 处理 BlackboardArtifact 生命周期。
 * Re-exports 类型 + handlers map(由 ./index.ts 实例化)。
 */

export type {
  ArtifactCreatedEvent,
  ArtifactStatusChangedEvent,
  ExecutorCallbackEvent,
  ExecutorResumeEvent,
  HarnessProposalCreatedEvent,
  ArtifactBusEvent,
  BusEvent,
  BusEventType,
  BusEventPayload,
  BusEventHandler,
  BusEventHandlerOf,
  BlackboardArtifact,
  BlackboardScope,
  BlackboardArtifactMetadata,
  BlackboardShape,
  ArtifactKind,
  ArtifactStatus,
  ArtifactAuthor,
  RiskLevel,
  HarnessCategory,
  CallbackReason,
  FileChange,
  FileChangeType,
  CommunicatorResponse,
  ValidatedArtifact,
  ParsedCommunicatorResponse,
} from "@shared/types/bus";
export { IMPERATIVE_VERBS, BUS_EVENT_TYPES, isArtifactBusEventType } from "../../../shared/types/bus.js";

/** Event handler map 类型:eventType → handler 集合 */
export type HandlerMap = {
  [T in import("@shared/types/bus").BusEventType]?: Set<
    import("@shared/types/bus").BusEventHandlerOf<T>
  >;
};