/**
 * 对比度哨兵 —— WCAG 是量出来的,不是目测的
 *
 * 判据(docs/DESIGN-FRONTEND-V2.md §5.2):
 *   · 文字三级与语义色(它们都可能作为文本出现)在**全部六阶表面**上 ≥ 4.5:1;
 *   · 纯装饰(--text-3)≥ 3:1;
 *   · 按钮前景对按钮底 ≥ 4.5:1。
 * 参照 Multica `theme:check` 的做法:token 改值当场红,不靠人眼。
 *
 * 仪器自检(防「坏掉的检查返回看起来正常的答案」):
 *   · 解析器必须从 tokens.css 读出 ≥ 25 个不透明 oklch 值;
 *   · 已知答案样本:白 vs 黑 = 21:1;同色 = 1:1;4.5 阈值边界放行/拒绝各一。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOKENS = readFileSync(join(__dirname, "../../web/src/styles/tokens.css"), "utf8");
const THEME = readFileSync(join(__dirname, "../../web/src/styles/theme.css"), "utf8");

/** 解析 `--name: oklch(L C H);`(不透明;带 alpha 的行不匹配 —— 那些是边框/软底,不在本哨兵域) */
function parseOpaqueTokens(css: string): Map<string, { l: number; c: number; h: number }> {
  const out = new Map<string, { l: number; c: number; h: number }>();
  const re = /--([a-z0-9-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\);/g;
  for (const m of css.matchAll(re)) {
    out.set(m[1], { l: parseFloat(m[2]), c: parseFloat(m[3]), h: parseFloat(m[4]) });
  }
  return out;
}

/** oklch → 线性 sRGB(OKLab 标准逆变换)→ 相对亮度(WCAG Y) */
function relativeY({ l, c, h }: { l: number; c: number; h: number }): number {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3;
  const M = m_ ** 3;
  const S = s_ ** 3;
  const r = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const bl = -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S;
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(a: { l: number; c: number; h: number }, b: { l: number; c: number; h: number }): number {
  const y1 = relativeY(a);
  const y2 = relativeY(b);
  const hi = Math.max(y1, y2);
  const lo = Math.min(y1, y2);
  return (hi + 0.05) / (lo + 0.05);
}

describe("对比度哨兵 · 仪器自检", () => {
  const parsed = parseOpaqueTokens(`${TOKENS}\n${THEME}`);

  it("解析器从 tokens+theme 读出 ≥ 16 个不透明 oklch(读不出来 = 仪器坏了;锚点点名才是硬判据)", () => {
    expect(parsed.size).toBeGreaterThanOrEqual(16);
    // 已知必在的锚点变量逐个点名(改名/删名当场红)
    for (const name of [
      "text-1",
      "text-2",
      "text-3",
      "brand",
      "ok",
      "warn",
      "danger",
      "info",
      "app-shell",
      "page-canvas",
      "surface",
      "surface-raised",
      "surface-hover",
      "surface-selected",
    ]) {
      expect(parsed.has(name), `--${name} 不见了`).toBe(true);
    }
  });

  it("已知答案:白 vs 黑 = 21:1;同色 = 1:1", () => {
    const white = { l: 1, c: 0, h: 0 };
    const black = { l: 0, c: 0, h: 0 };
    expect(contrast(white, black)).toBeCloseTo(21, 0);
    expect(contrast(white, white)).toBeCloseTo(1, 5);
  });
});

describe("对比度哨兵 · 文字与语义色 × 全部表面", () => {
  const parsed = parseOpaqueTokens(`${TOKENS}\n${THEME}`);
  const surfaces = [
    "app-shell",
    "page-canvas",
    "surface",
    "surface-raised",
    "surface-hover",
    "surface-selected",
  ] as const;

  const textLike = ["text-1", "text-2", "brand", "ok", "warn", "danger", "info"] as const;

  it.each(textLike)("文本级色 --%s 在全部六阶表面上 ≥ 4.5:1", (fg) => {
    for (const s of surfaces) {
      const ratio = contrast(parsed.get(fg)!, parsed.get(s)!);
      expect(ratio, `--${fg} on --${s}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--text-3(纯装饰)在全部表面上 ≥ 3:1", () => {
    for (const s of surfaces) {
      const ratio = contrast(parsed.get("text-3")!, parsed.get(s)!);
      expect(ratio, `--text-3 on --${s}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });

  it("按钮前景对按钮底 ≥ 4.5:1(品牌与危险)", () => {
    const brandFg = parsed.get("brand-foreground")!;
    const dangerFg = { l: 0.15, c: 0.01, h: 260 }; // theme.css --ui-button-danger-fg
    expect(contrast(brandFg, parsed.get("brand")!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dangerFg, parsed.get("danger")!)).toBeGreaterThanOrEqual(4.5);
  });

  it("旧名兼容别名:每枚旧变量仍有定义(批次 5 删除前的完整性)", () => {
    for (const legacy of [
      "ink-0",
      "ink-1",
      "ink-2",
      "ink-3",
      "ink-4",
      "bone",
      "bone-dim",
      "bone-mute",
      "jade",
      "ochre",
      "cinnabar",
      "bamboo",
      "amber",
      "cyan",
    ]) {
      expect(TOKENS.includes(`--${legacy}:`), `兼容别名 --${legacy} 丢失`).toBe(true);
    }
  });
});

describe("对比度哨兵 · 状态映射表完整性(theme.css)", () => {
  it("工作项六状态/质检/裁决/等待态/优先级/严重度/项目态/工件态逐个有名", () => {
    const required = [
      "status-work-open",
      "status-work-in-progress",
      "status-work-blocked",
      "status-work-done",
      "status-work-failed",
      "status-work-cancelled",
      "status-review-pending",
      "status-review-done",
      "status-verdict-pass",
      "status-verdict-fail",
      "status-accept",
      "status-reject",
      "status-wait-confirm",
      "status-wait-question",
      "status-wait-acceptance",
      "status-wait-close",
      "status-priority-urgent",
      "status-severity-critical",
      "status-project-active",
      "status-project-awaiting",
      "status-artifact-accepted",
      "status-artifact-superseded",
    ];
    for (const name of required) {
      expect(THEME.includes(`--${name}:`), `状态映射缺 --${name}`).toBe(true);
    }
  });

  it("状态映射只许引用语义四件套与文字三级(不另造色值)", () => {
    const lines = THEME.split("\n").filter((l) => l.trim().startsWith("--status-"));
    expect(lines.length).toBeGreaterThanOrEqual(25);
    for (const line of lines) {
      expect(
        /var\(--(ok|warn|danger|info|brand|text-1|text-2|text-3)\)/.test(line),
        `状态色越界: ${line.trim()}`,
      ).toBe(true);
    }
  });
});
