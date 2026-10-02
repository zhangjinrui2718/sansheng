/**
 * Sansheng Settings · 持久化到 ~/.sansheng/settings.json
 *
 * M1.5: 支持多 provider。settings.providers[] 存所有配置,activeProviderId 指定当前用哪个。
 *        兼容旧的单 provider 格式(load 时自动迁移)。
 * M2:    apiKey 在磁盘上用 Keyring 加密;内存里永远保持明文方便 kernel / UI 读取。
 *        启动时检测到明文残留会一次性升级为加密格式。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "../../shared/log.js";
import { Keyring, isEncrypted } from "../storage/index.js";

function isMaskedApiKey(s: string): boolean {
  if (!s) return true;
  if (s === "****") return true;
  if (/^\*+$/.test(s)) return true;
  if (s.includes("****")) return true;
  return false;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ProviderConfig {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  thinkingLevel: ThinkingLevel;
}

export interface Settings {
  providers: ProviderConfig[];
  activeProviderId: string;
  cwd: string;
  personaName: string;
  agentDir?: string;
  costBudgetUsd?: number;
  monthlySpentUsd?: number;
  lastResetAt?: number;
}

export function genProviderId(): string {
  return `prov_${randomBytes(4).toString("hex")}`;
}

const DEFAULTS: Settings = {
  providers: [],
  activeProviderId: "",
  cwd: process.env.HOME ?? "/root",
  personaName: "三生",
};

export class SettingsStore {
  private cache: Settings | null = null;
  constructor(
    private readonly file: string,
    private readonly keyring: Keyring | null,
  ) {}

  load(): Settings {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = { ...DEFAULTS, providers: [] };
      return this.cache;
    }
    let parsed: Settings;
    let wasLegacy = false;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Record<string, unknown>;
      wasLegacy = !Array.isArray(raw.providers);
      parsed = this.migrate(raw);
    } catch {
      parsed = { ...DEFAULTS, providers: [] };
      this.cache = parsed;
      return this.cache;
    }

    // 解密:内存里绝不存密文(apiKey 永远是 plain)。同时检测明文残留 → 升级到加密。
    let anyWasPlain = false;
    if (this.keyring) {
      parsed = {
        ...parsed,
        providers: parsed.providers.map((p) => {
          if (!p.apiKey) return p;
          if (isMaskedApiKey(p.apiKey)) return p;
          if (isEncrypted(p.apiKey)) {
            try {
              const decrypted = this.keyring!.decrypt(p.apiKey);
              // 防御:解密结果是 masked/空 → 视为损坏,清空
              if (!decrypted || isMaskedApiKey(decrypted)) {
                log.warn(`settings: failed to decrypt apiKey for provider ${p.id} — cleared`);
                return { ...p, apiKey: "" };
              }
              return { ...p, apiKey: decrypted };
            } catch (err) {
              log.warn(`settings: decrypt error for provider ${p.id}:`, err);
              return { ...p, apiKey: "" };
            }
          }
          // 明文 apiKey → 记下来,稍后升级到加密
          anyWasPlain = true;
          return p;
        }),
      };
    } else {
      log.warn("settings: no Keyring configured — apiKey will be stored in plaintext");
    }

    this.cache = parsed;

    // 升级:legacy 格式 OR 明文残留 → 重新写盘(这次会走加密)
    if (wasLegacy || anyWasPlain) {
      try {
        this.save(parsed);
        log.info(`persisted settings.json (legacy=${wasLegacy}, upgradedPlaintext=${anyWasPlain})`);
      } catch (err) {
        log.warn("failed to persist upgraded settings:", err);
      }
    }

    return this.cache;
  }

  /** 把磁盘上的 JSON(可能是旧单-provider 格式)规整成新格式 */
  private migrate(raw: Record<string, unknown>): Settings {
    const cwd = (raw.cwd as string) ?? DEFAULTS.cwd;
    const personaName = (raw.personaName as string) ?? DEFAULTS.personaName;
    const agentDir = raw.agentDir as string | undefined;

    // 新格式:已有 providers 数组
    if (Array.isArray(raw.providers)) {
      const providers = (raw.providers as ProviderConfig[]).map((p) => this.sanitizeProvider(p));
      let activeProviderId = (raw.activeProviderId as string) ?? "";
      if (!providers.find((p) => p.id === activeProviderId)) {
        activeProviderId = providers[0]?.id ?? "";
      }
      return {
        providers,
        activeProviderId,
        cwd,
        personaName,
        agentDir,
        costBudgetUsd: raw.costBudgetUsd as number | undefined,
        monthlySpentUsd: raw.monthlySpentUsd as number | undefined,
        lastResetAt: raw.lastResetAt as number | undefined,
      };
    }

    // 旧格式:单 provider 字段 → 迁移成 providers[0]
    const legacyProvider = raw.provider as string | undefined;
    const legacyModel = raw.modelId as string | undefined;
    const legacyKey = raw.apiKey as string | undefined;
    if (legacyProvider && legacyModel) {
      const id = genProviderId();
      const provider: ProviderConfig = {
        id,
        label: legacyProvider,
        provider: legacyProvider,
        modelId: legacyModel,
        // 旧值若是 masked placeholder,清空
        apiKey: legacyKey && !isMaskedApiKey(legacyKey) ? legacyKey : "",
        baseUrl: raw.baseUrl as string | undefined,
        thinkingLevel: (raw.thinkingLevel as ThinkingLevel) ?? "medium",
      };
      log.info(`migrated legacy single-provider settings → providers[0] (${legacyProvider}/${legacyModel})`);
      return { providers: [provider], activeProviderId: id, cwd, personaName, agentDir };
    }

    return { providers: [], activeProviderId: "", cwd, personaName, agentDir };
  }

  private sanitizeProvider(p: Partial<ProviderConfig>): ProviderConfig {
    return {
      id: p.id || genProviderId(),
      label: p.label || p.provider || "未命名",
      provider: p.provider || "",
      modelId: p.modelId || "",
      apiKey: p.apiKey && !isMaskedApiKey(p.apiKey) ? p.apiKey : "",
      baseUrl: p.baseUrl || undefined,
      thinkingLevel: p.thinkingLevel ?? "medium",
    };
  }

  save(s: Settings): void {
    const dir = join(this.file, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const onDisk: Settings = {
      ...s,
      providers: s.providers.map((p) => {
        if (!p.apiKey) return p;
        if (isMaskedApiKey(p.apiKey)) {
          throw new Error(`refusing to save masked apiKey for provider ${p.id} as encrypted`);
        }
        if (this.keyring) {
          if (isEncrypted(p.apiKey)) return p; // 已经加密(可能 UI 拷贝回填)
          return { ...p, apiKey: this.keyring.encrypt(p.apiKey) };
        }
        // 没有 keyring → 明文直存(警告已在 load 时打)
        return p;
      }),
    };

    writeFileSync(this.file, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
    this.cache = s;
  }

  /** 返回当前激活的 provider 配置(可能为 undefined) */
  activeProvider(): ProviderConfig | undefined {
    const s = this.load();
    return s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0];
  }

  /**
   * 批次 4b B5(审查 §B5):丢弃内存缓存,下次 load() 强制重新读盘。
   *
   * 用于 `/api/reset`:即便配置文件**没被删**,也让「内存里的副本」与磁盘重新
   * 对齐 —— 万一 rm 波及到配置(partial failure),也不会拿内存里的旧副本继续
   * 往磁盘写。幂等;不影响已经持有 Settings 引用的调用方(下次 load 才是新的)。
   */
  invalidate(): void {
    this.cache = null;
  }

  reset(): void {
    this.save({ ...DEFAULTS, providers: [] });
  }
}

export { isMaskedApiKey };