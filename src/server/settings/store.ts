/**
 * Sansheng Settings · 持久化到 ~/.sansheng/settings.json (明文,M2 再迁 SQLite)
 *
 * M1.5: 支持多 provider。settings.providers[] 存所有配置,activeProviderId 指定当前用哪个。
 * 兼容旧的单 provider 格式(load 时自动迁移)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "../../shared/log.js";

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
  constructor(private readonly file: string) {}

  load(): Settings {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = { ...DEFAULTS, providers: [] };
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Record<string, unknown>;
      const wasLegacy = !Array.isArray(raw.providers);
      this.cache = this.migrate(raw);
      // 旧格式迁移后写回磁盘,避免每次启动重复迁移
      if (wasLegacy) {
        try {
          writeFileSync(this.file, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
          log.info("persisted migrated settings.json (legacy → multi-provider)");
        } catch (err) {
          log.warn("failed to persist migrated settings:", err);
        }
      }
    } catch {
      this.cache = { ...DEFAULTS, providers: [] };
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
    writeFileSync(this.file, JSON.stringify(s, null, 2), { mode: 0o600 });
    this.cache = s;
  }

  /** 返回当前激活的 provider 配置(可能为 undefined) */
  activeProvider(): ProviderConfig | undefined {
    const s = this.load();
    return s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0];
  }

  reset(): void {
    this.save({ ...DEFAULTS, providers: [] });
  }
}

export { isMaskedApiKey };