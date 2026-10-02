/**
 * Sansheng · 展示层构件(批次 UI U4)
 *
 * 存在的理由只有一个:**让「屏幕上每个字的字号 = 它该有的语义」成为一件有类型的事**。
 * 改这一层之前,`style={{ fontSize: 10 }}` 这类行内样式在 7 个页面里被手抄了两百多次,
 * 结果是同一句话在不同页面有三种灰度,读者分不清哪行是标题、哪行是注解。
 *
 * ── 配套的阅读纪律(这一层真正的价值)──────────────────────────────
 *  1. **注解默认不在屏幕上。** 凡是解释「为什么这么算 / 为什么这个字段没接线」的句子,
 *     以前都是整段贴在页面下方(Agents 页四条、Harness 页三处),现在一律:
 *       - 一句话能说清的 → `title=`(鼠标悬停);
 *       - 需要两三句的 → `<Disclosure>`(点开);
 *       - 纯开发者自述 → 回到本文件 / 页面文件头的注释里。
 *     **反造假纪律没有放松**:数据从哪来、阈值是估算还是实测,仍然要能查到 —— 只是
 *     把它从「必须逐页读」降级为「想知道时点一下」。
 *  2. **正文默认截断。** 长 body 进 `.ss-clamp-*` + `<Disclosure>`,首屏不再被一整段
 *     推走。Agent 角色卡、计划卡、失败原因都适用。
 *  3. **元信息一行化。** kind / status / 角色 / 时间挤在一行,左对齐按重要性排,
 *     次要信息进 `title=`,不再给每张卡挂三行小字。
 *
 * 视觉沿用既有 token(--ink-* / --bone* / --jade / --amber / --cinnabar / --cyan /
 * --bamboo / --ochre),不新增配色、字体、间距体系;UI 标签一律不用 emoji。
 */
import type { CSSProperties, ReactNode } from "react";

/** 语气 = 语义色的有限集合(映射在 globals.css 的 `.ss-pill[data-tone]`)。 */
export type Tone = "bone" | "jade" | "amber" | "cinnabar" | "cyan" | "bamboo" | "mute" | "ochre";

/**
 * 元信息小标签。语气走 `data-tone`(样式在 CSS 里),不用行内 style ——
 * 这是这一层刻意收窄的 API:调用点不该再有 `style={{ color: ... }}`。
 */
export function Pill({
  tone = "bone",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className="ss-pill" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

/**
 * 页面抬头:标题 + 一行 hint(可省略)+ 右侧计数/操作区。
 * hint 是**一行**的短标;要展开解释的整段话放 `hintTitle`,悬停才出现。
 */
export function PageHeader({
  title,
  hint,
  hintTitle,
  aside,
}: {
  title: string;
  hint?: string;
  hintTitle?: string;
  aside?: ReactNode;
}) {
  return (
    <header className="flex items-baseline justify-between gap-3 flex-wrap">
      <div className="flex items-baseline gap-2 min-w-0">
        <h1 className="ss-title">{title}</h1>
        {hint ? (
          <span className="ss-note truncate" title={hintTitle}>
            {hint}
          </span>
        ) : null}
      </div>
      {aside ? <div className="flex items-center gap-2 flex-wrap">{aside}</div> : null}
    </header>
  );
}

/**
 * 分区:标题 + 右侧计数/操作。**不编号** —— 旧页面的「① 意图头 / ② DAG 区」是产品设计
 * 文档的行号,对读页面的人零信息量,现在只留语义名(「计划」「执行」…)。
 */
export function Section({
  title,
  count,
  hint,
  aside,
  children,
  className,
}: {
  title: string;
  count?: number;
  hint?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="flex items-baseline justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-baseline gap-2 min-w-0">
          <h2 className="ss-section">{title}</h2>
          {typeof count === "number" ? <span className="ss-meta">{count}</span> : null}
          {hint ? (
            <span className="ss-note truncate" title={hint}>
              {hint}
            </span>
          ) : null}
        </div>        {aside ? <div className="flex items-center gap-1.5 flex-wrap">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** 空态:一句话 + 可选动作。旧的「这是真实空态,不是没接上」类自述已移进文件注释。 */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="ss-empty">{children}</div>;
}

/**
 * 「点开看细节」容器(原生 <details>)。默认收起,标题是**一个词**级别的动作提示。
 * 用来装:失败原因全文、估算口径说明、id / 依赖等原始字段。
 */
export function Disclosure({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="ss-disclosure" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="ss-note" style={{ paddingTop: 6 }}>
        {children}
      </div>
    </details>
  );
}

/** 左侧色条:一条就说明「这条要人管」(等决策 / 失败),比整块染色安静得多。 */
export function Flag({ tone = "bone", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className="ss-flag" data-tone={tone}>
      {children}
    </div>
  );
}

/** 键值行:左标签右值。用于「提示词 3766 字符 / 读盘注入」这类事实陈述。 */
export function KV({
  label,
  value,
  title,
  children,
}: {
  label: string;
  value?: ReactNode;
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 py-0.5" style={{ fontSize: 11, lineHeight: "18px" }}>
      <span className="ss-meta flex-none" style={{ minWidth: 52 }}>
        {label}
      </span>
      <span className="flex items-center gap-1.5 flex-wrap min-w-0" style={{ color: "var(--bone-dim)" }}>
        {value}
        {children}
      </span>
      {title ? <span className="ss-meta truncate">{title}</span> : null}
    </div>
  );
}

/**
 * 统计条:一串「标签 + 数字」。**所有数字必须来自真实数组的 length**,
 * 调用方负责保证这一点(见各页面的反造假注释),本组件不造数。
 */
export function StatStrip({
  items,
  separator = "·",
}: {
  items: Array<{ label: string; value: ReactNode; tone?: Tone; title?: string }>;
  separator?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap ss-meta">
      {items.map((it, i) => (
        <span key={it.label} className="flex items-center gap-1.5" title={it.title}>
          {i > 0 ? <span>{separator}</span> : null}
          <span>{it.label}</span>
          <span style={{ color: toneColor(it.tone) }}>{it.value}</span>
        </span>
      ))}
    </div>
  );
}

/** 进度条(Goals 页的唯一可视化):高度 3px,右侧跟百分比。 */
export function Progress({ pct, tone = "jade" }: { pct: number; tone?: Tone }) {
  return (
    <div
      style={{ flex: 1, height: 3, background: "var(--ink-3)", borderRadius: 2, overflow: "hidden" }}
    >
      <div style={{ width: `${pct}%`, height: "100%", background: toneColor(tone) }} />
    </div>
  );
}

/** 多行截断容器,配合 `<Disclosure>` 的「展开」使用。 */
export function Clamp({
  lines = 3,
  children,
  style,
}: {
  lines?: 2 | 3 | 4;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className={`ss-body ss-clamp-${lines}`} style={style}>
      {children}
    </div>
  );
}

/** tone → CSS 变量。放在一处,避免每个组件各写一遍 switch。 */
export function toneColor(tone: Tone | undefined): string {
  switch (tone) {
    case "jade":
      return "var(--jade)";
    case "amber":
      return "var(--amber)";
    case "cinnabar":
      return "var(--cinnabar)";
    case "cyan":
      return "var(--cyan)";
    case "bamboo":
      return "var(--bamboo)";
    case "ochre":
      return "var(--ochre)";
    case "mute":
      return "var(--bone-mute)";
    default:
      return "var(--bone-dim)";
  }
}
