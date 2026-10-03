/**
 * Sansheng · 最小工具循环(7-H,取代「给角色配了工具却没有执行点」)
 *
 * ── 为什么是「循环」而不是「换个 SDK」──────────────────────────────────
 * 7-E 起 harness 就能给每个角色配一份工具集合,但 planner / executor 走的是
 * `llmCall → completeSimple` **单轮补全**:配了也没人读。这不是配置问题,是
 * 结构问题 —— 没有循环就没有执行点。
 *
 * 两条路:
 *   ① 把 executor 迁到 Pi session(与 communicator 同款)。能力上限最高,但要重做
 *      JSON 输出协议对齐、abort 语义(C2 注释:llmCall 签名里没有 AbortSignal,
 *      completeSimple 只在整轮结束时才检查中断)、token 预算控制 —— 属主链路改造,
 *      而该区域历史上出过两次 parse 事故(HEAD aa5b113 / 832870e)。
 *   ② **在现有单轮调用外面包一层循环**。`ExecutorLlmCall` / `PlannerLlmCall`
 *      签名**一个字节都不改**,调用方后面的 parse / persist / 状态机逻辑也一行
 *      不动 —— 只是「拿到的 raw」从「第一次调用的输出」变成「收敛后的输出」。
 *
 * jev 裁决 = ②(confidence 1.00)。本模块就是 ②。
 *
 * ── 工具协议 ─────────────────────────────────────────────────────────
 * 模型在某一轮输出:
 *     {"tool_call": {"name": "board_list", "arguments": {...}}}
 * 循环执行它、把结果作为新的一轮上下文灌回去,再调一次;直到模型输出**不含**
 * `tool_call` 的 JSON —— 那就是终轮,交给调用方原有的 parse 逻辑。
 *
 * 用 `parseJsonLenient` 复用既有的 JSON 容错(围栏 / 截断救回),与 Executor /
 * Planner 现有解析同款容错等级,不给工具轮开特例。
 *
 * 终轮 key 与工具轮 key **天然不冲突**:终轮是 `outcome` / 顶层数组,工具轮是
 * `tool_call`。一个对象里同时出现两者的畸形输出按「有 tool_call 即工具轮」处理。
 *
 * ── 三条刻意的设计 ───────────────────────────────────────────────────
 *
 * 1. **工具错误不中断循环,只回灌文本。** `board_read` 传了不存在的 id、
 *    `edit` 写了一个不存在的文件,都是模型**可以自行改正**的普通反馈。把它变成
 *    rejection 只会让整轮失败,模型连「换个参数重试」的机会都没有。回灌文本里
 *    带 `[工具失败]` 前缀,与 harness 工具层同款(不让模型把「被拒」读成「成功但
 *    没内容」)。
 *
 * 2. **工具名不在白名单 → 回灌错误,不静默忽略。** 白名单由调用方按 harness 的
 *    `allowed` 过滤;若模型仍点名了名单外的工具,说明提示词与配置不一致,必须
 *    看得见(这正是 7-B 死接线那类问题的可观测版本)。
 *
 * 3. **轮数上限是硬边界,且不静默截断。** 超过上限时 `truncated: true`,由调用方
 *    写一条说明性 note —— 而不是拿模型最后一句半成品当结论(与 5b-1 的
 *    「残缺的产物不如没有」同一条原则)。
 */
import { parseJsonLenient } from "../../shared/jsonRepair.js";

/** 一个工具参数的可渲染描述(8-F)。**协议段里必须有它** —— 见下方说明。 */
export interface LoopToolParam {
  name: string;
  required: boolean;
  description: string;
}

/** 一个可被循环调用的工具。刻意**不**用 SDK 的 ToolDefinition ——
 *  llmCall 路径没有 Pi session 的 schema 校验层,参数校验由各工具自己负责
 *  (nativeTools / toolBridge 内部都做了 runtime 校验并返回可读错误)。
 *
 *  **但参数名必须告诉模型**(8-F,实机事故):协议段此前只渲染「名字 — 一句描述」,
 *  模型只能靠猜。2026-10-03 实机:执行者调 bash 时传了 {"cmd": ...},SDK 的 bash 工具
 *  拿到 command === undefined,回灌 `/bin/bash: undefined` —— 工具明明在池子里,
 *  却因为「模型不知道参数叫什么」而完全不可用。**能力给了等于没给。** */
export interface LoopTool {
  name: string;
  /** 给模型看的一行说明(会被拼进工具协议段) */
  description: string;
  /** 参数名 / 是否必填 / 一句说明。**必填项标出来**,否则模型会漏。 */
  parameters?: readonly LoopToolParam[];
  run(args: Record<string, unknown>): Promise<string>;
}

export type LoopLlmCall = (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;

export interface ToolLoopCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
}

export interface ToolLoopResult {
  /** 终轮(非工具轮)的模型输出原文 —— 调用方照原样交给既有 parse 逻辑 */
  finalText: string;
  /** 实际发生的工具轮数 */
  toolTurns: number;
  calls: ToolLoopCall[];
  /** 是否因为超过轮数上限而未收敛 */
  truncated: boolean;
}

const DEFAULT_MAX_TOOL_TURNS = 6;

/** module-level type guard:是普通对象(非数组 / 非 null)。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 从模型输出里认工具调用。**只认 `tool_call` 这一个顶层 key** ——
 * 少认一个 = 一次工具轮被当成终轮(模型会拿到一段工具协议却从不调用);
 * 多认一个 = 终轮被当成工具轮(Executor 的 evidence / Planner 的 todo 数组会
 * 被吃掉,变成「工具失败」)。两头都是静默错误,所以只认这一个。
 */
function parseToolCall(raw: string): { name: string; args: Record<string, unknown> } | null {
  const parsed = parseJsonLenient<unknown>(raw);
  if (!parsed.ok) return null;
  const obj = parsed.value;
  if (!isRecord(obj)) return null;
  const call = obj["tool_call"];
  if (!isRecord(call)) return null;
  const name = call["name"];
  if (typeof name !== "string" || !name.trim()) return null;
  const args = call["arguments"];
  return { name: name.trim(), args: isRecord(args) ? args : {} };
}

/** 参数行,如 `参数:`command`(必填,Shell command to execute)。 */
function renderParams(tool: LoopTool): string {
  if (!tool.parameters || tool.parameters.length === 0) return "";
  return (
    " 参数:" +
    tool.parameters
      .map((p) => `\`${p.name}\`(${p.required ? "必填" : "选填"}${p.description ? "," + p.description : ""})`)
      .join("")
  );
}

/** 把可用工具拼成提示词里的协议段。`tools` 为空时返回空串(不注入无意义的段)。 */
export function renderToolProtocol(tools: LoopTool[], maxToolTurns: number): string {
  if (tools.length === 0) return "";
  const lines = tools.map((t) => `- \`${t.name}\` — ${t.description}${renderParams(t)}`);
  return `

## 工具(需要事实时先查,不要凭印象写)

你可以先调用工具拿到事实,再据此作答。**调用工具的这一轮,只输出下面这个 JSON
对象,不要输出任何其他内容**(不要解释、不要 markdown 围栏):

{"tool_call": {"name": "工具名", "arguments": {"参数名": "值"}}}

工具返回结果后你会在下一轮拿到它。拿到结果后:

- 还需要更多事实 → 继续发 tool_call;
- 事实够了 → **输出你的正常格式**(见上文你的输出协议),不要再发 tool_call。

工具调用上限 **${maxToolTurns} 轮**;用尽后直接给最终答案。
工具报错时(返回以 \`[工具失败]\` 开头)读懂原因、换参数重试,或改用已有信息作答。

可用工具:
${lines.join("\n")}`;
}

/**
 * 跑一轮带工具的补全。
 *
 * `tools` 已由调用方按 harness 的 `allowed` 名单过滤完毕(过滤在 Executor /
 * Planner 内部做,见各自 options)—— 本函数**不做任何授权判断**,它只负责
 * 「让模型能调用这些工具并把结果拿回来」。
 */
export async function runWithTools(opts: {
  llmCall: LoopLlmCall;
  systemPrompt: string;
  userPrompt: string;
  tools: LoopTool[];
  maxToolTurns?: number;
}): Promise<ToolLoopResult> {
  const maxToolTurns = opts.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
  const tools = opts.tools;
  // 无工具 → 直接走单轮(不注入协议段)。这也是测试与离线路径的默认形态。
  if (tools.length === 0) {
    const raw = await opts.llmCall({ systemPrompt: opts.systemPrompt, userPrompt: opts.userPrompt });
    return { finalText: raw, toolTurns: 0, calls: [], truncated: false };
  }

  const byName = new Map(tools.map((t) => [t.name, t]));
  const systemPrompt = opts.systemPrompt + renderToolProtocol(tools, maxToolTurns);
  const calls: ToolLoopCall[] = [];
  /** 已发生的工具轮**按顺序全部保留**。见下方 2026-10-03 事故注释。 */
  const exchanges: string[] = [];
  let transcript = opts.userPrompt;

  for (let turn = 0; turn <= maxToolTurns; turn++) {
    const raw = await opts.llmCall({ systemPrompt, userPrompt: transcript });
    const call = parseToolCall(raw);
    if (call === null) {
      return { finalText: raw, toolTurns: turn, calls, truncated: false };
    }
    // 轮数用尽:不再执行,交还调用方处理(它会把 truncated 写进 note)
    if (turn === maxToolTurns) {
      return { finalText: raw, toolTurns: turn, calls, truncated: true };
    }
    const tool = byName.get(call.name);
    let resultText: string;
    let okFlag: boolean;
    if (!tool) {
      okFlag = false;
      resultText = `[工具失败] 没有名为「${call.name}」的工具。可用:${[...byName.keys()].join(" / ")}。`;
    } else {
      try {
        resultText = await tool.run(call.args);
        okFlag = !resultText.startsWith("[工具失败]");
      } catch (e) {
        okFlag = false;
        resultText = `[工具失败] ${call.name} 抛出异常:${e instanceof Error ? e.message : String(e)}`;
      }
    }
    calls.push({ name: call.name, args: call.args, ok: okFlag, ...(okFlag ? {} : { error: resultText.slice(0, 200) }) });
    // ── 2026-10-03 真实事故(conv_murpu3ml_cged / todo-1,note `exec-err-TVj9oQwe`)──
    //
    // 这一行原来是**从 opts.userPrompt 重新拼**,于是每一轮喂给模型的只有
    // 「原始 prompt + 上一轮的工具结果」,**再往前的工具轮全部消失**。实测(3 连发
    // tool_call 的探针):第 2 次调用看得到第 1 轮,第 3 次只看得到第 2 轮 —— 模型
    // 每轮都从零开始,永远记不住自己已经查过什么。
    //
    // 后果正是那次事故:todo-1 是「调研 Omni 在外呼场景的能力边界与延迟」这种需要
    // 连查多份资料才能作答的活,模型每轮失忆 → 要么重复同一个调用、要么原地打转,
    // 6 轮上限用尽仍不收敛 → todo failed → 级联带走 todo-4。**6 轮不是不够,是
    // 前 5 轮白跑了**。变量叫 transcript 却只装一轮,名副其实的「假 transcript」。
    //
    // 修法:把每一轮都 push 进 exchanges,再整体拼给模型。
    //
    // 上下文会不会因此涨爆?不会到不可用的程度:单条工具结果的上限由 sandbox 的
    // policy.maxBytes 兜底(fs 侧默认 30KB,见 tools/fs.ts),6 轮最坏 ~180KB。
    // 这里**不再加第二道上限** —— toolBridge.ts 明确写了「sandbox 侧已截断,这里
    // 不再二次加工(避免两处上限打架)」,两道上限互相盖住比一道更难排查。
    exchanges.push(
      `## 第 ${turn + 1} 次工具调用\n请求:${JSON.stringify(call)}\n结果:${resultText}`,
    );
    transcript =
      `${opts.userPrompt}\n\n${exchanges.join("\n\n")}\n\n` +
      `请据此继续(还需要事实就再发一次 tool_call,否则直接给最终答案)。`;
  }

  // 循环正常走完不可能到这里(maxToolTurns 的两个出口都 return),留作兜底。
  return { finalText: "", toolTurns: maxToolTurns, calls, truncated: true };
}
