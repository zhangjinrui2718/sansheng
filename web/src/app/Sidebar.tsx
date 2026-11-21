/**
 * Sidebar —— V2 左栏:导航块 + 项目列表,全路由恒在(设计书 §3.1)
 *
 * · 导航 5 项:对话 / 项目 / 工作项 / 成员 / 记忆 —— **项目恢复一级**
 *   (v4 把它并进工作台、入口藏在对话页头部链接,V2 修掉这个动线断裂);
 *   设置退为顶栏图标;关于保持顶栏 `?`。
 * · 项目列表 = 原对话页左栏(HistoryRail)原样嵌入:状态分组/会话线二级/
 *   接待入口的判据一个不动(它们的测试继续钉在 HistoryRail 上)。
 * · 折叠态由 AppShell 管(整栏 48px 只留导航图标;项目列表只在展开态可见)。
 * · 导航按钮是**真 button 且走 onRoute**(地址可分享;不用 pushState 手写)。
 */
import type { Route } from "@/app/router";
import { HistoryRail } from "@/components/shell/HistoryRail";

/** 导航项:声明式单一来源,顺序即视觉顺序。「项目」恢复一级(V2)。 */
const TABS: ReadonlyArray<{ route: Route; label: string; icon: JSX.Element }> = [
  { route: "chat", label: "对话", icon: <IconChat /> },
  { route: "project", label: "项目", icon: <IconDashboard /> },
  { route: "works", label: "工作项", icon: <IconGraph /> },
  { route: "members", label: "成员", icon: <IconPeople /> },
  { route: "memory", label: "记忆", icon: <IconLayers /> },
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
function IconGraph() {
  return (
    <Svg>
      <circle cx="3.5" cy="12.5" r="1.8" />
      <circle cx="12.5" cy="3.5" r="1.8" />
      <circle cx="12.5" cy="12.5" r="1.8" />
      <path d="M5 11 11 5M5.3 12.5h5.4M12.5 5.3v5.4" />
    </Svg>
  );
}
function IconPeople() {
  return (
    <Svg>
      <circle cx="6" cy="5.5" r="2.3" />
      <path d="M2.5 13c.6-2.3 1.9-3.4 3.5-3.4s2.9 1.1 3.5 3.4" />
      <path d="M10.5 4a2.2 2.2 0 0 1 0 4.2M11.5 9.8c1.3.4 2.1 1.5 2.5 3.2" />
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
