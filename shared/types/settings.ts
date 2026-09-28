/**
 * Sansheng 共享类型:Settings (M1.5 · 多 provider)
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** 一个已配置的 LLM provider(可配多个,activeProviderId 指定当前用哪个) */
export interface ProviderConfig {
  id: string;              // 唯一 id,如 "prov_ab12cd"
  label: string;           // 用户起的显示名,如 "MiniMax 主力"
  provider: string;        // pi provider id,如 "minimax-cn"
  modelId: string;         // 模型 id,如 "MiniMax-M3"
  apiKey: string;          // 服务端返回时已 mask
  hasApiKey: boolean;      // 服务端计算,前端只读
  baseUrl?: string;        // 可选自定义 gateway
  thinkingLevel: ThinkingLevel;
}

export interface SettingsPublic {
  providers: ProviderConfig[];
  activeProviderId: string;
  cwd: string;
  personaName: string;
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