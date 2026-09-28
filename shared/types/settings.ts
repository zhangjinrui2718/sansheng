/**
 * Sansheng 共享类型:Settings (M1)
 */
export interface SettingsPublic {
  provider: string;
  modelId: string;
  apiKey: string;       // 服务端返回时已 mask
  hasApiKey: boolean;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
  cwd: string;
  personaName: string;
  baseUrl?: string;
  agentDir?: string;
  costBudgetUsd?: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: ModelInfo[];
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: string;
  reasoning: boolean;
}