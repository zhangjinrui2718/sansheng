/**
 * 平台运行时 · SDK 适配壳(ADR-001 §2 Q2)
 *
 * ── 这层壳的全部职责就是「不做任何事」────────────────────────────
 *
 * 它把 `PlatformTool`(纯函数,依赖显式注入)包成 SDK 的 `ToolDefinition`
 * (execute 带一个只有 Pi session 里才有的 `ExtensionContext`)。
 *
 * **壳里不许有:参数校验、错误兜底、值转换、逻辑分支。** 一旦需要,说明逻辑
 * 漏进了壳里,应该退回纯函数那一侧。这是 7-H 教训的直接应用:
 *
 *   「不要把 SDK ToolDefinition 适配成 LoopTool —— 它的 execute 签名要求第 5 个
 *    参数 ctx: ExtensionContext(非可选),而 llmCall 路径根本没有 session 上下文,
 *     适配就得上宽类型断言。正确做法是把实现抽成纯函数,两条路径各自包一层薄壳。」
 *
 * 不变式:**本文件不含任何宽类型断言**(窄化一律写 guard)。这条由
 * `tests/platform/sdk-adapter.test.ts` 机器检查,不靠人肉眼 grep —— 连注释里
 * 都不能出现那种字面量,否则项目既有的「宽断言为零」检查会被自己误伤。
 *
 * ── 两个必须照抄的既有做法(来自 src/server/harness/nativeTools.ts)──────
 *
 * ① **type-only import SDK 类型**。
 *    本仓有多处测试对 SDK 做窄 mock(只桩 `createAgentSession`)。工具模块一旦
 *    在**运行时** import 一个它们没覆盖的导出,那些测试会在加载期整体炸掉 ——
 *    7-H 已经踩过一次(缺 SDK 的那个类型标记助手 → 33 个失败,其中一个测试
 *    文件甚至没能加载)。
 *    `import type` 会在编译期被抹掉,所以它是安全的。
 *
 * ② **用本地恒等函数做类型标记,不用 SDK 那个同名助手**。
 *    SDK 的助手运行时零校验(它只是类型层的同一性标记),但 import 它会引入
 *    上面那条加载期依赖。所以本地写一个 `sdkTool<T>(t: T): T { return t; }`。
 *
 * 「字面量到底能不能用」由端到端测试证明,不由类型证明。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PlatformTool, ToolResult } from "../tools/types.js";
import { isSdkToolName, type SdkToolName, type ToolName } from "../harness/capability.js";
import { TOOL_INDEX } from "../tools/registry.js";

/** 本地恒等标记 —— 与 nativeTools.ts 同一个理由(见文件头 ②)。 */
function sdkTool<T extends ToolDefinition>(t: T): T {
  return t;
}

/** 交给 SDK 的结构化结果详情。**观察者靠它判断成败**,不靠解析文本。 */
export interface PlatformToolDetails {
  readonly ok: boolean;
  /** 失败时的错误码(ok=false 才有) */
  readonly code?: string;
  /**
   * 工具自己带回的结构化结果(`ToolResult.data`)。**给宿主读,不给模型读。**
   *
   * 目前的唯一读者是 `project_open` 的 `{ projectId }`:宿主靠它做
   * 「接待会话 → 新项目」的切换。放在这里而不是解析给模型的文本,是因为
   * 文案改一个字就会让解析静默失效 —— 而这条通道本来就是判成败用的,
   * 加一个字段不会引入第二套机制。
   */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * 工具结果 → SDK 的结果形状。
 *
 * ── 失败为什么是**文本 + details**,而不是抛异常 ────────────────────
 *
 * SDK 的 `AgentToolResult` **没有 isError 字段** —— `ToolExecutionEndEvent.isError`
 * 只在 `execute` 抛异常时为 true。而工具失败(参数非法、被门控拒绝)恰恰是
 * 模型**最该读到并自纠**的信息:抛异常会中断这一轮,模型连错误都看不到。
 *
 * 首跑实测证明了这一点:worker 第一次 `board_write` 撞外键失败,它读到
 * 「[工具失败:internal] FOREIGN KEY constraint failed」后**换了参数重试成功**。
 * 抛异常就做不到这件事。
 *
 * 但纯文本让**观察者**无从判断成败 —— 首跑的工具日志把一次失败标成了 ✓。
 * 所以结构化信息走 `details`,与给模型的文本分开:模型读文本自纠,日志读 details。
 */
function toAgentToolResult(r: ToolResult): {
  content: { type: "text"; text: string }[];
  details: PlatformToolDetails;
} {
  if (r.ok) {
    return {
      content: [{ type: "text", text: r.text }],
      details: { ok: true, ...(r.data !== undefined ? { data: r.data } : {}) },
    };
  }
  const text =
    `[工具失败:${r.code}] ${r.message}` +
    (r.alternatives !== undefined && r.alternatives.length > 0
      ? `\n合法取值:${r.alternatives.join(" | ")}`
      : "");
  return { content: [{ type: "text", text }], details: { ok: false, code: r.code } };
}

/** 单条工具描述 → SDK 工具名(给模型看的标签用描述首句,避免再维护一份文案)。 */
function labelOf(t: PlatformTool): string {
  const first = t.description.split(/[。;:：\n]/)[0] ?? t.name;
  return first.length > 40 ? `${first.slice(0, 40)}…` : first;
}

/**
 * 把一批平台工具包成 SDK 的 `customTools`。
 *
 * `dispatchOne` 是注入的派发函数 —— 它**每次调用现取上下文**(而不是预先捕获
 * 一个快照),这样项目状态(active→paused 之类)在长会话里也能反映到调用期门上。
 * 传快照会让「会话开着但项目已被暂停」的那段时间里工具照样可用。
 *
 * 注意本函数**不接收上下文** —— 它只管把元数据搬过去。上下文是 `dispatchOne`
 * 的事,这层壳因此保持零逻辑。
 */
export function toSdkTools(
  tools: readonly PlatformTool[],
  dispatchOne: (
    tool: PlatformTool,
    args: Readonly<Record<string, unknown>>,
  ) => ToolResult | Promise<ToolResult>,
): ToolDefinition[] {
  return tools.map((tool) =>
    sdkTool({
      name: tool.name,
      label: labelOf(tool),
      description: tool.description,
      // promptSnippet 决定它是否出现在默认系统提示的「Available tools」段 ——
      // 8-F 的教训是「工具协议段必须渲染参数清单」,所以 snippet 带上参数名。
      promptSnippet: `${tool.name}(${paramNames(tool)}) — ${labelOf(tool)}`,
      parameters: tool.parameters,
      executionMode: "parallel",
      execute: async (
        _toolCallId: string,
        args: Record<string, unknown>,
      ) => toAgentToolResult(await dispatchOne(tool, args)),
    }),
  );
}

/**
 * 从 typebox schema 里取参数名清单。
 *
 * typebox 的 `Type.Object({...})` 在运行期就是 `{ type:"object", properties:{...} }`,
 * 所以直接读 `properties` 的键即可 —— 不需要解析 schema。
 */
export function paramNames(tool: PlatformTool): string {
  const schema = tool.parameters as { properties?: Record<string, unknown> };
  const props = schema.properties;
  if (props === undefined) return "";
  return Object.keys(props).join(", ");
}

/** 适配壳产出的工具名集合(不变式测试用)。 */
export function adapterToolNames(tools: readonly PlatformTool[]): ToolName[] {
  return tools.map((t) => t.name);
}

// ── 两条通道的分界 ──────────────────────────────────────────────

export interface ClassifiedToolset {
  /** SDK 内置工具(由 Pi 实现,只需进 allowlist) */
  readonly builtinTools: readonly SdkToolName[];
  /** 平台工具(需要 customTools 注册实现) */
  readonly platformTools: readonly PlatformTool[];
  /**
   * 求解结果里有、但两个来源都归不进去的工具。
   * **必须为空** —— 非空意味着「工具面声称有,实际交不出去」,正是 8-A 的形态。
   */
  readonly unplaceable: readonly ToolName[];
  /**
   * 交给 `createAgentSession({ tools })` 的**统一 allowlist** —— 内置 + 平台全都在里面。
   *
   * 不能只放内置:那会把 customTools 一起关掉(见文件头 ①)。
   */
  readonly unifiedAllowlist: readonly ToolName[];
}

/**
 * 把求解出的工具面按来源分类,并拼出那份统一 allowlist。
 *
 * 这是**唯一**该做这个判断的地方 —— 会话工厂按名字自己猜是这类 bug 的温床:
 * 两边的工具名都是闭合集,猜错的那个会静默失踪。
 */
export function classifyToolset(tools: readonly ToolName[]): ClassifiedToolset {
  const builtinTools: SdkToolName[] = [];
  const platformTools: PlatformTool[] = [];
  const unplaceable: ToolName[] = [];

  for (const t of tools) {
    if (isSdkToolName(t)) {
      builtinTools.push(t);
      continue;
    }
    const def = TOOL_INDEX.get(t);
    if (def !== undefined) platformTools.push(def);
    else unplaceable.push(t);
  }

  // 统一名单的**顺序与来源无关**,但必须完整覆盖求解结果 ——
  // 少一个就静默失踪,多一个就未声明越权
  const unifiedAllowlist: ToolName[] = [...builtinTools, ...platformTools.map((t) => t.name)];
  return { builtinTools, platformTools, unplaceable, unifiedAllowlist };
}
