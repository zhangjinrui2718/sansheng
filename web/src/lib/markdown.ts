/**
 * 会话正文的 markdown 渲染(业务经理 / 项目经理的输出是 markdown,不是纯文本)
 *
 * ── 为什么是 micromark,不是 react-markdown ────────────────────────
 *
 * 2026-10-04 实测(esbuild --bundle --minify --format=esm,base = react +
 * react-dom/server = 77,985 B raw / 24,779 B gzip):
 *
 *   react-markdown + remark-gfm        +158,145 raw / +47,579 gzip
 *   marked + dompurify                 + 69,226 raw / +23,159 gzip
 *   marked(不 sanitize)                + 38,686 raw / +11,675 gzip  ← 不安全,不合格
 *   markdown-it + task-lists           +151,077 raw / +52,781 gzip
 *   micromark + micromark-extension-gfm + 75,352 raw / +21,220 gzip ← 选它
 *
 * 判据是「能渲染 GFM 表格/任务列表/自动链接 + 能安全吃未闭合的流式输入」下**最轻的**。
 * micromark 比 marked 方案 raw 多 6.1 kB、gzip 反而少 1.9 kB,真正的决定性差别是
 * **默认安全**:micromark 的 HTML 编译器默认 `allowDangerousHtml: false`,
 * 裸 HTML 一律转义、`javascript:` / `data:` / `vbscript:` 链接一律降级成 `href=""`
 * (本文件下方的测试逐条断言)。marked 默认把 `<script>` 原样吐出来、
 * 保留 `javascript:` href,sanitize 是**外加**的一道过滤器 —— 少写一次就是 XSS。
 *
 * ⚠️ 因此下面的 `dangerouslySetInnerHTML` 之所以安全,靠的是**编译器结构上不产生
 * 危险 HTML**,不是靠事后过滤。改动解析配置(尤其是加 `allowDangerousHtml`)之前
 * 先回来读这一段。
 *
 * ── 未闭合表格:流式期间掐掉最后一行 ──────────────────────────────
 *
 * 实测(见 tests/web/markdown.test.ts):未闭合的 ``` / **加粗 / `行内代码 /
 * [链接](http://x 四类,gfm 与 micromark 都不抛异常、优雅降级成字面量 —— 唯一
 * 有瑕疵的是**表格**。GFM 会把「列数不足的行」补齐到表头列数:
 *
 *   | 列A | 列B |            <table>
 *   | --- | --- |              <thead><tr><th>列A</th><th>列B</th></tr></thead>
 *   | 1   | 2   |              <tbody>
 *   | 后续文字 |                 <tr><td>1</td><td>2</td></tr>
 *                                <tr><td>后续文字</td><td></td></tr>  ← 幽灵空格
 *
 * 这不是解析器 bug,是 GFM 的表格语义(补齐)。真正的产品缺陷只发生在**流式**:
 * 一行还没写完时,用户会看到一个之后才被填上的空单元格。所以处置是
 * 「流式期间,若正文最后一行是没换行结尾的表格行,先把那一行掐掉不渲染」
 * (见 `holdBackIncompleteTableRow`);`streaming === false` 时原样渲染 ——
 * 那时行已写完,补齐是 GFM 的正常语义,不该由我们偷偷改写模型写下的内容。
 */

import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

const EXTENSIONS = [gfm()];
const HTML_EXTENSIONS = [gfmHtml()];

/**
 * 渲染一行 —— 表格行 = 允许 ≤3 个空格缩进后跟 `|`(GFM 的表格行形式)。
 *
 * 只管「以 `|` 开头」这一种形式(模型写表格几乎都是这种)。省略前导管道的
 * `a | b` 形式**不在判据内**:那种情况下流式期间最多是「晚一拍出现」,
 * 不会写错内容,而判据放宽成「含 `|`」会把普通正文里的竖线也算进去。
 */
const TABLE_ROW_LINE = /^[ \t]{0,3}\|/;

/**
 * 流式时**掐掉未写完的最后一行表格行**(纯函数,可单测)。
 *
 * 判据两条同时成立才掐:
 *   ① 正文**没有以换行结尾** —— 最后一行还在写,列数未知;
 *   ② 最后一行是表格行(≤3 空格缩进 + `|`)。
 *
 * 只掐最后一行、且只在 streaming 时调用;非流式输入**原样返回**(见文件头)。
 */
export function holdBackIncompleteTableRow(text: string): string {
  if (text.length === 0 || text.endsWith("\n")) return text;
  const lastBreak = text.lastIndexOf("\n");
  const lastLine = text.slice(lastBreak + 1);
  if (!TABLE_ROW_LINE.test(lastLine)) return text;
  return text.slice(0, lastBreak + 1);
}

/**
 * markdown → 安全的 HTML 字符串。
 *
 * `streaming` 为真时先做表格行掐尾(见 `holdBackIncompleteTableRow`),
 * 再整体重解析 —— micromark 是无状态解析器,每次调用都要重新解析全文。
 */
export function markdownToHtml(text: string, streaming = false): string {
  const source = streaming ? holdBackIncompleteTableRow(text) : text;
  if (source.length === 0) return "";
  return micromark(source, {
    extensions: EXTENSIONS,
    htmlExtensions: HTML_EXTENSIONS,
  });
}
