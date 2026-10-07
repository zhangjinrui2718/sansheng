/**
 * 跨模块共用的**文本切分**。
 *
 * ── 为什么抽到 shared ─────────────────────────────────────────────
 *
 * 两处需要同一套切法,而且**必须是同一套**:
 *
 *   - 记忆检索(`memory/sqliteMemory.ts` 的 `recall`):中文按 bigram、英文按整词;
 *   - 知识语料(`knowledge/**`):索引列 `seg` 的切法与查询侧**必须逐字一致**,
 *     否则「索引里有的词查询切不出来」——那是一种只在中文上出现的静默漏召回
 *     (英文整词切法一致,中文 bigram 差一个字就全军覆没)。
 *
 * 两处各写一份 = 同一个事实的两种写法,迟早漂。所以这里只放**不含任何存储/IO 的纯函数**。
 *
 * ── 中文为什么按 bigram ───────────────────────────────────────────
 *
 * 旧系统的正则分词是「贪婪整段」,而注释自称按字拆 —— 于是「我叫什么名字」
 * 永远召不回「用户名字:小明」(8-D 审计项 M2)。中文没有空格,按词切需要分词器;
 * 按 **bigram**(相邻两字滑窗)切不需要任何词典,且召回率够用。
 */

/**
 * 把**查询串**切成检索词。中文(含日韩等 CJK 统一表意文字)走 bigram;ASCII 连续串走整词。
 * 两类混排时各切各的 —— 「用户的 TypeScript 偏好」会得到
 * `[用户, 户的, TypeScript, 偏好]`。
 *
 * ⚠️ 返回的是**去重后**的词(OR 语义下重复无意义)。索引侧不要用它,
 * 用 {@link indexTerms} —— 那里保留重复,因为 FTS5 的 bm25 会把词频算进分数。
 */
export function tokenize(query: string): string[] {
  const terms = new Set<string>();
  const s = query.trim();
  if (s === "") return [];

  // ASCII 词(长度 ≥2,避免 a/the 这类噪音)
  for (const w of s.match(/[A-Za-z0-9_]{2,}/g) ?? []) terms.add(w.toLowerCase());

  // CJK bigram:只对连续 CJK 段滑窗,不跨标点/空格
  for (const seg of s.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g) ?? []) {
    if (seg.length === 1) { terms.add(seg); continue; }
    for (let i = 0; i + 1 < seg.length; i++) terms.add(seg.slice(i, i + 2));
  }
  return [...terms];
}

/**
 * 把**正文**切成索引词列(空格连接),供 FTS5 的 `seg` 列使用。
 *
 * 与 {@link tokenize} 的两处刻意差别:
 *   - **保留重复**:bm25 要用词频;去重会把「反复强调的那句话」压成与一次性提到的一样重。
 *   - **不 trim 语义**:入参就是一段正文,前后空白不影响。
 *
 * ⚠️ 查询侧与索引侧都必须用这一族函数。单写一份 `replace(/[，。]/g,"")` 之类的
 * 「差不多」的切法,会让中文检索**静默漏召回**(索引里有词、查询切不出来),
 * 而它在英文语料上完全正常 —— 最难发现的那种。
 */
export function indexTerms(text: string): string {
  const terms: string[] = [];

  for (const w of text.match(/[A-Za-z0-9_]{2,}/g) ?? []) terms.push(w.toLowerCase());

  for (const seg of text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g) ?? []) {
    if (seg.length === 1) { terms.push(seg); continue; }
    for (let i = 0; i + 1 < seg.length; i++) terms.push(seg.slice(i, i + 2));
  }

  return terms.join(" ");
}
