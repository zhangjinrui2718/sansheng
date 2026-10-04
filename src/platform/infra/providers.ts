/**
 * Sansheng Provider Registry · 把 Settings 里的 provider+modelId 映射成 Pi SDK
 * 可用的 Model 对象。优先使用 Pi 自带的 builtin catalog。
 *
 * 批次 4b B6(审查 §B6)两条修复,都在本文件落地:
 *
 * 1. **不改写 pi-ai 共享 catalog**。`getBuiltinModel` 返回的是 catalog 里的
 *    **同一个对象**(实证:all.js:49 `return MODELS[provider][modelId]`),旧实现
 *    直接 `m.baseUrl = baseUrl` 就地把用户的自定义 baseUrl 写进了全局 catalog
 *    → 用户把 baseUrl 删掉之后,进程内再也回不到默认值(第二次 resolve 不传
 *    baseUrl 仍返回旧值)。现在一律 `{ ...builtin }` 浅拷贝后再改,共享对象
 *    永不被写。
 *
 * 2. **明文 key 不再进 process.env**。旧实现在 resolveModel 里写
 *    `process.env[envKey] = apiKey`:server spawn 的一切子进程(Pi session 的
 *    bash/edit 工具)都会继承全部 provider 的明文 key;而且 PROVIDER_ENV_KEY
 *    映射里多个 provider 共用同一个变量名(moonshotai / moonshotai-cn →
 *    MOONSHOT_API_KEY),后 resolve 的覆盖先 resolve 的,切 provider 之后旧 key
 *    永远留在 env 里。
 *    现在:resolveModel 是**纯函数**,不碰 env;需要 env 的只有一条路径 ——
 *    Pi session(SDK 的 ModelRuntime 从 agentDir/auth.json 或 env 取凭据),
 *    由 `syncActiveProviderApiKeyEnv()` 在 createPiSession **之前**一次性同步
 *    「当前 active provider」,并清掉上一次同步留下的变量。
 *    其它所有 LLM 调用(ws makeLlmCall / decide / 沉淀 / harness)走
 *    `completeSimple(model, ctx, { apiKey })` 显式传参 —— pi-ai compat 的
 *    withEnvApiKey 只在 options.apiKey 缺失时才回落 env,显式传参优先级更高。
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

/**
 * B6:上一次 syncActiveProviderApiKeyEnv 写入的 env 变量名。
 * 切 provider 时据此把旧变量删掉 —— 进程里最多只留**当前 active provider**
 * 一家的明文 key(而不是"用过的每一家都留着")。
 */
let lastSyncedEnvKey: string | null = null;

/** provider id → 它从 process.env 里读哪个变量取 api key(测试/诊断用)。 */
export function providerEnvKey(provider: string): string | undefined {
  return PROVIDER_ENV_KEY[provider];
}

/**
 * B6:把 **active provider** 的 apiKey 同步进 process.env,并清掉上一次同步
 * 留下的变量。仅供 createPiSession 之前的一次性调用。
 *
 * 为什么 Pi session 还需要 env:
 *  - `createAgentSession` 内部自建 `ModelRuntime.create({ authPath })`,
 *    而 Sansheng 不写 agentDir/auth.json(passphrase 形态 SDK 侧也不便注入),
 *    所以凭据实际来自 `defaultProviderAuthContext()` 读的 env;
 *  - Pi session 的工具执行会 spawn 子进程,这些子进程也继承 env。
 * 也就是说这条 env 泄漏**无法完全避免**(子进程必须有凭据才能调 API),能做的是
 * 把它收敛到「只有 active provider、只在建 session 前」,而不是每次 resolveModel
 * 都往 env 里塞一遍。
 */
export function syncActiveProviderApiKeyEnv(provider: string, apiKey: string): void {
  const nextKey = PROVIDER_ENV_KEY[provider] ?? null;
  if (lastSyncedEnvKey && lastSyncedEnvKey !== nextKey) {
    delete process.env[lastSyncedEnvKey];
  }
  if (!nextKey || !apiKey) {
    lastSyncedEnvKey = nextKey;
    return;
  }
  process.env[nextKey] = apiKey;
  lastSyncedEnvKey = nextKey;
  if (!PROVIDER_ENV_KEY[provider]) {
    log.warn(`syncActiveProviderApiKeyEnv: provider "${provider}" has no env key mapping (Pi may still find it via model headers/baseUrl)`);
  }
}

export function resolveModel(opts: {
  provider: string;
  modelId: string;
  apiKey: string;
  /** null 与 undefined 同义:回到 catalog 默认 baseUrl(显式清除自定义值)。 */
  baseUrl?: string | null;
}): Model<any> | null {
  const { provider, modelId, apiKey, baseUrl } = opts;
  if (!apiKey) return null;

  try {
    // `modelId as never` satisfies the constrained generic `TModelId extends keyof (typeof MODELS)[TProvider]`
    // (with `provider` widened to the BuiltinProvider union, the keyof collapses to `never` because
    // different providers have disjoint model-id sets). Runtime lookup `MODELS[provider]?.[modelId]`
    // accepts any string, so the cast is safe.
    const builtin = getBuiltinModel(provider as BuiltinProvider, modelId as never) as Model<any> | undefined;
    if (!builtin) {
      // 旧实现此处会把 undefined 原样返回(声明类型却是 `Model | null`),
      // 调用方靠 `if (!m)` 兜住;现在如实返回 null,类型与运行时一致。
      log.warn(`resolveModel: unknown model ${provider}/${modelId}`);
      return null;
    }
    // B6:浅拷贝后再改 —— catalog 里那一份永不被写。
    const m: Model<any> = { ...builtin };
    if (baseUrl) {
      if (hasBaseUrl(m)) m.baseUrl = baseUrl;
    }
    // baseUrl 为空(null/undefined)→ 保留 catalog 默认值。
    // 旧实现 `hasBaseUrl(m) && baseUrl` 配合就地改写,导致「删掉自定义 baseUrl」
    // 永远不生效(粘滞)。
    return m;
  } catch (err) {
    log.warn(`failed to resolve model ${provider}/${modelId}:`, err);
    return null;
  }
}