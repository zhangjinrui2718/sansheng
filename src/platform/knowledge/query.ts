/**
 * 知识语料 · 检索表达式(纯函数)
 *
 * 查询侧与索引侧**必须用同一套切法**(`shared/text.ts`),否则中文静默漏召回 ——
 * 索引里存的是 bigram 列,查询切不出同一个 bigram 就永远匹配不上,
 * 而它在英文语料上完全正常。
 */
import { tokenize } from "../../shared/text.js";

/**
 * 把用户/模型给的查询串翻成 FTS5 的 MATCH 表达式。
 *
 * - 无有效词(空串、纯标点、单个 ASCII 字母)⇒ `null`,调用方**如实说"查询词太短"**,
 *   不要退化成一个"取最近 N 条"的假检索(那会把"没搜到"和"库里没有"混成同一件事)。
 * - 每个词都**加双引号**当短语:词只可能来自 `tokenize()`(CJK 与 ASCII 词字符),
 *   引号是纵深防御 —— FTS5 的 `-` / `*` / `:` / `NEAR` 都是语法,模型给什么都不能
 *   让一次检索变成一次语法错误。
 */
export function buildMatchQuery(query: string): string | null {
  const terms = tokenize(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * **展示用**摘录:折叠空白 + 截断。
 *
 * ⚠️ 它只用于给人/模型看的摘要 —— **绝不可以**用它去算偏移或与哈希比对
 * (它改了字符)。切片只有一条路:`materializeChunk`。
 */
export function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}
