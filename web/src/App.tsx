/**
 * Sansheng · 应用外壳与路由(V2)
 *
 * ── V2 改了什么 ────────────────────────────────────────────────
 * 布局换成 AppShell(app/AppShell.tsx):frame + 左栏(恒在、可折叠)+ 圆角页卡。
 * 左栏 = 导航(app/Sidebar.tsx,项目恢复一级)+ 项目列表(HistoryRail 原样嵌入,
 * 判据不动)。此前左栏只挂在 chat 路由、其余页全宽 —— 「项目页藏在对话页
 * 头部链接里」的动线断裂由此修掉。
 *
 * ── 保留的纪律(一个字没动)────────────────────────────────────
 * 1. 路由表在 `app/router.ts`(**地址是唯一真相**);此处 re-export 一次,
 *    新增路由只改那个文件。
 * 2. App 级 socket 单例 mount 即连;项目列表 App 唯一负责(所有路由都挂着),
 *    按 `projectsRevision` 重拉,各页面只读 store。
 * 3. 零项目 ⇒ 自动进接待会话(`decideInitialContext`,必须等列表拉回再决定)。
 * 4. 地址 `?project=` 坐标全应用只挂一处(`useProjectCoordinate`)。
 * 5. 所有请求经 `lib/api.ts`。
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AppConfigResponse, HealthResponse } from "@shared/types/platform";
import { AppShell } from "./app/AppShell";
import { Sidebar } from "./app/Sidebar";
import { TopBar } from "./components/shell/TopBar";
import { ChatSurface } from "./features/chat/ChatSurface";
import { ArtifactFlowPage } from "./features/artifacts/ArtifactFlow";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { ProjectDetailPage } from "./routes/ProjectDetail";
import { WorksPage } from "./routes/Works";
import { MembersPage } from "./routes/Members";
import { MemoryPage } from "./routes/Memory";
import { AboutPage } from "./routes/About";
import { HarnessManagePage } from "./routes/HarnessManage";
import { useSettingsStore, activeProviderOf } from "./stores/settings";
import { useChatStore } from "./stores/chat";
import { initAppSocket } from "./lib/appSocket";
import { getConfig, getHealth } from "./lib/api";
import { useAppLocation, toRoute } from "./app/router";
import { useProjectCoordinate } from "./app/deepLink";
import type { Route } from "./app/router";

/**
 * 路由态在 `app/router.ts`(**地址是唯一真相**,不是组件 state)。
 * 这里 re-export 一次,好让 `TopBar`/`Sidebar` 继续 `import type { Route}`;
 * 新增路由只改那个文件,不会出现「两处各写一份字面量然后悄悄漂移」。
 */
export type { Route } from "./app/router";

export function App() {
  const { loc, navigate } = useAppLocation();
  /** 当前页面 —— 读的是 `location.hash`,所以 F5 / 分享链接落回同一页。 */
  const route = loc.route;
  const go = (r: Route) => navigate(toRoute(r));
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
  const decideInitialContext = useChatStore((s) => s.decideInitialContext);

  // App 级 socket 单例 —— mount 即连接,生命周期与 App 相同,路由切换不断流。
  // initAppSocket 幂等(StrictMode 双 effect 安全);无 cleanup —— 单例常驻。
  useEffect(() => {
    initAppSocket();
  }, []);

  // 项目列表:App 唯一负责(所有路由都挂着),WS 事件经 projectsRevision 触发重拉。
  useEffect(() => {
    void loadProjects();
  }, [loadProjects, projectsRevision]);

  /**
   * 首屏上下文:**一个项目都没有 → 直接进接待会话**。
   * 判断落在 store 里(`decideInitialContext`),因为**必须等列表拉回来再决定**;
   * 有项目时它什么都不做(保持「未选项目」的旧行为)。
   */
  useEffect(() => {
    void decideInitialContext();
  }, [decideInitialContext]);

  /**
   * 地址里的 `?project=`(跨项目地址带的**坐标**)在这里落地。
   * ⚠️ **整个应用只挂这一处** —— 挂多处就会有多份「切过了哪个」的记据,
   * 它们互相看不见,于是地址与当前项目来回抢(「点左栏没反应」)。
   */
  useProjectCoordinate();

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

  /** 页卡内的滚动容器 —— 滚动只在这里出现一次,各路由渲染自己的内容块。 */
  const page = (node: ReactNode) => (
    <div className="overflow-y-auto" style={{ minHeight: 0, height: "100%" }}>
      {node}
    </div>
  );

  return (
    <AppShell
      topbar={
        <TopBar
          config={cfg}
          health={health}
          route={route}
          onRoute={go}
          currentUsage={currentUsage}
          totalUsage={totalUsage}
          status={status}
        />
      }
      sidebar={<Sidebar route={route} onRoute={go} />}
    >
      {needsSetup && route !== "settings" ? (
        <SetupHint onGo={() => go("settings")} />
      ) : route === "chat" ? (
        page(<ChatSurface />)
      ) : route === "project" ? (
        page(<ProjectDetailPage />)
      ) : route === "artifacts" ? (
        page(<ArtifactFlowPage />)
      ) : route === "works" ? (
        page(<WorksPage />)
      ) : route === "members" ? (
        page(<MembersPage />)
      ) : route === "about" ? (
        page(<AboutPage />)
      ) : route === "harness" ? (
        page(<HarnessManagePage />)
      ) : route === "memory" ? (
        page(<MemoryPage />)
      ) : (
        page(
          <div className="ss-page" style={{ maxWidth: 720 }}>
            <SettingsPanel />
          </div>,
        )
      )}
    </AppShell>
  );
}

function SetupHint({ onGo }: { onGo: () => void }) {
  return (
    <div className="h-full flex items-center justify-center p-6">
      <section
        className="rounded-lg overflow-hidden flex flex-col items-center justify-center"
        style={{
          minHeight: 0,
          background: "var(--surface)",
          border: "1px solid var(--surface-border)",
          maxWidth: 420,
          padding: 32,
        }}
      >
        <div className="flex flex-col items-center gap-3 max-w-md text-center px-6">
          <svg width="40" height="40" viewBox="0 0 64 64">
            <g stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
              <path d="M16 22 L32 14 L48 22 L48 42 L32 50 L16 42 Z" />
              <path d="M32 14 L32 50" />
            </g>
            <circle cx="32" cy="32" r="3.5" fill="var(--brand)" />
          </svg>
          <div style={{ color: "var(--text-1)", letterSpacing: ".04em", fontSize: 15 }}>
            未配置 API Key
          </div>
          <p style={{ color: "var(--text-2)", fontSize: 12, lineHeight: 1.7 }}>
            至少配一个 LLM Provider 的 API Key 才能开始工作。
          </p>
          <button className="ss-button-primary" onClick={onGo} style={{ padding: "8px 16px" }}>
            去设置 →
          </button>
        </div>
      </section>
    </div>
  );
}
