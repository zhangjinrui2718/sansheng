/**
 * Sansheng · 共享类型:Chat
 * 服务端 / 客户端都用这套类型,保证 WS 消息契约一致。
 */
export type Role = "user" | "assistant" | "system";

export interface ToolCallInfo {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

/**
 * 批次 7-I · 交付物(delivery)
 *
 * **B 缺陷的正面解**:plan 跑完之后,executor 写出的 evidence 正文原本**只躺在
 * blackboard 里** —— `buildPlanSummary` 给用户的是一行「计划 "X" 完成 3/5」,
 * 真正的产物(可能是一份几千字的技术方案)要用户自己去「工件」tab 翻。
 *
 * 协议上 `plan_done` 其实**早就把整个 artifacts 带过来了**(ws.ts 的
 * `artifacts: finalBb.artifacts ?? []`),是前端把它丢了、只渲染 summary。
 * 所以这个缺陷不是「少传数据」,而是「**传了但没人收**」。
 *
 * `deliveries` 是从 blackboard 里**挑出来的交付子集**(服务端挑,见 ws.ts 的
 * pickDeliveries):只含 resolved 的 evidence —— 即执行者真正做出来的东西。
 * hypothesis(等人拍板)与 note(失败说明)不算交付物:前者要走升级提问通道,
 * 后者是错误,把它们混进「交付」会稀释交付语义。
 */
export interface DeliveryItem {
  /** 工件 id(用户可据此回到「工件」tab 定位同一条) */
  id: string;
  /** 工件 kind(当前恒为 "evidence";留字段以备将来支持别的交付形态) */
  kind: string;
  title: string;
  /** 交付正文(markdown)。这是**用户真正要的东西**。 */
  body: string;
  /** 所属 todo(有 parentTodoId metadata 时)——让用户知道这是为哪件事做的 */
  todoTitle?: string;
}

/**
 * 批次 8-C · 计划卡(plan)
 *
 * **B 缺陷的正面解**:用户抱怨「计划不可见、跑飞的 plan 停不下来」。此前 plan 拆解
 * 只存在于 blackboard(工件页事后能翻),对话流里从拆解到完成是**一片空白** ——
 * 用户既看不见「正在做哪一步」,也**没有任何按钮能叫停**。
 *
 * 这里是前端侧对 plan_planned / plan_todo_update 的累积态:
 *   - todos      一次性来自 plan_planned,之后按 todoId **逐行**更新(整份计划不重发);
 *   - terminal   plan_done / plan_failed 之后写一次,计划卡进入终态(不再有增量);
 *   - abortRequested  用户点了「中止」且命令已发出 —— **不可撤销**,UI 据此立刻
 *     锁死按钮,避免重复点击(服务端 abort 掉在飞 executor 后只回 plan_failed)。
 */
export interface PlanTodo {
  id: string;
  title: string;
  /** 与工件状态同一套(ArtifactStatus) */
  status: import("./blackboard.js").ArtifactStatus;
  /** 依赖的 todo id;非空时 UI 标一行「依赖前一步」 */
  dependsOn: string[];
  /** 失败原因(仅 status === "failed" 时有值) */
  reason: string | null;
}

export interface PlanBlockData {
  intentId: string;
  todos: PlanTodo[];
  /** 用户已点「中止」,命令已发出 */
  abortRequested: boolean;
  /** 终态(null = 还在跑) */
  terminal: { kind: "done" | "failed"; text: string } | null;
}

/**
 * Sansheng UI · 一个 turn 内的逻辑块
 * M3a: shared 化,让 pi → blocks 工具可以写在 server 端。
 */
export type Block =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolCallInfo }
  | { kind: "delivery"; items: DeliveryItem[] }
  | { kind: "plan"; plan: PlanBlockData };

export interface MessageChunk {
  type: "delta" | "tool_call" | "tool_result" | "thinking" | "done" | "error" | "node" | "heartbeat";
  conversationId: string;
  messageId?: string;
  role?: Role;
  // delta
  text?: string;
  // tool
  tool?: ToolCallInfo;
  // thinking
  thinking?: string;
  // error
  error?: { code: string; message: string };
  // node transition (Planner→Executor etc.)
  node?: { from?: string; to: string; reason?: string };
  // heartbeat
  elapsedMs?: number;
  // done
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}