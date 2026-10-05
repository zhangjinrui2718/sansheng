/**
 * Sansheng · 顶栏
 *
 * ── 相对旧版改了什么 ────────────────────────────────────────────
 *
 *  1. **导航项换成新模型**:旧的是「对话 / Agent / 总线 / 记忆 / 工件 / 目标 /
 *     Harness / 设置」—— 「总线」在新架构里已删除,「目标」是 M7 的未实现投影
 *     (计划概念已删),「Agent」现在是项目成员。新的见 `TABS`。
 *     ⚠️ **「工件」页签已删除**:它并入「工作项」(推进图上本来就同时画着工作项与
 *     工件,点绿色条 ⇒ 下面显示它挂着的工件)—— 所以导航里没有工件这一项。
 *  2. **右侧运行态不再有「服务器时间」**:它读的是旧 `/api/health` 的 `d.ts`,
 *     而新契约的 `HealthResponse` 里**没有 `ts`**,也没有 `vecLoaded`
 *     (`ok/version/modelId/provider/cwd/dataDir`)。继续显示一个本地编造的时间
 *     就是撒谎,所以改成显示**真实存在的字段**:连接状态 + 当前模型。
 *  3. cost 仍只在有真数时渲染(不硬编码「本轮 idle」)。
 */
import { Seal } from "../brand/Seal";
import type { Route } from "../../App";
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

/** 导航项:声明式单一来源,顺序即视觉顺序。 */
const TABS: ReadonlyArray<{ route: Route; label: string }> = [
  { route: "chat", label: "对话" },
  { route: "project", label: "项目" },
  { route: "works", label: "工作项" },
  { route: "inbox", label: "待办" },
  { route: "members", label: "成员" },
  { route: "memory", label: "记忆" },
  { route: "harness", label: "Harness" },
  { route: "settings", label: "设置" },
];

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
    <header
      className="flex items-center gap-4 px-5"
      style={{
        borderBottom: "1px solid var(--ink-3)",
        background: "rgba(11,15,20,0.6)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div
        className="flex items-center gap-2.5 flex-none"
        title={config ? `工作目录 ${config.cwd}` : "Sansheng"}
      >
        <Seal size={26} />
        <span className="font-serif" style={{ fontSize: 16, color: "var(--bone)", letterSpacing: "0.05em" }}>
          {config?.personaName ?? "三生"}
        </span>
        {status === "streaming" && (
          <span className="font-mono sansheng-text-jade animate-pulse-soft" style={{ fontSize: 10 }}>
            ●
          </span>
        )}
      </div>

      <nav className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto justify-center">
        {TABS.map((t) => (
          <NavTab
            key={t.route}
            label={t.label}
            active={route === t.route}
            onClick={() => onRoute(t.route)}
          />
        ))}
      </nav>

      <div className="flex items-center gap-3 flex-none ss-meta">
        <CostDisplay current={currentUsage} total={totalUsage} />
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block rounded-full"
            style={{
              width: 6,
              height: 6,
              background: connected ? "var(--bamboo)" : "var(--ochre)",
            }}
          />
          <span
            className="sansheng-text-dim"
            title={
              health
                ? `cwd ${health.cwd} · 数据目录 ${health.dataDir} · provider ${health.provider ?? "未配置"}`
                : "还没探到 /api/health"
            }
          >
            {health ? (health.modelId ?? "未配模型") : "未连接"}
          </span>
        </span>
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
        <span className="sansheng-text-jade">
          ▸ {current.input + current.output} tok
        </span>
      )}
      {live > 0 && hasTotal && <span>·</span>}
      {hasTotal && (
        <span>
          Σ {total.input + total.output} tok
        </span>
      )}
    </span>
  );
}

function NavTab({ label, active = false, onClick }: { label: string; active?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="sansheng-button flex-none"
      style={{
        padding: "5px 9px",
        background: active ? "var(--ink-2)" : "transparent",
        color: active ? "var(--bone)" : "var(--bone-dim)",
        borderColor: active ? "var(--ink-4)" : "transparent",
      }}
      title={label}
    >
      <span style={{ fontSize: 12 }}>{label}</span>
    </button>
  );
}
