/**
 * 工件正文**怎么呈现** —— 一个纯函数,前端唯一的一处判据。
 *
 * ── 为什么单独成文件 ────────────────────────────────────────────
 *
 * 这条判据只有一行,但它有两个**容易写反**的分支,而且错了以后的表现是
 * **一片空白**(不是报错):
 *
 *   · 存量交付物(`kind='deliverable'` 且 `deliverable_type IS NULL`,真机 23 条)
 *     的正文是 markdown。**先看 kind 再看类型**;反过来写就是 23 片空白。
 *   · 非交付物工件一定没有类型。类型字段存在不等于它是交付物。
 *
 * 所以它得能被单测钉住 —— 组件里内联一个三元表达式就没人会测它。
 */
import type { ArtifactKind, DeliverableType } from "@shared/types/platform";

/** 正文呈现方式。`text` = 原来的 `<pre>`(markdown / 纯文本)。 */
export type BodyMode = "html_report" | "text";

export function bodyMode(a: {
  readonly kind: ArtifactKind;
  readonly deliverableType: DeliverableType | null;
}): BodyMode {
  if (a.kind !== "deliverable") return "text";
  return a.deliverableType === "html_report" ? "html_report" : "text";
}

/**
 * 下载文件名。取自标题,去掉文件系统不接受的字符。
 *
 * 空标题 / 全是非法字符 → 回落成 `交付-<工件 id>.html`。**不许**把空串交给
 * `<a download="">` —— 那会让浏览器拿 URL 的最后一段当文件名,结果是
 * `artifacts` 之类的东西(下载下来是个看不出是什么的凭据文件)。
 *
 * 带上 id 还解决另一件事:同一项目里两份同名报告不会互相覆盖。
 */
export function htmlReportFileName(title: string, artifactId: string): string {
  const base = title
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return base.length > 0 ? `${base}.html` : `交付-${artifactId}.html`;
}