/**
 * 同步 fragment 提取(M2 启发式残留;智能提取属 M3+/批次 5b)
 *
 * 批次 5a.5 T1(docs/CODE-REVIEW-2026-10-01.md §B1):删除「assistant 全文
 * ≥50 字符 → kind:"summary" 原文全存」占位分支 —— 它把每条回复都变成可被
 * LIKE 检索命中的 fragment,注入 prompt 后模型模仿其格式,新回复再被存成
 * summary,形成自我放大的记忆循环(用户真实库已积累 13 条拼接垃圾)。
 * 仅保留 REMEMBER_RE「记住:」触发词 fact 提取;存量 summary 的检索失活见
 * repo/fragments.ts searchFragmentsByText 默认 kinds。
 */
export interface ExtractedFragment {
  kind: "fact" | "preference" | "project" | "context" | "summary";
  content: string;
  importance: number;
}

const REMEMBER_RE = /(?:^|\s)(记住|记住这点|remember this|以后|note that|请记住|记一下)\s*[:：]?\s*(.{5,200})/i;

export function extractFragments(message: {
  role: "user" | "assistant";
  content: string;
}): ExtractedFragment[] {
  const out: ExtractedFragment[] = [];
  const text = (message.content ?? "").trim();
  if (!text) return out;

  // 触发词检测(唯一保留的启发式)
  const m = text.match(REMEMBER_RE);
  if (m && m[2]) {
    out.push({
      kind: "fact",
      content: m[2].trim(),
      importance: 0.8,
    });
  }

  return out;
}
