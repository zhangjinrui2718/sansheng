/** 同步 fragment 提取(M2 启发式;M3+ 接入 planner agent 智能提取) */
export interface ExtractedFragment {
  kind: "fact" | "preference" | "project" | "context" | "summary";
  content: string;
  importance: number;
}

const REMEMBER_RE = /(?:^|\s)(记住|记住这点|remember this|以后|note that|请记住|记一下)\s*[:：]?\s*(.{5,200})/i;

export function extractFragments(message: {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
}): ExtractedFragment[] {
  const out: ExtractedFragment[] = [];
  const text = (message.content ?? "").trim();
  if (!text) return out;

  // 触发词检测
  const m = text.match(REMEMBER_RE);
  if (m && m[2]) {
    out.push({
      kind: "fact",
      content: m[2].trim(),
      importance: 0.8,
    });
  }

  // 整条作为 summary(只对 assistant role,且不太短时)
  if (message.role === "assistant" && text.length >= 50) {
    out.push({
      kind: "summary",
      content: text.slice(0, 800), // 截断避免太胖
      importance: 0.4,
    });
  }

  return out;
}