/**
 * 设置写入 · 唯一实现
 *
 * ── 为什么必须只有一份 ──────────────────────────────────────────
 *
 * 这段逻辑里有一条**很容易写错、写错了后果很隐蔽**的规则:
 *
 * > 用户没填 apiKey(undefined)或填的是掩码串 → **保留旧真值**;
 * > 填了新真值 → 用它。
 *
 * 漏掉这条的后果是:用户改了一下模型名,保存后 **API key 被清空** ——
 * 而界面上看不出任何异常(掩码照常显示),直到下一次调用报「No API key」。
 *
 * 旧系统在 `src/server/http.ts` 的 PUT 里有一份,新平台的 settings 路由也要,
 * 复制一份就是两处独立的、都可能写错的实现。所以提取到这里。
 *
 * ── 与旧系统的关系 ──────────────────────────────────────────────
 *
 * 两者都调 `applySettingsPatch`。旧侧多一步 `kernel.invalidate()`
 * (那是旧 kernel 的生命周期,不属于设置本身),所以它不由本模块负责。
 */
import {
  genProviderId, isMaskedApiKey,
  type ProviderConfig, type Settings, type SettingsStore, type ThinkingLevel,
} from "./store.js";
import { maskApiKey } from "../storage/keyring.js";
import type { SettingsPublic } from "@shared/types/settings.js";

/** PUT /api/settings 的请求体形态(所有字段可选,局部更新)。 */
export interface SettingsPatch {
  providers?: Array<Partial<ProviderConfig>>;
  activeProviderId?: string;
  cwd?: string;
  personaName?: string;
  costBudgetUsd?: number;
}

export type ApplyResult =
  | { readonly ok: true; readonly settings: Settings }
  | { readonly ok: false; readonly error: string };

/** 把库里的设置转成可下发的形状(apiKey 掩码)。 */
export function toPublicSettings(s: Settings): SettingsPublic {
  return {
    providers: s.providers.map((p) => ({
      id: p.id,
      label: p.label,
      provider: p.provider,
      modelId: p.modelId,
      apiKey: maskApiKey(p.apiKey),
      hasApiKey: p.apiKey.length > 0,
      baseUrl: p.baseUrl,
      thinkingLevel: p.thinkingLevel,
    })),
    activeProviderId: s.activeProviderId,
    cwd: s.cwd,
    personaName: s.personaName,
    costBudgetUsd: s.costBudgetUsd,
  };
}

function isPatch(v: unknown): v is SettingsPatch {
  return v !== null && typeof v === "object";
}

/**
 * 应用一次设置更新并落盘。
 *
 * **不抛异常** —— 设置写失败要给用户一句能读懂的话,而不是一个栈回溯。
 */
export function applySettingsPatch(store: SettingsStore, body: unknown): ApplyResult {
  if (!isPatch(body)) return { ok: false, error: "请求体不是合法 JSON 对象" };
  if (body.providers !== undefined && !Array.isArray(body.providers)) {
    return { ok: false, error: "providers 必须是数组" };
  }

  const cur = store.load();
  const curById = new Map(cur.providers.map((p) => [p.id, p]));

  // **不传 providers 就是「不动它」,不是「清空它」。**
  //
  // 这里原本写成 `(body.providers ?? [])`,于是「只改 cwd」的一次局部更新会把
  // 用户所有 provider 配置**全部清掉** —— 而接口返回 200、界面看不出异常,
  // 直到下次调用才发现没有 provider。测试(grep「局部更新」)当场抓到了它。
  const nextProviders: ProviderConfig[] =
    body.providers === undefined
      ? cur.providers
      : body.providers.map((p) => {
          const existing = p.id !== undefined && p.id !== "" ? curById.get(p.id) : undefined;
          // ── 这条是整段逻辑里唯一容易写错的地方(见文件头) ──
          let apiKey = existing?.apiKey ?? "";
          if (p.apiKey !== undefined && p.apiKey !== null && !isMaskedApiKey(p.apiKey)) {
            apiKey = p.apiKey;
          }
          return {
            id: p.id !== undefined && p.id !== "" ? p.id : genProviderId(),
            label: p.label !== undefined && p.label !== "" ? p.label : (p.provider ?? "未命名"),
            provider: p.provider ?? "",
            modelId: p.modelId ?? "",
            apiKey,
            ...(p.baseUrl !== undefined && p.baseUrl !== "" ? { baseUrl: p.baseUrl } : {}),
            thinkingLevel: (p.thinkingLevel as ThinkingLevel | undefined) ?? "medium",
          };
        });

  // activeProviderId 指向一个已被删掉的 provider 时,回落到第一个 ——
  // 否则「活动 provider」会变成一个不存在的 id,而后续解析模型会静默失败
  let activeProviderId = body.activeProviderId ?? cur.activeProviderId;
  if (!nextProviders.some((p) => p.id === activeProviderId)) {
    activeProviderId = nextProviders[0]?.id ?? "";
  }

  const next: Settings = {
    ...cur,
    providers: nextProviders,
    activeProviderId,
    cwd: body.cwd ?? cur.cwd,
    personaName: body.personaName ?? cur.personaName,
    ...(body.costBudgetUsd !== undefined ? { costBudgetUsd: body.costBudgetUsd } : {}),
  };

  store.save(next);
  return { ok: true, settings: next };
}
