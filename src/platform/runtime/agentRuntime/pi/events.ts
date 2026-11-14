/**
 * pi 适配器 · 事件翻译(A2,2026-11-14)
 *
 * pi 的 `AgentSessionEvent` 方言 → 平台的 `RuntimeEvent`。**翻译表**:
 *
 * | pi 方言 | RuntimeEvent | 备注 |
 * |---|---|---|
 * | `message_update`(assistantMessageEvent) | `message_update`(deltaKind 拍平) | text/thinking 两条流永不混流(7-I) |
 * | `message_end` | `message_end`(message 原样 unknown) | usage/stopReason 的读取容错在平台侧 |
 * | `tool_execution_start` | `tool_start` | |
 * | `tool_execution_end` | `tool_end`(result 是适配器工具协议方言) | |
 * | `auto_retry_start` / `auto_retry_end` | 同名 | |
 * | `agent_settled` / `agent_end` | 同名 | 回合收敛信号 |
 * | 其余(`message_start` / `queue_update` / `compaction_*` / `entry_appended`…) | **丢弃**(返回 null) | 平台不消费;要消费 = 先在这里加翻译 |
 *
 * 这里是**全仓唯一**读 pi 事件形状的地方(turn.ts 只认 RuntimeEvent)。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../types.js";

export function normalizeSessionEvent(ev: AgentSessionEvent): RuntimeEvent | null {
  switch (ev.type) {
    case "message_update": {
      // 宽容读取(平台「形状不认识不抛」的规矩):测试注入的裸事件 / SDK 变体
      // 没有 assistantMessageEvent 时,归 other,不让翻译器炸掉整条回合。
      const u = ev.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined;
      if (u !== undefined && u.type === "text_delta" && typeof u.delta === "string") {
        return { type: "message_update", deltaKind: "text", delta: u.delta };
      }
      if (u !== undefined && u.type === "thinking_delta" && typeof u.delta === "string") {
        return { type: "message_update", deltaKind: "thinking", delta: u.delta };
      }
      return { type: "message_update", deltaKind: "other" };
    }
    case "message_end":
      return { type: "message_end", message: ev.message };
    case "tool_execution_start":
      return {
        type: "tool_start",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        args: ev.args,
      };
    case "tool_execution_end":
      return {
        type: "tool_end",
        toolCallId: ev.toolCallId,
        toolName: ev.toolName,
        result: ev.result,
        isError: ev.isError,
      };
    case "auto_retry_start":
      return { type: "auto_retry_start" };
    case "auto_retry_end":
      return { type: "auto_retry_end" };
    case "agent_settled":
      return { type: "agent_settled" };
    case "agent_end":
      return { type: "agent_end" };
    default:
      return null;
  }
}
