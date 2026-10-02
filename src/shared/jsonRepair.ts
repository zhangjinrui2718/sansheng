/**
 * 截断 JSON 修复 —— 让「模型输出被 maxTokens 截断」不再等于「产物全丢」。
 *
 * 背景(2026-10-02 真实案例 conv_muqsidb0_wgru):
 * ws.ts makeLlmCall 调 completeSimple 时没传 maxTokens,也没检查
 * `stopReason === "length"`(pi-ai StopReason 联合类型的 7 个成员之一,
 * node_modules/@earendil-works/pi-ai/dist/types.d.ts:292)。于是模型写长报告时
 * 撞上输出上限,拿回半截 JSON —— makeLlmCall 只在 stopReason==="error" 时抛,
 * 于是这半截被当成**成功**返回。Executor.parseOutcome 随后 JSON.parse 失败 →
 * handleParseFailure → todo 标 failed → cascadeFailDependents 把下游 3 个 todo
 * 全部带走。2/6 的 todo 明明成功产出 evidence,用户最后什么都没拿到。
 *
 * 这里的目标很窄:**把已经写出来的那部分救回来**,而不是重新调用模型。
 * 实测被截断的输出形如:
 *   {"outcome":"evidence","evidence":{"title":"百外语音机器人模型层调研…",
 *    "body":"# 模型层技术调研报告\n\n## 一、流式 ASR…（截断）
 * 它的 `title` 已经完整,`body` 写了大半 —— 这些都是可用产物,不该丢。
 *
 * 修复策略(纯字符串层,不改 LLM 行为):
 * 1. 严格 JSON.parse 成功 → 原样返回(repaired=false)。
 * 2. 失败 → 状态机扫描,定位「安全截断点」,补齐未闭合的引号 / 括号。
 *    - 截断发生在**字符串值**中间 → 保留已有内容,补一个闭引号(处理尾随
 *      反斜杠奇偶),该值即为「已写出的部分」。
 *    - 截断发生在**对象键**中间 → 整个键丢弃(键名半截无法构成有效 JSON),
 *      连同它前面的逗号一起回退。
 *    - 截断发生在裸记号(如 `tru` / `1,` 后面)→ 回退到最后一个安全点。
 * 3. 修完再 JSON.parse;仍失败 → 返回 null,由调用方走原有降级路径。
 *
 * 安全性:本函数**只做结构补齐,不改写任何已写出的字符**。修复结果是否可用
 * 仍由各调用方自己的字段校验决定(如 parseOutcome 要求 evidence.title 是
 * string),所以「修复出一个残缺但结构合法的对象」不会绕过既有校验。
 */

const OPEN_TO_CLOSE: Record<string, string> = { "{": "}", "[": "]" };

function isWs(ch: string | undefined): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

/**
 * 扫描并补齐被截断的 JSON。返回**修复后的文本**(调用方自行 JSON.parse),
 * 无法定位可用前缀时返回 null。
 */
export function repairTruncatedJson(text: string): string | null {
  // 跳过 ```json 围栏 / 前置噪音,定位第一个 { 或 [
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const s = text.slice(start);

  const stack: string[] = [];
  // 未闭合字符串字面量的起始下标(在 s 内);-1 表示当前不在字符串里
  let stringStart = -1;
  // 当前字符串是「值」还是「键」—— 开引号那一刻就能判定(见下方开括号判定)
  let stringIsValue = false;
  // 字符串**外**的最后一个非空白字符 —— 用来判断未闭合字符串是键还是值
  let prevSig = "";
  // 安全截断点(s 内,exclusive)。含义:切到这里后,只需补闭合符即可得到合法 JSON。
  let lastSafe = -1;

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;

    if (stringStart >= 0) {
      // 字符串内部:逐字符判断转义(不依赖 slice,避免 O(n²))
      if (c === "\\") {
        // 反斜杠:跳过被转义的下一个字符(越界时视为截断,交给尾部处理)
        i++;
        continue;
      }
      if (c === '"') {
        stringStart = -1;
        prevSig = '"';
        // 只有**值**闭合后才是安全切点。键闭合后紧跟的必然是 `:`,
        // 切在那里会留下悬空键(`{"ok"}` 解析失败)—— 保持上一个安全点。
        if (stringIsValue) lastSafe = i + 1;
      }
      continue;
    }

    if (isWs(c)) continue;

    if (c === '"') {
      stringStart = i;
      // 数组里的字符串永远是值;对象里看前一个显著字符:`{`/`,` → 键,`:` → 值
      stringIsValue = stack[stack.length - 1] === "[" || prevSig === ":";
      continue;
    }
    if (c === "{" || c === "[") {
      stack.push(c);
      lastSafe = i + 1; // 刚开括号,内部是空的,切到这里是安全的
      prevSig = c;
      continue;
    }
    if (c === "}" || c === "]") {
      const open = stack.pop();
      // 括号不配对 → 不是「截断」,是真坏 JSON,交给调用方降级
      if (!open) return null;
      if (OPEN_TO_CLOSE[open] !== c) return null;
      prevSig = c;
      if (stack.length === 0) {
        // 顶层闭合 → 整体完整,截断到这儿正好
        return s.slice(0, i + 1);
      }
      lastSafe = i + 1;
      continue;
    }
    if (c === ",") {
      lastSafe = i; // 切在逗号**之前**,避免留下悬空逗号
      prevSig = ",";
      continue;
    }
    prevSig = c;
  }

  // 到这里说明确实被截断了。
  const closers = stack
    .slice()
    .reverse()
    .map((o) => OPEN_TO_CLOSE[o]!)
    .join("");

  if (stringStart >= 0) {
    // 未闭合字符串:是键还是值?
    const inArray = stack[stack.length - 1] === "[";
    // 数组里永远是值;对象里看前一个显著字符:`{`/`,` → 键,`:` → 值
    const isValue = inArray || prevSig === ":";

    if (!isValue) {
      // 键名写了一半 → 整个键丢弃,连同它前面那个逗号一起回退
      const cut = Math.max(0, Math.min(lastSafe, stringStart));
      const head = s.slice(0, cut);
      return head + closers;
    }

    // 值写了一半 → 保留「stringStart 之前的全部前缀 + 已写内容」,再补闭引号。
    // 尾随反斜杠奇偶要处理:奇数个尾随 "\" 会把补上的引号转义掉,必须再补一个成对。
    let written = s.slice(stringStart);
    let backslashes = 0;
    while (backslashes < written.length && written[written.length - 1 - backslashes] === "\\") {
      backslashes++;
    }
    if (backslashes % 2 === 1) written += "\\";
    return s.slice(0, stringStart) + written + '"' + closers;
  }

  // 截断在裸记号位置(`tru` / `{...,"a":1,` 之后的键名残留等)
  const cut = lastSafe >= 0 ? lastSafe : 0;
  return s.slice(0, cut) + closers;
}

export type LenientParse<T> =
  | { ok: true; value: T; repaired: boolean }
  | { ok: false; repaired: false };

/**
 * 宽容 JSON.parse:严格失败后自动尝试截断修复。
 *
 * `repaired === true` 表示值来自「被截断后补齐」的产物 —— 调用方应据此
 * 决定是否要在 UI / evidence 上标注「输出被截断」,而不是当成完整结果。
 */
export function parseJsonLenient<T>(raw: string): LenientParse<T> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, repaired: false };

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = fence && fence[1] ? [fence[1].trim(), trimmed] : [trimmed];

  for (const c of candidates) {
    if (!c) continue;
    try {
      return { ok: true, value: JSON.parse(c) as T, repaired: false };
    } catch {
      /* 继续:尝试修复 */
    }
  }

  for (const c of candidates) {
    if (!c) continue;
    const repaired = repairTruncatedJson(c);
    if (!repaired) continue;
    try {
      return { ok: true, value: JSON.parse(repaired) as T, repaired: true };
    } catch {
      /* 修复后仍不合法 → 放弃 */
    }
  }

  return { ok: false, repaired: false };
}
