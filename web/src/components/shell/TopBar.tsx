/**
 * Sansheng · 顶栏(V2 状态条)
 *
 * ── V2 改了什么 ────────────────────────────────────────────────
 * 导航(5 页签)挪进左栏 Sidebar(app/Sidebar.tsx),顶栏只留**运行态**:
 * 身份(Seal+名字)· 成本 · 连接 · 模型,右侧两个图标入口(设置 / ?)。
 * ? 仍在顶栏末尾(它是一份说明书,不与工作区抢位置);设置从页签退为图标
 * (低频配置不占一级导航)。
 *
 * ── 保留的纪律 ────────────────────────────────────────────────
 * · 右侧不再有「服务器时间」:新契约 HealthResponse 里没有 ts,编一个本地
 *   时间是撒谎 —— 只显示真实存在的字段(连接状态 + 当前模型)。
 * · cost 只在有真数时渲染(恒 0 时不写常量文案,C10 哨兵钉着)。
 */
import { Seal } from "../brand/Seal";
import type { Route } from "@/app/router";
import type { AppConfigResponse, HealthResponse } from "@shared/types/platform";

interface Props {
  config: AppConfigResponse | null;
  health: HealthResponse | null;
  route: Route;
  onRoute: (r: Route) => void;
  currentUsage: { input: number; output: number };
  totalUsage: { input: number; output: number };
  status: "idle" | "streaming" | "error" | "connecting";
}

export function TopBar({
  config,
  health,
  route,
  onRoute,
  currentUsage,
  totalUsage,
  status,
}: Props) {
  const connected = health?.ok === true;
  return (
    <header className="ss-topbar">
      <div
        className="flex items-center gap-2.5 flex-none"
        title={config ? `工作目录 ${config.cwd}` : "Sansheng"}
      >
        <Seal size={24} />
        <span style={{ fontSize: 13, color: "var(--text-1)", letterSpacing: "0.04em" }}>
          {config?.personaName ?? "三生"}
        </span>
        {status === "streaming" && (
          <span className="ss-pulse" aria-label="推演中" style={{ color: "var(--brand)", fontSize: 10 }}>
            ●
          </span>
        )}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-3 flex-none ss-meta">
        <CostDisplay current={currentUsage} total={totalUsage} />
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block rounded-full"
            style={{
              width: 6,
              height: 6,
              background: connected ? "var(--ok)" : "var(--warn)",
            }}
          />
          <span
            style={{ color: "var(--text-2)" }}
            title={
              health
                ? `cwd ${health.cwd} · 数据目录 ${health.dataDir} · provider ${health.provider ?? "未配置"}`
                : "还没探到 /api/health"
            }
          >
            {health ? (health.modelId ?? "未配模型") : "未连接"}
          </span>
        </span>
        {/* 设置:低频配置,从页签退为顶栏图标(V2)。当前页高亮提示落点。 */}
        <button
          type="button"
          className="ss-topbar-icon"
          data-active={route === "settings" ? "true" : undefined}
          onClick={() => onRoute("settings")}
          title="设置"
          aria-label="设置"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="8" cy="8" r="2.2" />
            <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
          </svg>
        </button>
        {/* 关于:说明书不占导航位 —— 顶栏末尾的 ?。 */}
        <button
          type="button"
          className="ss-topbar-icon"
          data-active={route === "about" ? "true" : undefined}
          onClick={() => onRoute("about")}
          title="关于"
          aria-label="关于"
        >
          ?
        </button>
      </div>
    </header>
  );
}

function CostDisplay({
  current,
  total,
}: {
  current: { input: number; output: number };
  total: { input: number; output: number };
}) {
  // 本轮真的没产生任何 token 时**什么都不渲染** —— 不写一句与数据无关的常量文案。
  const live = current.input + current.output;
  const hasTotal = total.input + total.output > 0;
  if (live === 0 && !hasTotal) return null;
  return (
    <span className="flex items-center gap-1.5">
      {live > 0 && (
        <span style={{ color: "var(--brand)" }}>
          ▸ {current.input + current.output} tok
        </span>
      )}
      {hasTotal && (
        <span title="本次连接以来的合计;权威值在项目页成本段">
          Σ {total.input + total.output} tok
        </span>
      )}
    </span>
  );
}
