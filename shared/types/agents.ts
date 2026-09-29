/**
 * Sansheng · 共享类型:Agents & Blackboard
 * M0/M1 占位 → M3a 增补 → M3b 落地 Blackboard + PlanStep + EvidenceItem 等结构。
 */

export type RoleId = "planner" | "executor" | "critic" | "memory" | "reflection";

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

export type RoleKind = "planner" | "executor" | "critic" | "memory" | "reflection";

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