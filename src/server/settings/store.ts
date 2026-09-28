/**
 * Sansheng Settings · 持久化到 ~/.sansheng/settings.json (明文,M2 再迁 SQLite)
 * 包含 LLM provider / model / api key / thinking level / 默认 cwd 等。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../../shared/log.js";

function isMaskedApiKey(s: string): boolean {
  if (!s) return true;
  if (s === "****") return true;
  if (/^\*+$/.test(s)) return true;
  if (s.includes("****")) return true;
  return false;
}

export interface Settings {
  provider: string;          // "anthropic" | "openai" | 自定义
  modelId: string;          // 模型 id,如 "claude-opus-4-5"
  apiKey: string;           // 明文(M1),M2 改 AES-256-GCM
  baseUrl?: string;         // 可选,自定义 gateway
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
  cwd: string;              // Agent 默认工作目录
  personaName: string;       // 显示名,默认 "三生"
  agentDir?: string;         // Pi agentDir,默认 ~/.sansheng/pi
  /** 后续 M2+ 用 */
  costBudgetUsd?: number;
  monthlySpentUsd?: number;
  lastResetAt?: number;
}

const DEFAULTS: Settings = {
  provider: "anthropic",
  modelId: "claude-opus-4-5",
  apiKey: "",
  thinkingLevel: "medium",
  cwd: process.env.HOME ?? "/root",
  personaName: "三生",
};

export class SettingsStore {
  private cache: Settings | null = null;
  constructor(private readonly file: string) {}

  load(): Settings {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = { ...DEFAULTS };
      return this.cache;
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<Settings>;
      const merged = { ...DEFAULTS, ...raw } as Settings;
      // 防御:如果磁盘上的 apiKey 正好是我们生成的 masked placeholder
      // (例如上一轮 bug 留下的 "sk-c****OYzo"),load 时清掉,避免用假值调 LLM
      if (isMaskedApiKey(merged.apiKey)) {
        log.warn(`settings.json apiKey is a masked placeholder ("${merged.apiKey}"), clearing it`);
        merged.apiKey = "";
        // 顺便把文件也清掉
        try {
          writeFileSync(this.file, JSON.stringify(merged, null, 2), { mode: 0o600 });
        } catch {}
      }
      this.cache = merged;
    } catch {
      this.cache = { ...DEFAULTS };
    }
    return this.cache;
  }

  save(s: Settings): void {
    const dir = join(this.file, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify(s, null, 2), { mode: 0o600 });
    this.cache = s;
  }

  update(patch: Partial<Settings>): Settings {
    const cur = this.load();
    const next = { ...cur, ...patch };
    this.save(next);
    return next;
  }

  reset(): void {
    this.save({ ...DEFAULTS });
  }
}