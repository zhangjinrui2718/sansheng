/**
 * Sansheng Block 转换 · M3a
 *
 * Pi SDK 的 AgentMessage.content 是 content block 数组,
 * 这里把它转成 Sansheng UI 用的 Block 类型。
 */
import { nanoid } from "nanoid";

/** 本地 Block 类型 — 镜像 shared/types/chat.ts 的 Block。 */
type ToolCall = {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
};
export type Block =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolCall };

/**
 * 单个 Pi content block → Sansheng Block
 *
 * Pi SDK 的 content 元素可能是:
 *   - { type: "text", text: "..." }
 *   - { type: "thinking", thinking: "..." }
 *   - { type: "tool_use", id, input, name? }
 *   - { type: "tool_result", tool_use_id, content, is_error? }
 *
 * tool_result 也兼容地映射为 kind:"tool",这样 UI 上 tool block
 * 可以直接展示 result。
 */
export function piMessagesToBlocks(piece: unknown): Block {
  if (!piece || typeof piece !== "object") {
    return { kind: "text", text: "" };
  }
  const p = piece as Record<string, unknown>;
  switch (p.type) {
    case "text":
      return { kind: "text", text: typeof p.text === "string" ? p.text : "" };
    case "thinking":
      return { kind: "thinking", text: typeof p.thinking === "string" ? p.thinking : "" };
    case "tool_use": {
      return {
        kind: "tool",
        tool: {
          id: typeof p.id === "string" ? p.id : nanoid(),
          name: typeof p.name === "string" ? p.name : "unknown",
          args: (p.input ?? p.args ?? null) as unknown,
          result: undefined,
          isError: false,
        },
      };
    }
    case "tool_result": {
      return {
        kind: "tool",
        tool: {
          id: typeof p.tool_use_id === "string" ? p.tool_use_id : nanoid(),
          name: "tool_result",
          args: null,
          result: p.content as unknown,
          isError: Boolean(p.is_error),
        },
      };
    }
    default: {
      // 兜底:如果看起来已经是 Block,直接返回;否则包成 text
      const k = (p as { kind?: unknown }).kind;
      if (k === "text" || k === "thinking" || k === "tool") {
        return piece as Block;
      }
      return { kind: "text", text: typeof p.text === "string" ? p.text : "" };
    }
  }
}