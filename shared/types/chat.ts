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
 * Sansheng UI · 一个 turn 内的逻辑块
 * M3a: shared 化,让 pi → blocks 工具可以写在 server 端。
 */
export type Block =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolCallInfo };

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