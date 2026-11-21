/**
 * AppShell —— V2 应用外壳:frame + 左栏 + 圆角页卡(设计书 §3.1)
 *
 * 布局语言(参照 Multica 的「页面即卡片」):
 *   · 最外层是 frame(app-shell 底色),顶栏与左栏长在 frame 上;
 *   · 内容区是一张**圆角页卡**(page-canvas 底色 + 发丝边)浮在 frame 上,
 *     层级靠两层底色与亮度阶,不靠阴影;
 *   · 左栏**全路由恒在**(v5 只在对话页出现 —— 项目入口藏二级链接的断裂
 *     由此修掉),可折叠成窄条(只留导航图标)。
 *
 * **移动端**(<880px,CSS 断点):左栏退成滑出式抽屉(默认收起,遮罩点击关闭),
 * 页卡占满全宽;开合钮是左下浮动钮(仅小屏显示)。桌面形态不受影响。
 *
 * 本组件只管布局与开合态,不取数、不认路由内容 —— 那些在 App.tsx。
 */
import { useState } from "react";
import type { ReactNode } from "react";

export function AppShell(props: { topbar: ReactNode; sidebar: ReactNode; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <div className="ss-app-frame">
      {props.topbar}
      <div className="ss-shell-body">
        {mobileOpen && (
          <div
            className="ss-sidebar-scrim"
            role="presentation"
            onClick={() => setMobileOpen(false)}
          />
        )}
        <aside
          className="ss-sidebar"
          data-collapsed={collapsed ? "true" : undefined}
          data-mobile-open={mobileOpen ? "true" : undefined}
          style={{ width: collapsed ? "var(--sidebar-width-collapsed)" : "var(--sidebar-width)" }}
        >
          {props.sidebar}
          <button
            type="button"
            className="ss-sidebar-collapse"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开左栏" : "收起左栏"}
            title={collapsed ? "展开左栏" : "收起左栏(只留导航图标)"}
          >
            {collapsed ? "»" : "«"}
          </button>
        </aside>
        <main className="ss-page-card">{props.children}</main>
      </div>
      {/* 移动端左栏开合钮(仅 <880px 显示,桌面隐藏) */}
      <button
        type="button"
        className="ss-mobile-burger"
        aria-expanded={mobileOpen}
        aria-label={mobileOpen ? "收起导航" : "打开导航"}
        onClick={() => setMobileOpen((v) => !v)}
      >
        {mobileOpen ? "✕" : "☰"}
      </button>
    </div>
  );
}
