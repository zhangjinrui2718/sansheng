/**
 * Sansheng Settings Store · 缓存 /api/settings、/api/providers 的拉取结果
 */
import { create } from "zustand";
import type { SettingsPublic, ProviderInfo } from "@shared/types/settings";

interface SettingsState {
  settings: SettingsPublic | null;
  providers: ProviderInfo[];
  loaded: boolean;

  loadSettings(): Promise<void>;
  saveSettings(patch: Partial<SettingsPublic>): Promise<void>;
  loadProviders(): Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
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

  async saveSettings(patch: Partial<SettingsPublic>) {
    const r = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await r.json();
    set({ settings: data.settings });
  },
}));