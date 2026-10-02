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
  const repaired = repairStructure(text);
  if (repaired === null) return null;
  return escapeControlCharsInStrings(repaired);
}

/**
 * 把 JSON 字符串字面量内部的**裸控制字符**转义成合法 JSON 转义序列。
 *
 * 2026-10-02 真实事故(conv_muqwgghs_4q0u / todo-6,note `exec-err-uBDq-rMU`):
 * MiniMax-M3 交一份长 markdown 表格,结构体的换行是转义过的 `\n`,但**正文里
 * 至少有一处写成了真实换行符**。于是:
 *   - 严格 `JSON.parse` 失败("Bad control character in string literal");
 *   - `repairTruncatedJson` 把括号补齐了,字符串也补了闭引号 —— 但真实换行
 *     仍然是字符串里的裸控制字符,`JSON.parse` 第二次**照样失败**;
 *   - `parseJsonLenient` 遂放弃 → `parseOutcome` 返回 null → todo failed →
 *     cascade 带走下游 todo-7 → 整份报告作废。
 *
 * 前 500 字符逐字检查过是合法的,全量截断点扫描(303 + 2266 个)也证明截断
 * 本身 100% 能救 —— 唯一剩下的失败面就是「JSON 结构合法但字符串里有裸控制
 * 字符」。模型写长 markdown 时极常见(表格换行、代码块),所以在这一层兜住。
 *
 * 安全性:只在**修复后**的文本上跑(严格 parse 成功的路径根本不会到这里),
 * 且只改字符串字面量内部的控制字符 —— 已写出的正文内容一个字节都不丢,
 * 只是把裸换行还原成它在合法 JSON 里本来的样子。
 */
function escapeControlCharsInStrings(text: string): string {
  // 快速路径:没有控制字符就不用扫(绝大多数输出走这里,零开销)
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x1f]/.test(text)) return text;

  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
      continue;
    }
    if (c === "\\") {
      // 转义序列:下一个字符原样带过(\" \n \\ …),它本身已是合法写法
      out += c;
      const next = text[i + 1];
      if (next !== undefined) {
        out += next;
        i++;
      }
      continue;
    }
    if (c === '"') {
      inString = false;
      out += c;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code < 0x20) {
      if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (c === "\b") out += "\\b";
      else if (c === "\f") out += "\\f";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += c;
  }
  return out;
}

/** repairTruncatedJson 的内部实现(未做控制字符转义)。 */
function repairStructure(text: string): string | null {
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
