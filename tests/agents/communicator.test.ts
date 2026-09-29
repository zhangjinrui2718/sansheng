/**
 * Sansheng Communicator 单元测试 · M3c
 *
 * 5 cases(用 FakeCommunicatorRunner 注入 decideFn):
 * 1. 「你好」→ 自己答,不触发 planner
 * 2. 「重构 X」→ bus.broadcast 给 planner
 * 3. Worker raise + knowIt=true → reply 自己答
 * 4. Worker raise + knowIt=false → emit pending_question 升级
 * 5. answer_question 回来 → reply 给 worker,worker 解阻塞继续
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MessageBus } from "../../src/server/agents/messageBus.js";
import {
  Communicator,
  type CommunicatorSink,
  type CommunicatorEvent,
} from "../../src/server/agents/communicator.js";
import type {
  CommunicatorDecision,
  BusMessage,
  RoleId,
} from "../../shared/types/agents.js";

function makeCommunicator(
  decideFn: (input: { userText: string; conversationId: string }) => Promise<CommunicatorDecision>,
) {
  const bus = new MessageBus();
  const events: CommunicatorEvent[] = [];
  const sink: CommunicatorSink = (e) => events.push(e);
  const comm = new Communicator({
    bus,
    settings: { provider: "fake", apiKey: "sk-fake", modelId: "fake", thinkingLevel: "off" },
    agentDir: "/tmp/agentdir/communicator",
    cwd: "/tmp",
    systemPrompt: "",
    decideFn,
    disableLlm: true,
  });
  return { bus, comm, events, sink };
}

describe("agents/communicator", () => {
  let captured: any[];

  beforeEach(() => {
    captured = [];
  });

  it("chat: '你好' → 自己答,不触发 planner", async () => {
    const { comm, bus, events } = makeCommunicator(async (i) => {
      captured.push({ input: i });
      return { kind: "chat", reply: "你好,我是三生" };
    });
    const decision = await comm.routeUserMessage("你好", "conv-1", (e) => events.push(e));
    expect(decision.kind).toBe("chat");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.input?.userText).toBe("你好");

    // sink 应当收到:thinking→delta→done→bus_event→thinking idle
    const types = events.map((e) => e.type);
    expect(types).toContain("delta");
    expect(types).toContain("done");

    // bus 上应有 1 条 broadcast(comm→user)
    expect(bus.size()).toBe(1);
    const m = bus.snapshot()[0]!;
    expect(m.kind).toBe("broadcast");
    expect(m.fromRole).toBe("communicator");
    expect(m.toRole).toBe("user");
    expect(m.payload).toBe("你好,我是三生");
  });

  it("task: '重构 X' → bus.broadcast 给 planner(不进 chat 流)", async () => {
    const { comm, bus, events } = makeCommunicator(async () => ({
      kind: "task",
      goal: "重构 X 模块",
    }));
    const decision = await comm.routeUserMessage("重构 X", "conv-1", (e) => events.push(e));
    expect(decision.kind).toBe("task");
    if (decision.kind === "task") expect(decision.goal).toBe("重构 X 模块");

    // bus 1 条 broadcast,toRole=planner
    expect(bus.size()).toBe(1);
    const m = bus.snapshot()[0]!;
    expect(m.toRole).toBe("planner");
    expect(m.payload).toBe("重构 X 模块");

    // sink 收到 bus_event + thinking→idle,但不应有 chat delta
    const types = events.map((e) => e.type);
    expect(types).toContain("bus_event");
    expect(types).toContain("delta"); // comm 给用户一个简短确认
    const dsevent = events.find((e) => e.type === "bus_event") as
      | Extract<CommunicatorEvent, { type: "bus_event" }>
      | undefined;
    expect(dsevent?.message.toRole).toBe("planner");
  });

  it("handleWorkerAsk + knowIt=true → reply 自己答,worker 解阻塞", async () => {
    const { comm, bus } = makeCommunicator(async () => ({ kind: "chat", reply: "" }));
    // 1. 先模拟 worker 发 ask
    const promise = bus.ask({
      fromRole: "executor",
      conversationId: "conv-1",
      payload: "需要 API key 吗?",
    });
    const questionId = bus.snapshot()[0]?.id ?? "";
    expect(questionId).toBeTruthy();
    const questionMsg = bus.snapshot()[0]!;

    // 2. comm 处理:knowIt=true,自己答
    const result = await comm.handleWorkerAsk(
      questionMsg as BusMessage,
      true,
      "不需要,settings 里有",
      () => {},
    );
    expect(result.replied).toBe(true);

    // 3. worker 应解阻塞
    const reply = await promise;
    expect(reply).toBe("不需要,settings 里有");
    expect(bus.size()).toBe(2); // question + reply
    const replyMsg = bus.snapshot()[1]!;
    expect(replyMsg.kind).toBe("reply");
    expect(replyMsg.questionId).toBe(questionId);
    expect(replyMsg.fromRole).toBe("communicator");
  });

  it("handleWorkerAsk + knowIt=false → emit pending_question,worker 仍阻塞", async () => {
    const { comm, bus } = makeCommunicator(async () => ({ kind: "chat", reply: "" }));
    const events: CommunicatorEvent[] = [];
    const promise = bus.ask({
      fromRole: "planner",
      conversationId: "conv-1",
      payload: "破坏性操作,需要确认",
    });
    const questionMsg = bus.snapshot()[0]!;

    const result = await comm.handleWorkerAsk(
      questionMsg as BusMessage,
      false,
      "",
      (e) => events.push(e),
    );
    expect(result.replied).toBe(false);
    expect(result.questionId).toBe(questionMsg.id);

    // sink 应收到 pending_question
    const pending = events.find((e) => e.type === "pending_question") as
      | Extract<CommunicatorEvent, { type: "pending_question" }>
      | undefined;
    expect(pending).toBeTruthy();
    expect(pending?.questionId).toBe(questionMsg.id);
    expect(pending?.payload).toBe("破坏性操作,需要确认");
    expect(pending?.fromRole).toBe("planner");

    // worker promise 仍 pending(用 setTimeout 检查)
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
    expect(bus.pendingSize()).toBe(1);
  });

  it("answer_question 回来 → comm.reply 给 worker → worker promise resolve", async () => {
    const { comm, bus } = makeCommunicator(async () => ({ kind: "chat", reply: "" }));
    const events: CommunicatorEvent[] = [];

    // 1. worker ask
    const workerPromise = bus.ask({
      fromRole: "executor",
      conversationId: "conv-1",
      payload: "可以重启服务吗?",
    });
    const questionMsg = bus.snapshot()[0]!;

    // 2. comm 不知道 → 升级
    await comm.handleWorkerAsk(
      questionMsg as BusMessage,
      false,
      "",
      (e) => events.push(e),
    );
    expect(bus.pendingSize()).toBe(1);

    // 3. 用户回话 → comm.answerPending(模拟 ws 桥接)
    const ok = comm.answerPending(questionMsg.id, "可以,去重启吧");
    expect(ok).toBe(true);

    // 4. worker promise resolve
    const reply = await workerPromise;
    expect(reply).toBe("可以,去重启吧");
    expect(bus.size()).toBe(2); // question + reply
    expect(bus.pendingSize()).toBe(0);

    // 5. sink 至少收到 pending_question
    expect(events.some((e) => e.type === "pending_question")).toBe(true);
  });
});