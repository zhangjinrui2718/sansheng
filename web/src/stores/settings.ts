/**
 * Sansheng Settings Store · 缓存 /api/settings、/api/providers
 * M1.5: 多 provider(providers[] + activeProviderId)
 */
import { create } from "zustand";
import type { SettingsPublic, ProviderInfo, ProviderConfig } from "@shared/types/settings";

interface SettingsState {
  settings: SettingsPublic | null;
  providers: ProviderInfo[];
  loaded: boolean;

  loadSettings(): Promise<void>;
  loadProviders(): Promise<void>;
  saveSettings(next: SettingsPublic): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  providers: [],
  loaded: false,

  async loadSettings() {
    const r = await fetch("/api/settings");
    const data = (await r.json()) as SettingsPublic;
    set({ settings: data, loaded: true });
  },

  async loadProviders() {
    const r = await fetch("/api/providers");
    const data = (await r.json()) as { providers: ProviderInfo[] };
    set({ providers: data.providers });
  },

  async saveSettings(next: SettingsPublic) {
    const r = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const data = await r.json();
    set({ settings: data.settings });
  },
}));

/** 当前激活的 provider 配置(可能 undefined) */
export function activeProviderOf(s: SettingsPublic | null): ProviderConfig | undefined {
  if (!s) return undefined;
  return s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0];
}
