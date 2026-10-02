/**
 * 同步 fragment 提取(M2 启发式残留;智能提取属 M3+/批次 5b)
 *
 * 批次 5a.5 T1(docs/CODE-REVIEW-2026-10-01.md §B1):删除「assistant 全文
 * ≥50 字符 → kind:"summary" 原文全存」占位分支 —— 它把每条回复都变成可被
 * LIKE 检索命中的 fragment,注入 prompt 后模型模仿其格式,新回复再被存成
 * summary,形成自我放大的记忆循环(用户真实库已积累 13 条拼接垃圾)。
 * 保留 REMEMBER_RE「记住:」触发词 fact 提取;存量 summary 的检索失活见
 * repo/fragments.ts searchFragmentsByText 默认 kinds。
 *
 * 批次 5b-1 P4:新增**仅 user 角色生效**的身份/偏好启发式(NAME_RE/LIKE_RE),
 * 服务 decide=feedback 的收录路径;assistant 侧提取面不变(防记忆循环语义保持)。
 */
export interface ExtractedFragment {
  kind: "fact" | "preference" | "project" | "context" | "summary";
  content: string;
  importance: number;
}

const REMEMBER_RE = /(?:^|\s)(记住|记住这点|remember this|以后|note that|请记住|记一下)\s*[:：]?\s*(.{5,200})/i;

/**
 * 批次 5b-1 P4:用户侧自我披露启发式 —— **仅 role==="user" 生效**。
 * 触发场景是 decide=feedback 的收录路径(kernel.persistHandoff),身份/偏好
 * 从用户原话提取入库;assistant 侧仍然只有 REMEMBER_RE(memory-loop 守护
 * 的「assistant 全文不再产噪」语义不变)。
 * - NAME_RE:句首「我叫X / 我是X」→ fact「用户名字:X」(profile.name 接线的识别前缀)
 * - LIKE_RE:句首「我喜欢/讨厌/不喜欢…」→ preference(原句截断保存,检索用)
 */
const NAME_RE = /^(?:我叫|我是)\s*([^\s,，。;；!！?？]{1,30})/;
const LIKE_RE = /^我(?:喜欢|讨厌|不喜欢)/;

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

  // 批次 5b-1 P4:用户侧身份/偏好(不与 REMEMBER_RE 叠加 —— 「记住:我叫X」
  // 走上面的 fact 路径,内容已含原话,避免同句双 fragment)
  if (message.role === "user" && !m) {
    const nm = text.match(NAME_RE);
    if (nm && nm[1]) {
      out.push({ kind: "fact", content: `用户名字:${nm[1].trim()}`, importance: 0.8 });
    } else if (LIKE_RE.test(text)) {
      out.push({ kind: "preference", content: text.slice(0, 200), importance: 0.7 });
    }
  }

  return out;
}
