import { Seal } from "../brand/Seal";
import type { Route } from "../../App";

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
  serverTime: string;
  route: Route;
  onRoute: (r: Route) => void;
  currentUsage: { input: number; output: number; costUsd: number };
  totalUsage: { input: number; output: number; costUsd: number };
  status: "idle" | "streaming" | "error" | "connecting";
  /**
   * 批次 UI U3:null = 未知(旧 server 无此字段 / 还没探到)→ 不渲染;
   * false = sqlite-vec 真不可用 → 在状态栏显示降级提示。
   * 只在真降级时出现,常态(向量可用)是零噪音。
   */
  vecLoaded: boolean | null;
}

export function TopBar({
  config,
  serverTime,
  route,
  onRoute,
  currentUsage,
  totalUsage,
  status,
  vecLoaded,
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
        <NavTab label="Agent" active={route === "agents"} onClick={() => onRoute("agents")} />
        <NavTab label="总线" active={route === "timeline"} onClick={() => onRoute("timeline")} />
        <NavTab label="记忆" active={route === "memory"} onClick={() => onRoute("memory")} />
        <NavTab label="工件" active={route === "artifacts"} onClick={() => onRoute("artifacts")} />
        <NavTab label="目标" active={route === "goals"} onClick={() => onRoute("goals")} />
        <NavTab label="Harness" active={route === "harness"} onClick={() => onRoute("harness")} />
        <NavTab label="设置" active={route === "settings"} onClick={() => onRoute("settings")} />
      </nav>

      <div className="flex items-center gap-3">
        <CostDisplay current={currentUsage} total={totalUsage} />
        <span className="sansheng-text-mute" style={{ fontSize: 11 }}>·</span>
        <div className="flex items-center gap-2" style={{ fontSize: 11 }}>
          <span
            className="inline-block rounded-full"
            style={{
              width: 6,
              height: 6,
              background: serverTime !== "—" ? "var(--bamboo)" : "var(--ochre)",
              boxShadow: "0 0 0 2px var(--jade-soft)",
            }}
          />
          <span className="font-mono sansheng-text-dim">{serverTime}</span>
        </div>
        {/* 批次 UI U3(4a-OQ5):vec 降级只在这里、且只在真降级时出现一次。
            功能不受影响(碎片检索自动退回 text/importance 排序),所以用 ochre
            而不是 cinnabar —— 是提示不是报错。 */}
        {vecLoaded === false && (
          <span
            className="font-mono sansheng-text-ochre"
            style={{ fontSize: 10 }}
            title="sqlite-vec 不可用:记忆检索已降级为 text/importance 排序(功能不受影响)。"
          >
            ⌁ vec 降级
          </span>
        )}
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
  const hasTotal = total.input + total.output > 0;
  return (
    <div className="flex items-center gap-2" style={{ fontSize: 11 }}>
      {/* 批次 UI U2(C10-2「currentUsage 恒 0,那句本轮空闲提示永现」):
          currentUsage 现在由 message_end 的真实 usage 累加而来(见 stores/chat.ts),
          推演中会有真数字。本轮真的没产生任何 token 时**什么都不渲染** ——
          旧实现在这里硬编码一句与数据无关的常量文案,是在对用户撒谎。
          costUsd 只在 agent_end 才拿得到,中途为 0,故 > 0 才渲染金额。 */}
      {live > 0 && (
        <span className="font-mono sansheng-text-jade">
          ▸ in {current.input}/out {current.output}
          {current.costUsd > 0 && ` · $${current.costUsd.toFixed(4)}`}
        </span>
      )}
      {live > 0 && hasTotal && <span className="sansheng-text-mute">·</span>}
      {hasTotal && (
        <span className="font-mono sansheng-text-mute">
          Σ {total.input + total.output} tok · ${total.costUsd.toFixed(4)}
        </span>
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