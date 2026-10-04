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
  /**
   * 当前项目。工具的作用域全部挂在它上面。
   *
   * **可空** = 接待会话(`project_id IS NULL` 的那条,见
   * `migrations/012_intake_session.sql`):第一个项目还不存在时,甲方先与业务经理
   * 在接待会话里把诉求谈清楚。接待模式下工具面只剩 `project_open` 与 `memory_*`
   * (见 `harness/authorize.ts` 的 `INTAKE_CAPABILITIES`),项目内工具根本拿不到。
   *
   * 需要项目的工具**必须**用 `requireProject(ctx, ...)` 显式处理这一种情况 ——
   * 不许用 `!` 或断言糊过去:接待模式下真发生调用时,那个断言会把一次本该
   * 结构化报错的调用变成一次崩溃(模型的下一步因此失去依据)。
   */
  readonly project: Project | null;
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

/**
 * 取「当前项目」。接待会话下没有项目 —— 此时如实返回结构化失败。
 *
 * 为什么不直接 `ctx.project!.id`:接待模式下 `project` 真的是 null,断言会让
 * 一次本该可读的拒绝(「这个工具需要项目」)变成 `TypeError`,而模型只能靠错误
 * 信息决定下一步(7-D/7-M:不要惩罚不携带错误信息的偏差)。
 *
 * 调用点在**项目内工具**里;接待模式下它们进不了工具面,所以这里的失败分支
 * 是**纵深防御**,不是常规路径 —— 但它必须存在且可读。
 */
export function requireProject(
  ctx: ToolRunContext,
  toolName: string,
): { readonly ok: true; readonly project: Project } | { readonly ok: false; readonly result: ToolResult } {
  if (ctx.project === null) {
    return {
      ok: false,
      result: fail(
        "denied",
        `工具「${toolName}」需要当前项目,而这次调用发生在**接待会话**(还没有任何项目)。` +
          `接待阶段只做两件事:与甲方把诉求谈清楚,然后用 project_open 立项 —— ` +
          `立项之后这些工具才会出现在你的工具面上`,
      ),
    };
  }
  return { ok: true, project: ctx.project };
}

export type ToolErrorCode =
  | "denied" // 被授权门拒绝(ceiling / scope / writeKind)
  | "invalid_args" // 参数不合法
  | "not_found" // 目标不存在
  | "conflict" // 状态冲突(重复关闭、非法迁移、成环)
  | "internal"; // 意外错误

export type ToolResult =
  | {
      readonly ok: true;
      readonly text: string;
      /**
       * 结构化结果。**给观察者(宿主)读,不给模型读** —— 模型读 `text`。
       *
       * 为什么需要它:`project_open` 成功后,宿主必须知道「新项目叫什么 id」
       * 才能把接待会话的消息迁进新项目、并让前端切过去。从 `text` 里正则抠 id
       * 是脆的(改一个字就静默失效);回调注入则要在 `ToolRunContext` 上开一个
       * 事件通道。这里走的是**已经存在的那条结构化通道**:适配壳
       * (`runtime/sdkAdapter.ts`)把它原样放进 SDK 的 `details`,
       * 而 `runTurn` 已经在读 `details`(判工具成败就是靠它)。
       */
      readonly data?: Readonly<Record<string, unknown>>;
    }
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

export function ok(text: string, data?: Readonly<Record<string, unknown>>): ToolResult {
  return data !== undefined ? { ok: true, text, data } : { ok: true, text };
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
