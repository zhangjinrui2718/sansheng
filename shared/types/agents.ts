/**
 * Sansheng · 共享类型:Agents & Blackboard
 * M3 之后填实,先定义形状。
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