import { useEffect, useState } from "react";
import { TopBar } from "./components/shell/TopBar";
import { HistoryRail } from "./components/shell/HistoryRail";
import { AgentPanel } from "./components/shell/AgentPanel";
import { ChatSurface } from "./components/chat/ChatSurface";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { useSettingsStore } from "./stores/settings";
import { useChatStore } from "./stores/chat";

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

export function App() {
  const [route, setRoute] = useState<"chat" | "settings">("chat");
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [serverTime, setServerTime] = useState<string>("—");
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const settings = useSettingsStore((s) => s.settings);
  const provider = useChatStore((s) => s.provider);
  const modelId = useChatStore((s) => s.modelId);
  const totalUsage = useChatStore((s) => s.totalUsage);
  const currentUsage = useChatStore((s) => s.currentUsage);
  const status = useChatStore((s) => s.status);

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
        })
        .catch(() => setServerTime("—"));
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const needsSetup = !settings?.hasApiKey;

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
      ) : (
        <main
          className="px-6 py-6 overflow-y-auto"
          style={{ background: "var(--ink-0)" }}
        >
          <SettingsPanel />
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
      <div className="flex flex-col items-center gap-4 max-w-md text-center px-6">
        <svg width="56" height="56" viewBox="0 0 64 64">
          <g stroke="#E5484D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <circle cx="32" cy="32" r="18" />
            <path d="M32 22 L32 32 L40 36" />
          </g>
        </svg>
        <div>
          <div className="font-serif text-xl" style={{ color: "var(--bone)", letterSpacing: ".06em" }}>
            看到状态卡住?
          </div>
          <p className="sansheng-text-dim mt-2" style={{ fontSize: 13 }}>
            这通常是旧版本的 session 还卡在后台进程里。点下面的按钮强制重置 kernel:
          </p>
        </div>
        <button
          className="sansheng-button-primary"
          onClick={onReset}
          style={{ padding: "8px 16px" }}
        >
          ↻ 重置 Kernel
        </button>
        <p className="sansheng-text-mute" style={{ fontSize: 11 }}>
          或者重启 <code>sansheng start</code>
        </p>
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
      <div className="flex flex-col items-center gap-4 max-w-md text-center px-6">
        <svg width="56" height="56" viewBox="0 0 64 64">
          <g stroke="#C76B4A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M16 22 L32 14 L48 22 L48 42 L32 50 L16 42 Z" />
            <path d="M32 14 L32 50" />
          </g>
          <circle cx="32" cy="32" r="3.5" fill="#C76B4A" />
        </svg>
        <div>
          <div className="font-serif text-xl" style={{ color: "var(--bone)", letterSpacing: ".06em" }}>
            未配置 API Key
          </div>
          <p className="sansheng-text-dim mt-2" style={{ fontSize: 13 }}>
            Sansheng 需要至少一个 LLM Provider 的 API Key 才能开始工作。
          </p>
        </div>
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