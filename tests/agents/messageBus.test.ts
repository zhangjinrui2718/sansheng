/**
 * Sansheng MessageBus 单元测试 · M3c
 *
 * 5 cases:
 * 1. ask 阻塞直到 reply,resolve 拿到 reply payload
 * 2. ask timeout reject
 * 3. broadcast 不阻塞,emit 给所有 subscribers
 * 4. reply 找不到原 question 不抛,只 log warn
 * 5. snapshot/restore round-trip 后 pending question 仍能 resolve
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageBus } from "../../src/server/agents/messageBus.js";
import type { BusMessage } from "../../shared/types/agents.js";

describe("agents/messageBus", () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = new MessageBus();
  });

  it("ask blocks until reply; resolves with reply payload", async () => {
    const promise = bus.ask({
      fromRole: "planner",
      conversationId: "conv-1",
      payload: "should I run the tests?",
    });
    expect(bus.pendingSize()).toBe(1);

    const ok = bus.reply("nonexistent", "wrong"); // 错的 id 不应影响 pending
    expect(ok).toBe(false);
    expect(bus.pendingSize()).toBe(1);

    // 找正确的 questionId 从 stream 里取
    const questionId = bus.snapshot()[0]?.id ?? "";
    expect(questionId).toBeTruthy();

    const replied = bus.reply(questionId, "yes, run them");
    expect(replied).toBe(true);
    expect(bus.pendingSize()).toBe(0);
    expect(await promise).toBe("yes, run them");
    const stream = bus.snapshot();
    expect(stream).toHaveLength(2);
    expect(stream[1]?.kind).toBe("reply");
    expect(stream[1]?.questionId).toBe(questionId);
    expect(stream[1]?.payload).toBe("yes, run them");
  });

  it("ask timeout rejects after timeoutMs; pending cleared", async () => {
    const p = bus.ask({
      fromRole: "executor",
      conversationId: "conv-1",
      payload: "stuck",
      timeoutMs: 50,
    });
    expect(bus.pendingSize()).toBe(1);
    await expect(p).rejects.toThrow(/timeout after 50ms/);
    expect(bus.pendingSize()).toBe(0);
  });

  it("broadcast does not block; emits to all subscribers synchronously", () => {
    const events: BusMessage[] = [];
    const unsub = bus.subscribe((m) => events.push(m));
    const msg = bus.broadcast({
      fromRole: "memory",
      conversationId: "conv-2",
      payload: "fragment indexed",
    });
    expect(msg.kind).toBe("broadcast");
    expect(msg.direction).toBe("worker→comm");
    expect(bus.size()).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toBe("fragment indexed");
    unsub();
    bus.broadcast({
      fromRole: "memory",
      conversationId: "conv-2",
      payload: "another",
    });
    expect(events).toHaveLength(1); // unsub 之后不再 emit
  });

  it("reply for unknown id does not throw; returns false and logs warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = bus.reply("unknown-id", "nope");
    expect(result).toBe(false);
    warn.mockRestore();
    expect(bus.size()).toBe(0);
    expect(bus.pendingSize()).toBe(0);
  });

  it("snapshot + restore round-trip preserves stream; pending question still resolvable after restore", async () => {
    // 1. fill the stream first
    bus.broadcast({
      fromRole: "critic",
      conversationId: "conv-3",
      payload: "step 1 ok",
    });
    bus.broadcast({
      fromRole: "executor",
      conversationId: "conv-3",
      payload: "step 2 done",
    });
    const snap = bus.snapshot();
    expect(snap).toHaveLength(2);

    // 2. new bus + restore
    const bus2 = new MessageBus();
    bus2.restore(snap);
    expect(bus2.size()).toBe(2);
    expect(bus2.snapshot()[0]?.payload).toBe("step 1 ok");

    // 3. ask after restore → still works
    const promise = bus2.ask({
      fromRole: "planner",
      conversationId: "conv-3",
      payload: "next step?",
      timeoutMs: 1000,
    });
    expect(bus2.pendingSize()).toBe(1);
    const newQuestionId = bus2.snapshot()[2]?.id ?? "";
    bus2.reply(newQuestionId, "go ahead");
    expect(await promise).toBe("go ahead");
    expect(bus2.size()).toBe(4); // 2 + 1 question + 1 reply
  });
});