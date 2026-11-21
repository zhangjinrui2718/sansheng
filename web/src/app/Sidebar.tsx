/**
 * Sidebar —— V2 左栏:导航块 + 项目列表,全路由恒在(设计书 §3.1)
 *
 * · 导航 4 项:对话 / 项目 / 工件 / 记忆 —— **工件是一等公民**
 *   (2026-11-21 用户裁决:所有交互和展示围绕工件展开,角色与工作项
 *   退到「以工件为交付序列的内部」—— 它们的路由保留作深链过程视图,
 *   但不再占一级导航);设置退为顶栏图标;关于保持顶栏 `?`。
 * · 项目列表 = 原对话页左栏(HistoryRail)原样嵌入:状态分组/会话线二级/
 *   接待入口的判据一个不动(它们的测试继续钉在 HistoryRail 上)。
 * · 折叠态由 AppShell 管(整栏 48px 只留导航图标;项目列表只在展开态可见)。
 * · 导航按钮是**真 button 且走 onRoute**(地址可分享;不用 pushState 手写)。
 */
import type { Route } from "@/app/router";
import { HistoryRail } from "@/components/shell/HistoryRail";

/** 导航项:声明式单一来源,顺序即视觉顺序。「项目」恢复一级(V2)。 */
const TABS: ReadonlyArray<{ route: Route; label: string; icon: React.ReactNode }> = [
  { route: "chat", label: "对话", icon: <IconChat /> },
  { route: "project", label: "项目", icon: <IconDashboard /> },
  { route: "artifacts", label: "工件", icon: <IconLayers /> },
  { route: "memory", label: "记忆", icon: <IconArchive /> },
];

export function Sidebar(props: { route: Route; onRoute: (r: Route) => void }) {
  return (
    <div className="ss-sidebar-inner">
      <nav className="ss-nav" aria-label="主导航">
        {TABS.map((t) => (
          <button
            key={t.route}
            type="button"
            className="ss-nav-item"
            data-active={props.route === t.route ? "true" : undefined}
            onClick={() => props.onRoute(t.route)}
            title={t.label}
          >
            <span className="ss-nav-icon" aria-hidden>
              {t.icon}
            </span>
            <span className="ss-nav-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <div className="ss-sidebar-divider" />
      <div className="ss-sidebar-rail">
        <HistoryRail />
      </div>
    </div>
  );
}

/* —— 线性图标(stroke 2 / 16px,颜色随 currentColor)——
   不引图标库:五个导航位各一枚内联 SVG,零依赖。 */
function Svg({ children }: { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
function IconChat() {
  return (
    <Svg>
      <path d="M2.5 4.5A2 2 0 0 1 4.5 2.5h7a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8l-3 2.5V11.5h-.5a2 2 0 0 1-2-2Z" />
    </Svg>
  );
}
function IconDashboard() {
  return (
    <Svg>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
      <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
    </Svg>
  );
}
function IconArchive() {
  return (
    <Svg>
      <rect x="2.5" y="3" width="11" height="3.5" rx="1" />
      <path d="M3.5 6.5V13a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6.5" />
      <path d="M6.5 9.5h3" />
    </Svg>
  );
}
function IconLayers() {
  return (
    <Svg>
      <path d="M8 2.5 14 6 8 9.5 2 6Z" />
      <path d="m2 9 6 3.5L14 9" />
    </Svg>
  );
}
