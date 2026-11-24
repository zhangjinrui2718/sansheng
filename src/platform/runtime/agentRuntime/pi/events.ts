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
 * | `tool_execution_update` | `tool_update`(不带载荷) | 2026-11-25:看门狗的「还在动」信号 |
 * | `message_start`(**仅用户**) | `user_message_start`(正文拼接) | 2026-11-25:补话的送达回执;助手的仍丢弃 |
 * | `queue_update` | `queue_update`(两份队列快照) | 2026-11-25:算这次补进去的实际文本 |
 * | `auto_retry_start` / `auto_retry_end` | 同名 | |
 * | `agent_settled` / `agent_end` | 同名 | 回合收敛信号 |
 * | 其余(助手的 `message_start` / `compaction_*` / `entry_appended`…) | **丢弃**(返回 null) | 平台不消费;要消费 = 先在这里加翻译 |
 *
 * 这里是**全仓唯一**读 pi 事件形状的地方(turn.ts 只认 RuntimeEvent)。
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../types.js";

/**
 * 用户消息的正文:字符串,或内容块里 `text` 部分的**直接拼接** —— 与 SDK 认补话
 * 回执的拼法一致(`pi-ai` 的 `contentText`),否则逐字比对永远对不上。
 */
function userTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (p !== null && typeof p === "object" && (p as { type?: unknown }).type === "text") {
      const t = (p as { text?: unknown }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("");
}

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
    // 持续输出(2026-11-25):只留「还在动」这个事实,不带载荷。
    case "tool_execution_update":
      return { type: "tool_update", toolCallId: ev.toolCallId, toolName: ev.toolName };
    // 补话的送达回执(2026-11-25):**只翻用户的那一条** —— 它是「补进去的话真的
    // 开始了」的唯一凭据。助手的 message_start 仍然丢弃(平台自己另行广播)。
    case "message_start":
      // 形状不认识(没有 message)不抛 —— 翻译器炸掉整条回合是最大的事故面。
      if (ev.message?.role !== "user") return null;
      return { type: "user_message_start", text: userTextOf(ev.message.content) };
    // 补话队列的快照(2026-11-25):平台靠它算出这次补进去的实际文本。
    case "queue_update":
      return {
        type: "queue_update",
        steering: [...(ev.steering ?? [])],
        followUp: [...(ev.followUp ?? [])],
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
