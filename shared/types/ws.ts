/**
 * Sansheng WS 协议类型(M1)
 */
export type ServerEvent =
  | { type: "ready"; conversationId: string; modelId: string; provider: string }
  | { type: "agent_start"; conversationId: string; ts: number }
  | { type: "turn_start"; conversationId: string; turnIndex: number; ts: number }
  | { type: "message_start"; conversationId: string; message: { role: "user" | "assistant"; id: string } }
  | { type: "delta"; conversationId: string; messageId: string; text: string }
  | { type: "thinking_delta"; conversationId: string; messageId: string; text: string }
  | { type: "message_end"; conversationId: string; messageId: string; usage?: { input: number; output: number } }
  | {
      type: "tool_start";
      conversationId: string;
      messageId: string;
      tool: { id: string; name: string; args: unknown };
    }
  | {
      type: "tool_end";
      conversationId: string;
      messageId: string;
      tool: { id: string; name: string; result: unknown; isError: boolean; durationMs?: number };
    }
  | {
      type: "agent_end";
      conversationId: string;
      ts: number;
      usage?: { input: number; output: number; costUsd: number };
    }
  | { type: "error"; conversationId: string; error: { code: string; message: string } }
  | { type: "interrupt"; conversationId: string }
  | { type: "conversation_reset"; conversationId: string };

export type ClientCommand =
  | { type: "send"; content: string }
  | { type: "interrupt" }
  | { type: "ping" };