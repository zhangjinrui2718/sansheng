/**
 * Sansheng · 共享类型:Goals & RedLines
 * M5/M7/M8 填实。
 */
export type GoalState = "draft" | "active" | "in_progress" | "blocked" | "done" | "dropped";

export interface Goal {
  id: string;
  title: string;
  description?: string;
  parentId?: string;
  state: GoalState;
  source: "explicit" | "inferred";
  progress?: number;
  milestones?: { id: string; text: string; done: boolean }[];
  createdAt: number;
  updatedAt: number;
}

export interface RedLine {
  id: string;
  rule: string;
  scope: "all" | "session";
  enabled: boolean;
  triggerCount: number;
  lastViolated?: number;
  addedAt: number;
}