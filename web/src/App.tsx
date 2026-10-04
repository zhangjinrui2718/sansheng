/**
 * Sansheng · 应用外壳与路由
 *
 * ── 相对旧版改了什么 ────────────────────────────────────────────
 *
 *  1. **路由表换成新模型的页面**:旧的是「对话 / Agent / 总线 / 记忆 / 工件 /
 *     目标 / Harness / 设置」。其中「总线」在新架构里已删除(MessageBus 没了),
 *     「目标」是计划时代的投影(已换成工作项),「Agent」的主体变成了项目成员。
 *     新的:`chat / project / works / inbox / artifacts / members / memory /
 *     harness / settings`。
 *  2. **`POST /api/kernel/reset` 已不存在**,「重置 Kernel」按钮删除;相关的
 *     `vecLoaded` 降级提示也删除 —— 新契约的 `HealthResponse` 里没有 `vecLoaded`,
 *     旧 `/api/health` 的 `d.ts`(服务器时间)同样不在契约里,所以顶栏改为显示
 *     真实存在的字段(连接状态 + 模型)。
 *  3. **所有请求经 `lib/api.ts`**:`/api/config` 与 `/api/health` 也不再裸 fetch。
 *  4. 项目列表的加载收在这里(所有路由都挂着)并按 `projectsRevision` 重拉,
 *     各页面只读 store,不各自拉一份。
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AppConfigResponse, HealthResponse } from "@shared/types/platform";
import { TopBar } from "./components/shell/TopBar";
import { HistoryRail } from "./components/shell/HistoryRail";
import { AgentPanel } from "./components/shell/AgentPanel";
import { ChatSurface } from "./components/chat/ChatSurface";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { ProjectDetailPage } from "./routes/ProjectDetail";
import { WorksPage } from "./routes/Works";
import { InboxPage } from "./routes/Inbox";
import { ArtifactsPage } from "./routes/Artifacts";
import { MembersPage } from "./routes/Members";
import { MemoryPage } from "./routes/Memory";
import { HarnessPage } from "./routes/Harness";
import { useSettingsStore, activeProviderOf } from "./stores/settings";
import { useChatStore } from "./stores/chat";
import { initAppSocket } from "./lib/appSocket";
import { getConfig, getHealth } from "./lib/api";

/**
 * 路由态。单一来源 —— TopBar 的 NavTab 与 App 的分支渲染共用这个 union,
 * 避免两处各写一份字面量后悄悄漂移。
 */
export type Route =
  | "chat"
  | "project"
  | "works"
  | "inbox"
  | "artifacts"
  | "members"
  | "memory"
  | "harness"
  | "settings";

export function App() {
  const [route, setRoute] = useState<Route>("chat");
  const [cfg, setCfg] = useState<AppConfigResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const settings = useSettingsStore((s) => s.settings);
  const provider = useChatStore((s) => s.provider);
  const modelId = useChatStore((s) => s.modelId);
  const totalUsage = useChatStore((s) => s.totalUsage);
  const currentUsage = useChatStore((s) => s.currentUsage);
  const status = useChatStore((s) => s.status);
  const projectsRevision = useChatStore((s) => s.projectsRevision);
  const loadProjects = useChatStore((s) => s.loadProjects);

  // App 级 socket 单例 —— mount 即连接,生命周期与 App 相同,路由切换不断流。
  // initAppSocket 幂等(StrictMode 双 effect 安全);无 cleanup —— 单例常驻。
  useEffect(() => {
    initAppSocket();
  }, []);

  // 项目列表:App 唯一负责(所有路由都挂着),WS 事件经 projectsRevision 触发重拉。
  useEffect(() => {
    void loadProjects();
  }, [loadProjects, projectsRevision]);

  useEffect(() => {
    getConfig()
      .then(setCfg)
      .catch(() => setCfg(null));

    const tick = () => {
      getHealth()
        .then(setHealth)
        .catch(() => setHealth(null));
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const active = activeProviderOf(settings);
  const needsSetup = !settings || settings.providers.length === 0 || !active?.hasApiKey;

  /**
   * 非对话路由的统一外壳:滚动容器 + <main> 只在这里出现一次。
   * 各路由组件自己只渲染 `<div className="ss-page">`。
   */
  const page = (node: ReactNode) => (
    <main className="overflow-y-auto" style={{ background: "var(--ink-0)", minHeight: 0 }}>
      {node}
    </main>
  );

  return (
    <div className="sansheng-shell">
      <TopBar
        config={cfg}
        health={health}
        route={route}
        onRoute={setRoute}
        currentUsage={currentUsage}
        totalUsage={totalUsage}
        status={status}
      />
      {route === "chat" ? (
        <main className="grid grid-cols-app gap-3 px-4 pb-4" style={{ minHeight: 0 }}>
          <HistoryRail />
          {needsSetup ? <SetupHint onGo={() => setRoute("settings")} /> : <ChatSurface />}
          <AgentPanel />
        </main>
      ) : route === "project" ? (
        page(<ProjectDetailPage />)
      ) : route === "works" ? (
        page(<WorksPage />)
      ) : route === "inbox" ? (
        page(<InboxPage />)
      ) : route === "artifacts" ? (
        page(<ArtifactsPage />)
      ) : route === "members" ? (
        page(<MembersPage />)
      ) : route === "memory" ? (
        page(<MemoryPage />)
      ) : route === "harness" ? (
        page(<HarnessPage />)
      ) : (
        <main className="overflow-y-auto" style={{ background: "var(--ink-0)", minHeight: 0 }}>
          <div className="ss-page" style={{ maxWidth: 720 }}>
            <SettingsPanel />
          </div>
        </main>
      )}
    </div>
  );
}

function SetupHint({ onGo }: { onGo: () => void }) {
  return (
    <section
      className="sansheng-card overflow-hidden flex flex-col items-center justify-center"
      style={{ minHeight: 0 }}
    >
      <div className="flex flex-col items-center gap-3 max-w-md text-center px-6">
        <svg width="44" height="44" viewBox="0 0 64 64">
          <g stroke="#C76B4A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M16 22 L32 14 L48 22 L48 42 L32 50 L16 42 Z" />
            <path d="M32 14 L32 50" />
          </g>
          <circle cx="32" cy="32" r="3.5" fill="#C76B4A" />
        </svg>
        <div className="font-serif text-lg" style={{ color: "var(--bone)", letterSpacing: ".06em" }}>
          未配置 API Key
        </div>
        <p className="sansheng-text-dim" style={{ fontSize: 12, lineHeight: 1.7 }}>
          至少配一个 LLM Provider 的 API Key 才能开始工作。
        </p>
        <button className="sansheng-button-primary" onClick={onGo} style={{ padding: "8px 16px" }}>
          去设置 →
        </button>
      </div>
    </section>
  );
}
