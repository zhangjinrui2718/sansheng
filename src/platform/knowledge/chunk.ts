/**
 * 知识语料 · 切块(纯函数)
 *
 * ── 一条硬约束:切块**不许改写原文** ──────────────────────────────
 *
 * 每个块都带 `offset` / `length`,指向**来源正文**里的字符区间。引用(`knowledge_read`)
 * 靠这个区间把原文切片还给模型。所以这里只能"挑区间",不能 trim / 折叠空白 /
 * 替换标点 —— 一旦改了字,偏移就与正文对不上,而**对不上的偏移会读出看起来正常的错内容**
 * (那是最坏的一种:不是空,是错)。
 *
 * 允许做的只有一件事:跳过**纯空白**的块(它没有任何检索价值)。
 * `tests/platform/knowledge.test.ts` 有一条不变量钉住它:
 * 「把所有块的文本拼起来、去掉空白,必须等于原文去掉空白」—— 不丢字、不串位。
 *
 * ── 为什么按空行切、再按上限兜底 ──────────────────────────────────
 *
 * 工件正文是 markdown / html(段落结构明显),消息正文是自然段。
 * 按空行切 → 段落是天然的语义单元;块太大(单段落超长)再按句末标点切、
 * 最后才硬切。`CHUNK_MAX` 是**注入提示词的预算上界**(RAG 会把正文塞进上下文,
 * 真机有过单回合 109k token 撞墙钟的事故),不是数据库的列宽。
 */

/** 单块硬上限(字符)。超过就必须切开 —— 它是**提示词预算**,不是存储限制。 */
export const CHUNK_MAX = 1200;
/** 单块软目标:攒到这个长度就收一块,避免出现一堆 100 字的碎块。 */
export const CHUNK_TARGET = 800;

export interface TextChunk {
  readonly seq: number;
  /** 在**来源正文**里的字符起点 */
  readonly offset: number;
  /** 字符长度(`> 0`) */
  readonly length: number;
  /** `源文本.slice(offset, offset + length)` —— 冗余存一份,省得每个调用方各切一次 */
  readonly text: string;
}

interface Span {
  start: number;
  end: number;
}

/** 按空行切段,并去掉每段两端的空白(**只调区间,不动字符**)。 */
function blockSpans(text: string): Span[] {
  const spans: Span[] = [];
  const re = /\n[ \t]*\n/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  const push = (start: number, end: number): void => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s] ?? "")) s++;
    while (e > s && /\s/.test(text[e - 1] ?? "")) e--;
    if (e > s) spans.push({ start: s, end: e });
  };
  while ((m = re.exec(text)) !== null) {
    push(cursor, m.index);
    cursor = re.lastIndex;
  }
  push(cursor, text.length);
  return spans;
}

/** 句末标点/换行 —— 超长段的优先切口(切口落在这里,摘要读起来才像一句完整的话)。 */
const SENTENCE_BREAK = new Set(["\n", "。", "!", "！", "?", "？", ";", "；"]);

/** 单个超长段的兜底切分:优先在句末标点后切,实在没有就硬切。 */
function splitLongSpan(text: string, span: Span, max: number): Span[] {
  const out: Span[] = [];
  let start = span.start;
  while (span.end - start > max) {
    const hardEnd = start + max;
    // 在 [start + max/2, hardEnd) 里找**最后一个**句末标点,让切口落在语义边界上
    let cut = -1;
    for (let i = hardEnd - 1; i > start + Math.floor(max / 2); i--) {
      if (SENTENCE_BREAK.has(text[i] ?? "")) { cut = i + 1; break; }
    }
    const end = cut > start ? cut : hardEnd;
    out.push({ start, end });
    start = end;
  }
  if (span.end > start) out.push({ start, end: span.end });
  return out;
}

/**
 * 把正文切成块。返回的 `seq` 从 0 连续递增(它就是 upsert 的另一半锚点)。
 *
 * 空文本 ⇒ 空数组(调用方据此**删除**该来源的旧块,而不是留下幽灵块)。
 */
export function chunkText(
  text: string,
  opts: { readonly max?: number; readonly target?: number } = {},
): TextChunk[] {
  const max = opts.max ?? CHUNK_MAX;
  const target = opts.target ?? CHUNK_TARGET;
  if (text.trim() === "") return [];

  const blocks = blockSpans(text);
  const packed: Span[] = [];
  let cur: Span | null = null;

  for (const b of blocks) {
    const len = b.end - b.start;
    if (len > max) {
      if (cur !== null) { packed.push(cur); cur = null; }
      for (const piece of splitLongSpan(text, b, max)) packed.push(piece);
      continue;
    }
    if (cur === null) { cur = { start: b.start, end: b.end }; continue; }
    const curLen = cur.end - cur.start;
    // 与上一块之间的空白(空行)一起进当前块:偏移仍然指向原文,重新切片不会丢字
    const merged = b.end - cur.start;
    if (curLen < target && merged <= max) cur.end = b.end;
    else { packed.push(cur); cur = { start: b.start, end: b.end }; }
  }
  if (cur !== null) packed.push(cur);

  return packed.map((s, i) => ({
    seq: i,
    offset: s.start,
    length: s.end - s.start,
    text: text.slice(s.start, s.end),
  }));
}

/**
 * HTML → 纯文本(工件正文可能是 `html_report`)。
 *
 * ⚠️ 这是**近似**:不做完整解析,只把标签/脚本/样式摘掉、把常见实体还原。
 * 判据是"检索到的片段读起来像人话",不是"渲染一致" —— 渲染面在
 * `web/src/components/deliverable/HtmlReport.tsx`(sandbox iframe),与这里无关。
 *
 * 它是确定性的:同一份文件转换结果永远相同 ⇒ 引用用的 `offset` 与再次读取时算出来的
 * 区间一致(否则 `knowledge_read` 会读出错位的切片)。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|ul|ol|table|blockquote)>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 按扩展名判断要不要走 {@link htmlToText}(与 `artifactBodyExtension` 同一判据)。 */
export function isHtmlBodyPath(path: string): boolean {
  return path.toLowerCase().endsWith(".html");
}
