/**
 * Sansheng Provider Registry · 把 Settings 里的 provider+modelId 映射成 Pi SDK
 * 可用的 Model 对象。优先使用 Pi 自带的 builtin catalog。
 *
 * 同时把 API key 写到 Pi SDK 期望的环境变量(MINIMAX_API_KEY / OPENAI_API_KEY 等),
 * 让 `createAgentSession` → streamSimple → stream() 链路里能拿到。
 */
import { getBuiltinModel, builtinProviders, getBuiltinModels, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import { log } from "../../shared/log.js";

function hasBaseUrl(m: Model<any>): m is Model<any> & { baseUrl?: string } {
  return !!m && typeof m === "object" && "baseUrl" in m;
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

/**
 * Pi SDK 内置 provider → 它从 process.env 里读哪个变量来取 api key。
 * 来源:@earendil-works/pi-ai/dist/providers/*.js 的 auth.envApiKeyAuth 配置。
 * 没列出的 provider(比如 github-copilot / radius / bedrock 等)走 OAuth/别处,
 * 这种我们靠 baseUrl + headers 走,本表只管纯 API key 的。
 */
const PROVIDER_ENV_KEY: Record<string, string> = {
  "anthropic": "ANTHROPIC_API_KEY",
  "ant-ling": "ANT_LING_API_KEY",
  "openai": "OPENAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  "deepseek": "DEEPSEEK_API_KEY",
  "nvidia": "NVIDIA_API_KEY",
  "google": "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_API_KEY",
  "groq": "GROQ_API_KEY",
  "cerebras": "CEREBRAS_API_KEY",
  "xai": "XAI_API_KEY",
  "fireworks": "FIREWORKS_API_KEY",
  "together": "TOGETHER_API_KEY",
  "baseten": "BASETEN_API_KEY",
  "openrouter": "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  "zai": "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  "mistral": "MISTRAL_API_KEY",
  "minimax": "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  "moonshotai": "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  "opencode": "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "meta": "META_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
  "xiaomi": "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
};

export function resolveModel(opts: {
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
}): Model<any> | null {
  const { provider, modelId, apiKey, baseUrl } = opts;
  if (!apiKey) return null;

  const envKey = PROVIDER_ENV_KEY[provider];
  if (!envKey) {
    log.warn(`provider "${provider}" has no known env key mapping; Pi may still find it via model headers/baseUrl`);
  } else {
    process.env[envKey] = apiKey;
  }

  try {
    // `modelId as never` satisfies the constrained generic `TModelId extends keyof (typeof MODELS)[TProvider]`
    // (with `provider` widened to the BuiltinProvider union, the keyof collapses to `never` because
    // different providers have disjoint model-id sets). Runtime lookup `MODELS[provider]?.[modelId]`
    // accepts any string, so the cast is safe.
    const m = getBuiltinModel(provider as BuiltinProvider, modelId as never) as Model<any>;
    if (hasBaseUrl(m) && baseUrl) {
      m.baseUrl = baseUrl;
    }
    return m;
  } catch (err) {
    log.warn(`failed to resolve model ${provider}/${modelId}:`, err);
    return null;
  }
}