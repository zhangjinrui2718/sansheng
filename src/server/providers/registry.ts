/**
 * Sansheng Provider Registry · 把 Settings 里的 provider+modelId 映射成 Pi SDK
 * 可用的 Model 对象。优先使用 Pi 自带的 builtin catalog。
 */
import { getBuiltinModel, builtinProviders, getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import { log } from "../../shared/log.js";

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

export function listProviders(): ProviderInfo[] {
  const providers = builtinProviders().filter((p) => p.id !== "radius");
  return providers.map((p) => {
    const models = getBuiltinModels(p.id as BuiltinProvider).map((m: any) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: p.id,
      contextWindow: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : undefined,
      reasoning: Boolean(m.reasoning),
    }));
    return {
      id: p.id,
      name: p.name ?? p.id,
      models,
    };
  });
}

export function resolveModel(opts: {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}): Model<any> | null {
  const { provider, modelId, apiKey, baseUrl } = opts;
  if (!apiKey) return null;
  try {
    const m = getBuiltinModel(provider as any, modelId as any) as Model<any>;
    if (baseUrl) {
      (m as any).baseUrl = baseUrl;
    }
    const envKey = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    process.env[envKey] = apiKey;
    return m;
  } catch (err) {
    log.warn(`failed to resolve model ${provider}/${modelId}:`, err);
    return null;
  }
}