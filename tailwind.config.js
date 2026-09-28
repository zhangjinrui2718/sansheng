/**
 * Sansheng · 水墨青玄 design tokens
 * 深墨底 + 浅米白 + 青玄 + 赭 + 朱砂
 * @type {import("tailwindcss").Config}
 */
export default {
  content: [
    "./web/index.html",
    "./web/src/**/*.{ts,tsx,js,jsx,html}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // —— Surface ——
        ink: {
          0: "#0B0F14",
          1: "#0F141B",
          2: "#151C24",
          3: "#1C2530",
          4: "#26303D",
        },
        // —— Text ——
        bone: {
          DEFAULT: "#E8E4D9",
          dim: "#B7AE9D",
          mute: "#7E776B",
        },
        // —— Accent: 青玄 (jade) ——
        jade: {
          50: "#E6F0EC",
          100: "#C2DCD2",
          200: "#9BC4B5",
          300: "#74AC97",
          400: "#5E8B7E",
          500: "#46705F",
          600: "#33564A",
          700: "#223C36",
        },
        // —— Secondary: 赭 (ochre) ——
        ochre: {
          DEFAULT: "#C76B4A",
          soft: "#A85636",
        },
        // —— Destructive: 朱砂 (cinnabar) ——
        cinnabar: {
          DEFAULT: "#E5484D",
          soft: "#B8383C",
        },
        bamboo: "#7BA876",
        amber: "#D49A3A",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "system-ui",
          "sans-serif",
        ],
        serif: [
          "Source Han Serif SC",
          "Noto Serif SC",
          "Songti SC",
          "STSong",
          "SimSun",
          "serif",
        ],
        mono: [
          "JetBrains Mono",
          "Berkeley Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      spacing: {
        0.5: "2px",
        1: "4px",
        1.5: "6px",
        2: "8px",
        2.5: "10px",
        3: "12px",
        4: "16px",
        5: "20px",
        6: "24px",
        7: "28px",
        8: "32px",
        10: "40px",
        12: "48px",
        16: "64px",
        20: "80px",
        24: "96px",
      },
      borderRadius: {
        none: "0",
        sm: "4px",
        DEFAULT: "6px",
        md: "8px",
        lg: "10px",
        xl: "14px",
        full: "9999px",
      },
      boxShadow: {
        "ink-sm": "0 1px 2px rgba(11, 15, 20, 0.5)",
        "ink": "0 2px 8px rgba(11, 15, 20, 0.55), 0 1px 2px rgba(11, 15, 20, 0.4)",
        "ink-lg": "0 8px 24px rgba(11, 15, 20, 0.6), 0 2px 4px rgba(11, 15, 20, 0.45)",
        "jade-glow": "0 0 0 3px rgba(94, 139, 126, 0.18)",
        "cinnabar-glow": "0 0 0 3px rgba(229, 72, 77, 0.18)",
      },
      transitionDuration: {
        DEFAULT: "160ms",
        120: "120ms",
        160: "160ms",
        200: "200ms",
        240: "240ms",
        320: "320ms",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        "caret": {
          "0%, 100%": { opacity: "0" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms ease-out",
        "slide-up": "slide-up 200ms ease-out",
        "pulse-soft": "pulse-soft 1.4s ease-in-out infinite",
        "caret": "caret 1s steps(2, end) infinite",
      },
    },
  },
  plugins: [],
};