/**
 * Sansheng Seal · 品牌方印
 * 自绘 SVG 六向 + 中心点 = 三生
 */
export function Seal({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="三生 Seal"
    >
      <g
        stroke="var(--jade)"
        strokeWidth={size > 24 ? 2.5 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        <path d="M16 22 L32 14 L48 22 L48 42 L32 50 L16 42 Z" />
        <path d="M32 14 L32 50" />
        <path d="M16 22 L48 42" />
        <path d="M48 22 L16 42" />
      </g>
      <circle cx="32" cy="32" r={size > 24 ? 4 : 3} fill="var(--jade)" />
    </svg>
  );
}