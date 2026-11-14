/**
 * AgentRuntime 端口 —— 平台与「会话运行时」之间的契约(2026-11-14,Wave A1)。
 *
 * ── 为什么有这个目录 ────────────────────────────────────────────
 *
 * 平台现在跑在 pi SDK 上,但平台真正需要的只有一小片面:建一条会话、
 * 喂 prompt、订阅事件、能 abort、能 dispose。把这一面定义成**平台自己的
 * 词**,未来换运行时(DeepSeek / Coze / 任何东西)= 在 `pi/` 旁边加一个
 * 适配器目录,而不是动 dispatcher / harness / 工具 / 存储 / 前端。
 *
 * ── 现状(A1,诚实记)───────────────────────────────────────────
 *
 * - pi 的实现住在 `agentRuntime/pi/`(sessionFactory / toolsAdapter);
 *   事件词表的翻译(`RuntimeEvent`)与 turn.ts 的消费切换是 **A2** ——
 *   在那之前,事件类型参数 `E` 由各适配器自带(词表是适配器的方言)。
 * - 谁在消费这个端口:① `pi/session.ts` 的符合性断言(编译期证明
 *   `AgentSession` 满足 `RuntimeSession`);② `CreateSessionFn` 的全部
 *   使用方(~20 个测试 + serve.ts 的 DI 缝)—— 它们在 A2 切到端口词。
 * - 判据纪律:**端口文件不许 import 任何具体运行时**(pi 也一样)——
 *   端口是平台的家,不是运行时的门厅。
 */

/** 所有运行时会话事件的词根(A2 会把平台词表挂在这里)。 */
export interface RuntimeSessionEventBase {
  readonly type: string;
}

/**
 * 一条**常驻**会话的平台视角。方法面就是平台消费的全部(审计 2026-11-14:
 * subscribe / prompt / abort / dispose 四件,外加两个 pi 特有的可选件)。
 *
 * ⚠️ 生命周期语义是契约的一部分:
 *   · `prompt()` resolve **不等于**回合结束 —— 收敛信号在事件流里(适配器方言);
 *   · 取消的**唯一**入口是 `abort()`(等它收敛到 idle,可以不 await);
 *   · 会话由调用方池化与 dispose,端口不管生命周期归属。
 */
export interface RuntimeSession<E extends RuntimeSessionEventBase = RuntimeSessionEventBase> {
  /** 订阅事件流(适配器方言;A2 起方言翻译到 `RuntimeEvent`)。返回退订函数。 */
  subscribe(fn: (ev: E) => void): () => void;
  /** 喂一轮。resolve 时机由适配器定义(平台的收敛判据在事件流)。 */
  prompt(input: unknown): Promise<unknown>;
  /** 中断当前轮(等收敛到 idle;调用方可以不 await)。 */
  abort(): Promise<void>;
  /** 释放(池化清理时调用;模型与扩展的资源一并释放)。 */
  dispose(): void | Promise<void>;
  /**
   * 可选诊断面:「声明工具面 vs 运行时激活面」的对账(冒烟命令用)。
   * 适配器可不实现 —— 它不是任何链路的一环。
   */
  getActiveToolNames?: () => readonly string[];
}

/**
 * 建会话的请求。字段是**平台想表达的**,不是某个 SDK 的构造参数:
 * 具体形状由适配器解释(比如 `model` 在 pi 适配器里是 pi-ai 的 `Model`)。
 */
export interface RuntimeSessionRequest {
  /** 会话工作目录(项目根;接待会话 = 工作根)。 */
  cwd: string;
  /** 运行时的全局配置目录(会话持久化 / 日志落在这里)。 */
  agentDir: string;
  /** 已解析的模型(provider 层解析;端口语:解析失败的出口在 provider 层)。 */
  model: unknown;
  /** 允许清单(运行时内置工具的子集声明)。 */
  tools: readonly unknown[];
  /** 平台自有工具(端口语:纯函数 + 显式 ctx 注入;适配器负责包成运行时形状)。 */
  customTools: Record<string, unknown>;
  /** 运行时扩展(适配器方言;pi 是 extensionFactories)。 */
  extensionFactories: readonly unknown[];
}

/** 建会话的工厂。`E` = 该适配器的会话事件方言。 */
export type RuntimeSessionFactory<E extends RuntimeSessionEventBase = RuntimeSessionEventBase> = (
  req: RuntimeSessionRequest,
) => Promise<RuntimeSession<E>>;

// ── 事件词表(A2,2026-11-14)───────────────────────────────────
//
// 平台自己的运行时事件词:runTurn **只认这一份**,不再出现任何具体运行时的
// 事件类型。翻译在适配器里做(pi: `pi/events.ts` 的 `normalizeSessionEvent`,
// 未消费的方言事件在那里被丢弃 —— 丢弃是适配器的决定,不是平台的猜测)。
//
// ⚠️ 两条刻意的「不翻译」:
//   · `message_end.message` 保持 `unknown` —— usage/role/stopReason 的**值形状**
//     容错读取(`usageSnapshotOf` 一系)是平台已有的判据,T1 教训:把字段名
//     变成编译期断言,SDK 改名时我们会把账读成全零而毫无现场;
//   · `tool_end.result` 保持适配器方言(工具结果的封套是适配器与运行时的
//     工具协议;平台侧的结构化读取有局部窄化与注释)。
export type RuntimeEvent =
  | { type: "message_update"; deltaKind: "text" | "thinking" | "other"; delta?: unknown }
  | { type: "message_end"; message: unknown }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: unknown;
    }
  | { type: "auto_retry_start" }
  | { type: "auto_retry_end" }
  | { type: "agent_settled" }
  | { type: "agent_end" };
