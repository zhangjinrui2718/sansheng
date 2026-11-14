/**
 * pi 适配器 · 事件翻译(A2,2026-11-14)
 *
 * turn.ts 只认 `RuntimeEvent`;pi 方言在这里翻译。钉住的判据:
 *   · 嵌套拍平:`message_update.assistantMessageEvent` → `deltaKind`;
 *   · 两条流永不混流(7-I):text 与 thinking 是两个不同的事件种类;
 *   · 宽容读取:裸 `message_update`(没有 assistantMessageEvent)归 `other`,
 *     **不抛** —— 翻译器炸掉整条回合是最大的事故面;
 *   · 工具事件改名:`tool_execution_start/end` → `tool_start/tool_end`,
 *     toolCallId / toolName / args / result / isError 逐字段保真;
 *   · 未知方言事件被**丢弃**(返回 null)—— 丢弃是适配器的决定。
 */
import { describe, it, expect } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { normalizeSessionEvent } from "../../src/platform/runtime/agentRuntime/pi/events.js";
import type { RuntimeEvent } from "../../src/platform/runtime/agentRuntime/types.js";

const pi = (ev: unknown): AgentSessionEvent => ev as AgentSessionEvent;

describe("normalizeSessionEvent:pi 方言 → RuntimeEvent", () => {
  it("text_delta 拍平为 message_update/deltaKind:text", () => {
    const r = normalizeSessionEvent(pi({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "你好" },
    }));
    expect(r).toEqual({ type: "message_update", deltaKind: "text", delta: "你好" });
  });

  it("thinking_delta → deltaKind:thinking(两条流永不混流)", () => {
    const r = normalizeSessionEvent(pi({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "内部推理" },
    }));
    expect(r).toMatchObject({ deltaKind: "thinking", delta: "内部推理" });
  });

  it("裸 message_update(无 assistantMessageEvent)⇒ other,**不抛**", () => {
    const r = normalizeSessionEvent(pi({ type: "message_update" }));
    expect(r).toEqual({ type: "message_update", deltaKind: "other" });
  });

  it("message_end:message 原样透传(usage/stopReason 的值形状容错在平台侧)", () => {
    const message = {
      role: "assistant", stopReason: "error", errorMessage: "429",
      usage: { input: 3, output: 5, cacheRead: 0 },
    };
    const r = normalizeSessionEvent(pi({ type: "message_end", message }));
    expect(r).toEqual({ type: "message_end", message });
  });

  it("工具事件改名 + 字段保真", () => {
    const start = normalizeSessionEvent(pi({
      type: "tool_execution_start", toolCallId: "tc1", toolName: "board_write", args: { a: 1 },
    }));
    expect(start).toEqual({ type: "tool_start", toolCallId: "tc1", toolName: "board_write", args: { a: 1 } });
    const result = { content: [{ type: "text", text: "ok" }], details: { ok: true } };
    const end = normalizeSessionEvent(pi({
      type: "tool_execution_end", toolCallId: "tc1", toolName: "board_write", result, isError: false,
    }));
    expect(end).toEqual({ type: "tool_end", toolCallId: "tc1", toolName: "board_write", result, isError: false });
  });

  it("agent_settled / agent_end / auto_retry_* 同名透传", () => {
    for (const type of ["agent_settled", "agent_end", "auto_retry_start", "auto_retry_end"]) {
      expect(normalizeSessionEvent(pi({ type }))).toEqual({ type });
    }
  });

  it("未知方言事件(message_start / queue_update / compaction_*)⇒ 丢弃(null)", () => {
    for (const type of ["message_start", "queue_update", "compaction_start", "entry_appended"]) {
      expect(normalizeSessionEvent(pi({ type }))).toBeNull();
    }
  });
});
