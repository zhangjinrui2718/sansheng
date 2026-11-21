/**
 * Sansheng 品牌 · 三生环(V2,2026-11-21)
 *
 * ── 图形语义 ────────────────────────────────────────────────────
 * 三段弧首尾循环 + 三个节点 = 「三世循环 / 三生万物」——
 * 也是产品里项目版本链的隐喻(收口 → 新版本 → 再迭代,生生不息)。
 * 三段弧不闭合成整圆:节点在缺口处,「运转中」而非「闭合静止」。
 *
 * ── 工程约束 ────────────────────────────────────────────────────
 * · 单色 currentColor(消费处给色;顶栏跟品牌蓝);
 * · 笔画 3.5 / 节点 r4.5 —— 16px favicon 与 32px 顶栏两档都清晰,
 *   不加装饰性细节(小尺寸下会糊);
 * · viewBox 0 0 64 64,与旧 Seal 同尺寸位,替换零位移。
 */
export function Seal({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="三生"
    >
      <g
        stroke="currentColor"
        strokeWidth={3.5}
        strokeLinecap="round"
        fill="none"
      >
        {/* 三段弧:半径 21,节点缺口在顶部/左下/右下(0°/120°/240°) */}
        <path d="M37.79 11.81 A21 21 0 0 1 52.38 37.08" />
        <path d="M46.59 47.11 A21 21 0 0 1 17.41 47.11" />
        <path d="M11.62 37.08 A21 21 0 0 1 26.21 11.81" />
      </g>
      <g fill="currentColor">
        <circle cx="32" cy="11" r="4.5" />
        <circle cx="13.8" cy="42.5" r="4.5" />
        <circle cx="50.2" cy="42.5" r="4.5" />
      </g>
    </svg>
  );
}
