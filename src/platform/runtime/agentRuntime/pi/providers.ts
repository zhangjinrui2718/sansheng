/**
 * Sansheng Provider Registry · 把 Settings 里的 provider+modelId 映射成 Pi SDK
 * 可用的 Model 对象。查表来源 = **平台自有目录**(`./modelCatalog.ts`,整表
 * vendor 自 pi-ai,见该文件头)—— 2026-11-16 起不再查 pi-ai 的内置 catalog,
 * postinstall monkey-patch(`scripts/patch-model-catalog.mjs`)随之删除。
 *
 * 批次 4b B6(审查 §B6)两条修复,语义在本文件保持不变:
 *
 * 1. **不改写共享 catalog**。旧实现拿到的就是 catalog 里的**同一个对象**,
 *    直接 `m.baseUrl = baseUrl` 就地把用户的自定义 baseUrl 写进了全局表
 *    → 用户把 baseUrl 删掉之后,进程内再也回不到默认值(第二次 resolve 不传
 *    baseUrl 仍返回旧值)。现在一律 `{ ...builtin }` 浅拷贝后再改,共享对象
 *    永不被写。平台目录里的那一份同样不写。
 *
 * 2. **明文 key 不进 process.env**(2026-11-28 走完最后一步)。旧实现在 resolveModel 里写
 *    `process.env[envKey] = apiKey`:server spawn 的一切子进程(Pi session 的
 *    bash/edit 工具)都会继承全部 provider 的明文 key;而且 PROVIDER_ENV_KEY
 *    映射里多个 provider 共用同一个变量名(moonshotai / moonshotai-cn →
 *    MOONSHOT_API_KEY),后 resolve 的覆盖先 resolve 的,切 provider 之后旧 key
 *    永远留在 env 里。B6 把它收敛成「只有 active provider、只在建 session 前」
 *    (`syncActiveProviderApiKeyEnv`),当时留下的判断是「这条 env 泄漏无法完全避免
 *    (子进程必须有凭据才能调 API)」—— **那句话是错的**:子进程(bash / MCP 服务)
 *    不需要凭据,需要凭据的是 SDK 的 `ModelRuntime`;而它有第三条路 ——
 *    `ModelRuntime.create({ credentials })` + `setRuntimeApiKey(providerId, key)`,
 *    凭据只活在运行期的内存里(`getProviderAuthStatus` 报 `source: "runtime"`)。
 *    现在:`resolveModel` 是**纯函数**;`platformModelRuntime(agentDir)` 给每个 agentDir
 *    建一份 ModelRuntime(与 SDK 自建的那份同参数:`authPath` / `modelsPath` 都指向
 *    agentDir,用户手写的 auth.json / models.json 照旧读得到),`createPlatformSession`
 *    在建会话前 `setRuntimeApiKey`,并把这份 runtime 交给 `createAgentSession`。
 *    `process.env` 一个字节都不写 ⇒ bash / MCP / docker 之类子进程继承不到 key。
 *    其它所有 LLM 调用(ws makeLlmCall / decide / 沉淀 / harness)照旧走
 *    `completeSimple(model, ctx, { apiKey })` 显式传参。
 */
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  catalogChatModels,
  catalogProviderInfos,
  PROVIDER_ENV_KEY,
  resolveCatalogModel,
} from "./modelCatalog.js";
import { log } from "../../../../shared/log.js";

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
  const providers = catalogProviderInfos().filter((p) => p.id !== "radius");
  return providers.map((p) => {
    const models = catalogChatModels(p.id).map((m) => ({
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

/** provider id → 它在 pi-ai 那边对应的 env 变量名(测试 / 诊断 / 降级候选过滤用)。 */
export function providerEnvKey(provider: string): string | undefined {
  return PROVIDER_ENV_KEY[provider];
}

/**
 * 每个 agentDir 一份 `ModelRuntime`(懒建、进程内复用)。
 *
 * 与 SDK 在 `createAgentSession` 里自建的那份**同参数**:`authPath` / `modelsPath`
 * 都指向 agentDir —— 用户手写的 `auth.json` / `models.json` 照旧读得到;区别只在
 * 凭据多了「运行期」这一个来源(`setRuntimeApiKey`),于是不必再把 key 写进 `process.env`。
 *
 * 失败的建尝试不缓存(否则一次瞬时失败会让这个进程以后永远建不出会话)。
 */
const modelRuntimes = new Map<string, Promise<ModelRuntime>>();

export function platformModelRuntime(agentDir: string): Promise<ModelRuntime> {
  let pending = modelRuntimes.get(agentDir);
  if (pending === undefined) {
    pending = ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    modelRuntimes.set(agentDir, pending);
    void pending.catch(() => {
      if (modelRuntimes.get(agentDir) === pending) modelRuntimes.delete(agentDir);
    });
  }
  return pending;
}

/**
 * 把 active provider 的 key 交给这份 runtime —— **只进内存,不进 `process.env`**。
 *
 * 每次建会话前都调一次(幂等):设置改了 / 降级换了家,下一次建会话自然带上新 key,
 * 不需要像 env 那样「先同步再解析」「切走时记得删」。
 * `apiKey` 为空 ⇒ 不设(交给 SDK 自己的来源:auth.json / 用户 shell 里的 env)。
 */
export async function armRuntimeApiKey(runtime: ModelRuntime, provider: string, apiKey: string): Promise<boolean> {
  if (!apiKey) return false;
  await runtime.setRuntimeApiKey(provider, apiKey);
  return true;
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
    const builtin = resolveCatalogModel(provider, modelId);
    if (!builtin) {
      // 旧实现此处会把 undefined 原样返回(声明类型却是 `Model | null`),
      // 调用方靠 `if (!m)` 兜住;现在如实返回 null,类型与运行时一致。
      log.warn(`resolveModel: unknown model ${provider}/${modelId}`);
      return null;
    }
    // B6:浅拷贝后再改 —— 平台目录里那一份永不被写。
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
