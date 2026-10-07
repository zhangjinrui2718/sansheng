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
 *   · `code_service`(migration 026)的正文是一份 **markdown 说明**,不是网页
 *     —— 它的「主体」是仓库坐标,渲染在另一个组件里(`CodeService.tsx`)。
 *     把它当 `html_report` 渲染 = 一片空白,而空白看起来像「平台坏了」。
 *
 * 所以它得能被单测钉住 —— 组件里内联一个三元表达式就没人会测它。
 */
import type { ArtifactKind, CodeServiceView, DeliverableType } from "@shared/types/platform";

/**
 * 正文呈现方式。
 *   · `html_report` —— 沙箱 iframe 渲染(HtmlReport.tsx)
 *   · `code_service` —— **正文是 markdown**,主体(仓库坐标)另有组件
 *   · `text` = 原来的 `<pre>`(存量 markdown / 纯文本)
 */
export type BodyMode = "html_report" | "code_service" | "text";

export function bodyMode(a: {
  readonly kind: ArtifactKind;
  readonly deliverableType: DeliverableType | null;
}): BodyMode {
  if (a.kind !== "deliverable") return "text";
  // 未知类型(将来加的)与存量 NULL 都落到 `text` —— 「读不了就按正文读」,
  // 而不是猜一种渲染方式(猜错的表现是空白页)。**先看 kind 再看类型**。
  if (a.deliverableType === "html_report") return "html_report";
  if (a.deliverableType === "code_service") return "code_service";
  return "text";
}

// ── 代码服务的坐标(migration 026)────────────────────────────────
//
// ⚠️ **坐标的解析不在前端。** `metadata_json` → `CodeServiceView` 的翻译在
// 服务端一处收口(`transport/views.ts` 的 `parseCodeServiceView`),理由是
// 列表端点的载荷(单次最多 500 条)不该每条都背一段没人读的原始 JSON,
// 而且「缺项怎么办」只该有一种说法。
//
// 这里只留**纯展示**的两个函数:短 sha 与两条部署命令。它们可测、无副作用,
// 所以放在 `lib/` 里而不是组件里(组件里内联一个三元表达式就没人会测它)。

/** 短 sha(7 位)。读不到就如实返回 null —— 界面上写 `undefined` 是最糟的形态。 */
export function shortSha(sha: string | null): string | null {
  return sha !== null && sha.length >= 7 ? sha.slice(0, 7) : sha;
}

/**
 * 两条可直接复制的命令。
 *
 * **为什么由前端拼**:这两条命令的判据是「甲方能照着跑起来」,而 `service` /
 * `port` / `servicePath` 是交付物自己的事实 —— 让模型在正文里手写一遍,就会有
 * 第三种写法(它可能写错端口)。
 *
 * ⚠️ **构建上下文是 `servicePath`(交付物的边界),不是 `.`。**
 * 2026-10-08 起代码服务复用**项目仓**,`repoPath` 因此是项目根 —— 从那儿
 * `docker build .` 会把 `artifacts/`(内部报告)与 `work/`(中间产物)一起装进
 * 镜像,交付物的边界当场消失(设计 §3.2a / §7:`docker build services/<name>`)。
 * 所以 `service` / `port` / `servicePath` **缺一项就返回 null**(渲染成「读不到」),
 * **不编一个默认值** —— 编出来的 `docker build -t x .` 是一条会跑、但装错东西的命令。
 */
export function dockerCommands(meta: CodeServiceView): { build: string; run: string } | null {
  if (meta.service === null || meta.port === null || meta.servicePath === null) return null;
  return {
    build: `docker build -t ${meta.service} ${meta.servicePath}`,
    run: `docker run --rm -p ${meta.port}:${meta.port} ${meta.service}`,
  };
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