/**
 * Sansheng · 顶栏(批次 UI U4:品牌区与状态区各合并为一行)
 *
 * 改这一层之前的三个毛病:
 *  1. 品牌区是 `<Seal/> 三生 Sansheng v0.1.0 ● 推演中` —— 五个元素里
 *     「Sansheng」与项目名重复、「v0.1.0」对使用没有导航价值。现在品牌区只剩
 *     印章 + 人格名,版本号进印章的 `title`(想知道版本的人会去看,其余人不必读)。
 *  2. 右侧是一个**悬空的「·」**:它夹在 CostDisplay 和时间点之间,当
 *     currentUsage/totalUsage 都为 0 时(CostDisplay 渲染空)就变成一个
 *     孤零零的间隔号。现在整块收成一个 flex 容器,没有内容就没有分隔符。
 *  3. NavTab 带着 `disabled` / `hint` 两个**从没有调用方传过的** prop ——
 *     留着它们等于宣称「存在一种灰掉的导航项」,删掉更诚实。
 *
 * 状态语义与数据来源完全没动:cost 仍只在真实 > 0 时渲染(不硬编码「本轮 idle」,
 * 见 tests/web/c10-dead-code.test.ts),vec 降级提示仍只在真降级时出现。
 */
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

/** 导航项:声明式单一来源,顺序即视觉顺序。 */
const TABS: ReadonlyArray<{ route: Route; label: string }> = [
  { route: "chat", label: "对话" },
  { route: "agents", label: "Agent" },
  { route: "timeline", label: "总线" },
  { route: "memory", label: "记忆" },
  { route: "artifacts", label: "工件" },
  { route: "goals", label: "目标" },
  { route: "harness", label: "Harness" },
  { route: "settings", label: "设置" },
];

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
      className="flex items-center gap-4 px-5"
      style={{
        borderBottom: "1px solid var(--ink-3)",
        background: "rgba(11,15,20,0.6)",
        backdropFilter: "blur(12px)",
      }}
    >
      <div
        className="flex items-center gap-2.5 flex-none"
        title={config ? `${config.name} v${config.version}` : "Sansheng"}
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

      {/* 右侧运行态:cost(有真数才渲染)+ 服务器时间 + vec 降级。
          整块是一个 flex,任一子项为空时不会留下悬空的分隔号。 */}
      <div className="flex items-center gap-3 flex-none ss-meta">
        <CostDisplay current={currentUsage} total={totalUsage} />
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block rounded-full"
            style={{
              width: 6,
              height: 6,
              background: serverTime !== "—" ? "var(--bamboo)" : "var(--ochre)",
            }}
          />
          <span className="sansheng-text-dim">{serverTime}</span>
        </span>
        {/* 批次 UI U3(4a-OQ5):vec 降级只在这里、且只在真降级时出现一次。
            功能不受影响(碎片检索自动退回 text/importance 排序),所以用 ochre
            而不是 cinnabar —— 是提示不是报错。 */}
        {vecLoaded === false && (
          <span
            className="sansheng-text-ochre"
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
  // 批次 UI U2(C10-2「currentUsage 恒 0,那句本轮空闲提示永现」):currentUsage 现在由
  // message_end 的真实 usage 累加而来,推演中会有真数字。本轮真的没产生任何 token 时
  // **什么都不渲染** —— 旧实现在这里硬编码一句与数据无关的常量文案,是在对用户撒谎。
  // costUsd 只在 agent_end 才拿得到,中途为 0,故 > 0 才渲染金额。
  const live = current.input + current.output;
  const hasTotal = total.input + total.output > 0;
  if (live === 0 && !hasTotal) return null;
  return (
    <span className="flex items-center gap-1.5">
      {live > 0 && (
        <span className="sansheng-text-jade">
          ▸ {current.input + current.output} tok
          {current.costUsd > 0 && ` · $${current.costUsd.toFixed(4)}`}
        </span>
      )}
      {live > 0 && hasTotal && <span>·</span>}
      {hasTotal && (
        <span>
          Σ {total.input + total.output} tok · ${total.costUsd.toFixed(4)}
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
