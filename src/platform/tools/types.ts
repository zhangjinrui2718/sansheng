/**
 * Sansheng 平台 · 工具层类型
 *
 * ── 为什么要有这一层,而不是直接写 SDK 的 `customTools` ─────────────
 *
 * `createAgentSession({ customTools })` 要的是 SDK 的 `ToolDefinition`,它带
 * `execute(args, ctx: ExtensionContext)` —— 那个 ctx 只有 Pi session 里才有。
 * 直接写它意味着:**工具只能在真会话里测**,而真会话要 provider、要 API key、
 * 要网络。本项目为此吃过大亏(5 个 E2E blocker 至今只有 fakeLlmCall 验证)。
 *
 * 所以工具实现写成**纯函数**:参数进、结果出,依赖(库连接、当前 agent、
 * 当前项目、时钟、id 生成)全部显式注入。SDK 适配放在最外面一层薄壳里 ——
 * 7-H 的教训:「不要把 SDK ToolDefinition 适配成 LoopTool,把实现抽成纯函数,
 * 两条路径各自包一层薄壳」。
 *
 * ── 时间与 id 也要注入 ────────────────────────────────────────────
 *
 * `now()` 与 `newId()` 是注入的而不是直接调 `Date.now()` / `nanoid()`:
 * 否则工具的输出不可复现,测试只能断言「大概是这样」。注入之后可以断言
 * 「createdAt 恰好等于我给的那个数」。
 */
import type Database from "better-sqlite3";
import type { Agent, Project } from "../harness/authorize.js";
import type { MemoryPort } from "../memory/port.js";
import type { ClientChannel } from "../client/port.js";
import type { Capability, ToolName } from "../harness/capability.js";
import type { TSchema } from "@sinclair/typebox";

/** 工具执行的依赖。全部显式注入,没有模块级单例。 */
export interface ToolRunContext {
  readonly db: Database.Database;
  /** 调用者。授权判定与审计都要用它 —— 工具不许「自己猜是谁在调」。 */
  readonly agent: Agent;
  /** 当前项目。工具的作用域全部挂在它上面。 */
  readonly project: Project;
  /** 时钟注入:让输出可复现 */
  readonly now: () => number;
  /** id 生成注入:`newId("wk")` → "wk_xxx" */
  readonly newId: (prefix: string) => string;
  /**
   * 记忆后端。**可选**,因为不是每一次工具调用都需要记忆 —— 而且它的后端是
   * 可替换的(设计 1 §8.3)。缺省时 `memory_*` 工具会如实报「装配错误」,
   * 而不是假装成功或静默返回空。
   */
  readonly memory?: MemoryPort;
  /**
   * 甲方通道。**可选**,理由同 memory —— 它的物理形态是传输层的事。
   * 缺省时 `client.*` 工具会如实报装配错误。
   */
  readonly client?: ClientChannel;
}

export type ToolErrorCode =
  | "denied" // 被授权门拒绝(ceiling / scope / writeKind)
  | "invalid_args" // 参数不合法
  | "not_found" // 目标不存在
  | "conflict" // 状态冲突(重复关闭、非法迁移、成环)
  | "internal"; // 意外错误

export type ToolResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly code: ToolErrorCode;
      readonly message: string;
      /**
       * 合法取值清单。8-F 教训:工具协议段必须渲染参数清单,否则模型会传错
       * 参数名 —— 而「传错」的表现形式往往是**编造**。所以凡是「你给的值不在
       * 允许集合里」的拒绝,都必须把允许集合回灌给模型。
       */
      readonly alternatives?: readonly string[];
    };

export function ok(text: string): ToolResult {
  return { ok: true, text };
}

export function fail(
  code: ToolErrorCode,
  message: string,
  alternatives?: readonly string[],
): ToolResult {
  return alternatives !== undefined
    ? { ok: false, code, message, alternatives }
    : { ok: false, code, message };
}

/**
 * 项目内的角色 → 实际 agent 的解析结果。
 *
 * 设计 1 §3.3 要求**显式处理三种失败**,不做隐式兜底(「随便挑一个同角色的」
 * 会让「交接给了谁」不可预测)。这个类型就是那三种失败的载体。
 */
export type ResolveResult =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly reason: "no_such_role" | "ambiguous" | "no_such_spec";
      readonly message: string;
      readonly alternatives: readonly string[] };

/**
 * 平台工具定义。
 *
 * `capability` 是必需的 —— 它是「这个工具属于哪条能力」的唯一声明,派发器
 * 靠它做授权判定(工具名 → 能力的反查也能做,但显式声明让工具表自解释,
 * 且能在注册时校验一致性)。
 */
export interface PlatformTool {
  readonly name: ToolName;
  readonly capability: Capability;
  /** 给模型看的描述。写清「什么时候用它」比写清「它做什么」更重要。 */
  readonly description: string;
  /** typebox schema —— 与 SDK 同源,免转换 */
  readonly parameters: TSchema;
  readonly run: (
    args: Readonly<Record<string, unknown>>,
    ctx: ToolRunContext,
  ) => Promise<ToolResult> | ToolResult;
}

// ── 参数读取小工具(避免每处都写一遍 as/typeof)────────────────────

export function readString(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function requireString(
  args: Readonly<Record<string, unknown>>,
  key: string,
): { ok: true; value: string } | { ok: false; result: ToolResult } {
  const v = readString(args, key);
  if (v === undefined) {
    return { ok: false, result: fail("invalid_args", `缺少必填参数 ${key}(必须是非空字符串)`) };
  }
  return { ok: true, value: v };
}

export function readNumber(
  args: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function readStringArray(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}
