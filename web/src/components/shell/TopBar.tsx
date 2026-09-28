import { Seal } from "../brand/Seal";

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

interface Props {
  config: RuntimeConfig | null;
  ping: string;
  route: "chat" | "settings";
  onRoute: (r: "chat" | "settings") => void;
  currentUsage: { input: number; output: number; costUsd: number };
  totalUsage: { input: number; output: number; costUsd: number };
  status: "idle" | "streaming" | "error";
}

export function TopBar({
  config,
  ping,
  route,
  onRoute,
  currentUsage,
  totalUsage,
  status,
}: Props) {
  return (
    <header
      className="flex items-center justify-between gap-4 px-5"
      style={{
        borderBottom: "1px solid var(--ink-3)",
        background: "rgba(11,15,20,0.6)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div className="flex items-center gap-3">
        <Seal size={28} />
        <div className="flex items-baseline gap-2">
          <span
            className="font-serif"
            style={{ fontSize: 17, color: "var(--bone)", letterSpacing: "0.04em" }}
          >
            {config?.personaName ?? "三生"}
          </span>
          <span className="sansheng-text-mute" style={{ fontSize: 12 }}>
            Sansheng
          </span>
        </div>
        <span className="sansheng-text-mute" style={{ fontSize: 11, marginLeft: 8 }}>
          v{config?.version ?? "—"}
        </span>
        {status === "streaming" && (
          <span
            className="font-mono sansheng-text-jade animate-pulse-soft"
            style={{ fontSize: 10, marginLeft: 6 }}
          >
            ● 推演中
          </span>
        )}
      </div>

      <nav className="flex items-center gap-1">
        <NavTab label="对话" active={route === "chat"} onClick={() => onRoute("chat")} />
        <NavTab label="Agent" disabled hint="M3" />
        <NavTab label="记忆" disabled hint="M2" />
        <NavTab label="工件" disabled hint="M5" />
        <NavTab label="目标" disabled hint="M7" />
        <NavTab label="Harness" disabled hint="M6" />
        <NavTab label="设置" active={route === "settings"} onClick={() => onRoute("settings")} />
      </nav>

      <div className="flex items-center gap-3">
        <CostDisplay current={currentUsage} total={totalUsage} />
        <span className="sansheng-text-mute" style={{ fontSize: 11 }}>·</span>
        <div
          className="flex items-center gap-2"
          style={{ fontSize: 11, color: "var(--bone-mute)" }}
        >
          <span
            className="inline-block rounded-full"
            style={{
              width: 6,
              height: 6,
              background: ping.includes("ok") ? "var(--bamboo)" : "var(--ochre)",
              boxShadow: "0 0 0 2px var(--jade-soft)",
            }}
          />
          <span className="font-mono">{ping}</span>
        </div>
      </div>
    </header>
  );
}

function CostDisplay({
  current,
  total,
}: {
  current: { input: number; output: number; costUsd: number };
  total: { input: number; output: number; costUsd: number };
}) {
  const live = current.input + current.output;
  return (
    <div className="flex items-center gap-2" style={{ fontSize: 11 }}>
      {live > 0 ? (
        <span className="font-mono sansheng-text-jade">
          ▸ in {current.input}/out {current.output} · ${current.costUsd.toFixed(4)}
        </span>
      ) : (
        <span className="font-mono sansheng-text-mute">idle</span>
      )}
      {total.input + total.output > 0 && (
        <>
          <span className="sansheng-text-mute">·</span>
          <span className="font-mono sansheng-text-mute">
            Σ {total.input + total.output} tok · ${total.costUsd.toFixed(4)}
          </span>
        </>
      )}
    </div>
  );
}

function NavTab({
  label,
  active = false,
  disabled = false,
  hint,
  onClick,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="sansheng-button"
      style={{
        padding: "6px 10px",
        opacity: disabled ? 0.4 : 1,
        background: active ? "var(--ink-2)" : "transparent",
        color: active ? "var(--bone)" : "var(--bone-dim)",
        borderColor: active ? "var(--ink-4)" : "transparent",
      }}
      title={hint ? `${label} · 待 ${hint} 阶段解锁` : label}
    >
      <span style={{ fontSize: 12 }}>{label}</span>
      {hint && (
        <span
          className="font-mono sansheng-text-mute"
          style={{ fontSize: 10, marginLeft: 2 }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}