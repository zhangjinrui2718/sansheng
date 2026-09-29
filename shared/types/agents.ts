/**
 * Sansheng · 共享类型:Agents & Blackboard
 * M0/M1 占位 → M3a 增补 → M3b 落地 Blackboard + PlanStep + EvidenceItem 等结构。
 */

export type RoleId = "communicator" | "planner" | "executor" | "critic" | "memory" | "reflection";

export interface AgentStatus {
  role: RoleId;
  state: "idle" | "thinking" | "tooling" | "blocked";
  startedAt?: number;
  lastEvent?: string;
}

export interface BlackboardSnapshot {
  conversationId: string;
  goal?: string;
  plan?: { id: string; text: string; status: "pending" | "doing" | "done" }[];
  todos?: { id: string; text: string; done: boolean }[];
  evidence?: { id: string; source: string; summary: string }[];
  critique?: { round: number; passed: boolean; notes: string };
  producedArtifacts?: string[];
  updatedAt: number;
}

// ——— M3b 新增类型 ———

export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "failed";
  assignedExecutor?: string;
  resultSummary?: string;
}

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  ts: number;
}

export interface EvidenceItem {
  step_id: string;
  executor_id: string;
  kind: "observation" | "result" | "data" | "tool_call";
  content: string;
  ts: number;
}

export interface CritiqueRound {
  iteration: number;
  critic_id: string;
  approved: boolean;
  issues: Array<{ severity: "minor" | "major"; message: string }>;
  suggestions: string[];
  ts: number;
}

export interface FragmentRef {
  fragmentId: string;
  relevance: number;
}

export interface Decision {
  iteration: number;
  decision: string;
  by: string;
  ts: number;
}

export interface ArtifactRef {
  kind: string;
  title: string;
  uri?: string;
  ts: number;
}

export interface Blackboard {
  id?: number;
  conversationId: string;
  goal: string;
  plan: PlanStep[];
  todos: Todo[];
  evidence: EvidenceItem[];
  critique: CritiqueRound[];
  retrievedMemories: FragmentRef[];
  decisions: Decision[];
  producedArtifacts: ArtifactRef[];
  ts: number;
  version: number;
  iteration: number;
  status: "active" | "approved" | "abandoned";
  createdAt: number;
}

export type RoleKind = "communicator" | "planner" | "executor" | "critic" | "memory" | "reflection";

// === M3c: MessageBus / Communicator 类型 ===

export type BusDirection = "user→comm" | "comm→worker" | "worker→comm" | "comm→user";

export type BusKind = "question" | "broadcast" | "reply";

/** MessageBus 上流转的一条消息;由 server 端构造 + 持久化,推给前端展示。 */
export interface BusMessage {
  id: string;
  ts: number;
  direction: BusDirection;
  fromRole: RoleId | "user";
  toRole: RoleId | "user";
  conversationId: string;
  kind: BusKind;
  /** 仅 reply 填:与原 question 共用 questionId。 */
  questionId?: string;
  payload: string;
  context?: Record<string, unknown>;
  /** worker 阻塞期局部上下文;恢复时由 caller 自取(resumeState 不落 jsonl)。 */
  resumeState?: unknown;
}

/** Communicator / kernel 之间的 transform 决策。 */
export type CommunicatorDecision =
  | { kind: "chat"; reply: string }
  | { kind: "task"; goal: string; toPlanner?: string }
  | { kind: "feedback"; profileDelta: Record<string, string> };

/** M3c: 前端 Timeline 页看到的 pending question 提示。 */
export interface PendingQuestion {
  questionId: string;
  payload: string;
  fromRole: RoleId;
  ts: number;
}

export interface AgentSessionMeta {
  id: string;
  role: RoleKind;
  conversationId: string;
  modelId: string;
  provider: string;
  createdAt: number;
  lastActiveAt: number;
  status: "idle" | "thinking" | "tool_use" | "done" | "failed" | "aborted";
  lastOutput?: string;
}

export interface AgentRunSummary {
  role: RoleKind;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  status: AgentSessionMeta["status"];
  inputPreview: string;
  outputPreview: string;
  usage?: { input: number; output: number; costUsd: number };
}