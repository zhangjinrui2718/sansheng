/**
 * Sansheng · 共享类型:Artifact
 * M5 之后填实。
 */
export type ArtifactKind = "doc" | "code" | "project" | "data" | "diagram" | "file" | "harness";

export interface ArtifactSummary {
  id: string;
  kind: ArtifactKind;
  title: string;
  summary?: string;
  path: string;
  sourceConversationId?: string;
  sourceRole?: string;
  tags?: string[];
  pinned?: boolean;
  archived?: boolean;
  sizeBytes?: number;
  createdAt: number;
  updatedAt: number;
}