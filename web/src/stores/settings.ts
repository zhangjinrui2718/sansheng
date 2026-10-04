/**
 * Sansheng Settings Store · 缓存 /api/settings、/api/providers
 *
 * 路径与错误处理统一交给 `lib/api.ts`(本文件的旧版是**直接 fetch** 的少数几个
 * 残点之一)。字段与行为不变:多 provider(providers[] + activeProviderId)。
 */
import { create } from "zustand";
import type { ProviderInfo, ProviderConfig, SettingsPublic } from "@shared/types/settings";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";

interface SettingsState {
  settings: SettingsPublic | null;
  providers: ProviderInfo[];
  loaded: boolean;
  error: string | null;

  loadSettings(): Promise<void>;
  loadProviders(): Promise<void>;
  saveSettings(next: SettingsPublic): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  providers: [],
  loaded: false,
  error: null,

  async loadSettings() {
    try {
      const data = await api.getSettings();
      set({ settings: data, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: errorMessage(e) });
    }
  },

  async loadProviders() {
    try {
      const { providers } = await api.getProviders();
      set({ providers: Array.isArray(providers) ? providers : [], error: null });
    } catch (e) {
      set({ providers: [], error: errorMessage(e) });
    }
  },

  async saveSettings(next) {
    const { settings } = await api.putSettings(next);
    set({ settings, error: null });
  },
}));

/** 当前激活的 provider 配置(可能 undefined) */
export function activeProviderOf(s: SettingsPublic | null): ProviderConfig | undefined {
  if (!s) return undefined;
  return s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0];
}
