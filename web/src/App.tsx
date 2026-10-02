import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { TopBar } from "./components/shell/TopBar";
import { HistoryRail } from "./components/shell/HistoryRail";
import { AgentPanel } from "./components/shell/AgentPanel";
import { ChatSurface } from "./components/chat/ChatSurface";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { AgentsPage } from "./routes/Agents";
import { MemoryPage } from "./routes/Memory";
import { TimelinePage } from "./routes/Timeline";
import { ArtifactsPage } from "./routes/Artifacts";
import { GoalsPage } from "./routes/Goals";
import { HarnessPage } from "./routes/Harness";
import { useSettingsStore, activeProviderOf } from "./stores/settings";
import { useChatStore } from "./stores/chat";
import { initAppSocket } from "./lib/appSocket";

interface RuntimeConfig {
  name: string;
  version: string;
  features: {
    multiAgent: boolean;
    persistence: boolean;
    artifacts: boolean;
    harness: boolean;
    scheduler: boolean;
    chat: boolean;
  };
  kernelReady: boolean;
  conversationId: string;
  personaName: string;
}

/**
 * 路由态(批次 UI U1:工件/目标/Harness 三 tab 从占位变成真页面)。
 * 单一来源 —— TopBar 的 NavTab 与 App 的分支渲染共用这个 union,
 * 避免两处各写一份字面量后悄悄漂移。
 */
export type Route =
  | "chat"
  | "agents"
  | "memory"
  | "timeline"
  | "artifacts"
  | "goals"
  | "harness"
  | "settings";

export function App() {
  const [route, setRoute] = useState<Route>("chat");
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [serverTime, setServerTime] = useState<string>("—");
  // 批次 UI U3:vec 降级态。null = 还没探到(server 未起/网络断),不渲染提示;
  // false = sqlite-vec 真的不可用(碎片检索已退回 text/importance 排序)。
  const [vecLoaded, setVecLoaded] = useState<boolean | null>(null);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const settings = useSettingsStore((s) => s.settings);
  const provider = useChatStore((s) => s.provider);
  const modelId = useChatStore((s) => s.modelId);
  const totalUsage = useChatStore((s) => s.totalUsage);
  const currentUsage = useChatStore((s) => s.currentUsage);
  const status = useChatStore((s) => s.status);
  const conversationId = useChatStore((s) => s.conversationId);

  // F1(A7-2):App 级 socket 单例 —— mount 即连接,生命周期与 App 相同,
  // 路由切换(chat ↔ timeline ↔ …)不再断流;Timeline 的回答/取消按钮经
  // store.attachSocket 走同一实例,不再对 null socket 静默 no-op。
  // initAppSocket 幂等(StrictMode 双 effect 安全);无 cleanup —— 单例常驻。
  useEffect(() => {
    initAppSocket();
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg(null));

    const tick = () =>
      fetch("/api/health")
        .then((r) => r.json())
        .then((d) => {
          const t = new Date(d.ts);
          const hh = String(t.getHours()).padStart(2, "0");
          const mm = String(t.getMinutes()).padStart(2, "0");
          const ss = String(t.getSeconds()).padStart(2, "0");
          setServerTime(`${hh}:${mm}:${ss}`);
          // U3:vecLoaded 只在真降级(false)时置值;老 server 没有这个字段 → undefined
          // → 保持 null 不提示,避免对着旧版本刷无意义的降级噪音。
          if (typeof d.vecLoaded === "boolean") setVecLoaded(d.vecLoaded);
        })
        .catch(() => setServerTime("—"));
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const active = activeProviderOf(settings);
  const needsSetup = !settings || settings.providers.length === 0 || !active?.hasApiKey;

  /**
   * 非对话路由的统一外壳:滚动容器 + <main> 只在这里出现一次。
   * 各路由组件自己只渲染 `<div className="ss-page">` —— 早前每页都自带
   * `<main className="px-4 pb-4">`,于是 DOM 里出现了嵌套 <main>(非法),
   * 而且每页各自管 padding,改一次间距要改七处。
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
        serverTime={serverTime}
        route={route}
        onRoute={setRoute}
        currentUsage={currentUsage}
        totalUsage={totalUsage}
        status={status}
        vecLoaded={vecLoaded}
      />
      {route === "chat" ? (
        <main className="grid grid-cols-app gap-3 px-4 pb-4" style={{ minHeight: 0 }}>
          <HistoryRail />
          {needsSetup ? (
            <SetupHint onGo={() => setRoute("settings")} />
          ) : status === "streaming" && !provider && !modelId ? (
            // 拿到 streaming 状态但 provider/modelId 都是空 → 老 session 卡住。
            // 给一个手动 reset 的逃生口
            <StuckHint onReset={async () => {
              await fetch("/api/kernel/reset", { method: "POST" });
              window.location.reload();
            }} />
          ) : (
            <ChatSurface />
          )}
          <AgentPanel />
        </main>
      ) : route === "agents" ? (
        page(<AgentsPage conversationId={conversationId} />)
      ) : route === "memory" ? (
        page(<MemoryPage />)
      ) : route === "timeline" ? (
        page(<TimelinePage conversationId={conversationId} />)
      ) : route === "artifacts" ? (
        page(<ArtifactsPage conversationId={conversationId} />)
      ) : route === "goals" ? (
        page(<GoalsPage conversationId={conversationId} />)
      ) : route === "harness" ? (
        page(<HarnessPage />)
      ) : (
        <main
          className="overflow-y-auto"
          style={{ background: "var(--ink-0)", minHeight: 0 }}
        >
          <div className="ss-page" style={{ maxWidth: 720 }}>
            <SettingsPanel />
          </div>
        </main>
      )}
    </div>
  );
}

function StuckHint({ onReset }: { onReset: () => void }) {
  return (
    <section
      className="sansheng-card overflow-hidden flex flex-col items-center justify-center"
      style={{ minHeight: 0 }}
    >
      <div className="flex flex-col items-center gap-3 max-w-md text-center px-6">
        <svg width="44" height="44" viewBox="0 0 64 64">
          <g stroke="#E5484D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <circle cx="32" cy="32" r="18" />
            <path d="M32 22 L32 32 L40 36" />
          </g>
        </svg>
        <div className="font-serif text-lg" style={{ color: "var(--bone)", letterSpacing: ".06em" }}>
          内核卡住了
        </div>
        <p className="sansheng-text-dim" style={{ fontSize: 12, lineHeight: 1.7 }}>
          通常是旧版本的会话还挂在后台进程里。强制重置,或重启 <code>sansheng start</code>。
        </p>
        <button
          className="sansheng-button-primary"
          onClick={onReset}
          style={{ padding: "8px 16px" }}
        >
          ↻ 重置 Kernel
        </button>
      </div>
    </section>
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
        <button
          className="sansheng-button-primary"
          onClick={onGo}
          style={{ padding: "8px 16px" }}
        >
          去设置 →
        </button>
      </div>
    </section>
  );
}