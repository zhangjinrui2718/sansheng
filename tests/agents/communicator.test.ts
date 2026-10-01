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
import { describe, it, expect, beforeEach, vi } from "vitest";

// 顶层 mock 捕获 DefaultResourceLoader 构造 + createAgentSession 调用
// (为 ensureSession 测试验证 user-customized systemPrompt 流入 loader)
const __loaderCapture = vi.hoisted(() => ({
  loaderCalls: [] as Array<Record<string, unknown>>,
  sessionCalls: [] as Array<Record<string, unknown>>,
}));
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
    "@earendil-works/pi-coding-agent",
  );
  return {
    ...actual,
    DefaultResourceLoader: class {
      constructor(opts: any) {
        __loaderCapture.loaderCalls.push({ ...opts });
      }
    },
    createAgentSession: (opts: any) => {
      __loaderCapture.sessionCalls.push({ ...opts });
      return Promise.resolve({ session: { id: "stub-session", abort: () => {} } });
    },
  };
});

// mock providers/registry 让 resolveModel 返回 fake model,不走真实 LLM 加载
vi.mock("../../src/server/providers/registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/providers/registry.js")>(
    "../../src/server/providers/registry.js",
  );
  return {
    ...actual,
    resolveModel: () => ({ provider: "mock", id: "mock", baseUrl: "", headers: {} } as any),
  };
});
import { MessageBus } from "../../src/server/agents/messageBus.js";
import {
  Communicator,
  defaultCommunicatorDecide,
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

  // M3c regression:保证 user-customized systemPrompt 流入 DefaultResourceLoader
  it("ensureSession: custom systemPrompt flows to DefaultResourceLoader", async () => {
    __loaderCapture.loaderCalls.length = 0;
    __loaderCapture.sessionCalls.length = 0;
    const bus = new MessageBus();
    const CUSTOM = "CUSTOM_SYSTEM_PROMPT_FROM_USER";
    const comm = new Communicator({
      bus,
      settings: { provider: "mock", apiKey: "sk-mock", modelId: "mock", thinkingLevel: "off" },
      agentDir: "/tmp/agentdir/communicator",
      cwd: "/tmp",
      systemPrompt: CUSTOM,
      decideFn: async () => ({ kind: "reply", text: "x" }),
    });
    const session = await (comm as any).ensureSession();
    expect(session).toBeTruthy();
    // 验证 DefaultResourceLoader 用 user-customized systemPrompt 构造
    expect(__loaderCapture.loaderCalls.length).toBe(1);
    expect(__loaderCapture.loaderCalls[0].systemPrompt).toBe(CUSTOM);
    expect(__loaderCapture.loaderCalls[0].cwd).toBe("/tmp");
    expect(__loaderCapture.loaderCalls[0].agentDir).toBe("/tmp/agentdir/communicator");
    // 验证 createAgentSession 收到了 resourceLoader
    expect(__loaderCapture.sessionCalls.length).toBe(1);
    expect(__loaderCapture.sessionCalls[0].resourceLoader).toBeDefined();
  });
});

/**
 * 批次 5a · T2 — chat 双回复修复(docs/CODE-REVIEW-2026-10-01.md §B2)
 *
 * 旧行为:defaultCommunicatorDecide chat 分支产 canned「已收到:…」占位回复,
 * routeUserMessage 将其 sink(delta/done)+ bus broadcast;随后 kernel.prompt
 * 无条件 session.prompt(text) 产生 Pi 真回复 → 用户看到两条。
 *
 * 新行为:chat 路径只保留 Pi session 真回复 —— 默认 decide 不再产占位文本,
 * routeUserMessage 对空 reply 不 sink / 不 broadcast。
 * task 分支(broadcast + onTask + 确认 delta)行为不变;task 双执行留待批次 5b。
 */
describe("batch5a · B2 chat 双回复修复", () => {
  it("defaultCommunicatorDecide chat 分支不再产 canned「已收到」占位回复", async () => {
    const decision = await defaultCommunicatorDecide({
      userText: "你好呀",
      conversationId: "conv-b2",
    });
    expect(decision.kind).toBe("chat");
    if (decision.kind === "chat") {
      expect(decision.reply).not.toContain("已收到");
      // chat 占位回复清空 → kernel 里 Pi session 的真回复是唯一回复
      expect(decision.reply).toBe("");
    }
  });

  it("routeUserMessage chat 分支(默认 decide)不 sink 占位回复、不 broadcast", async () => {
    const bus = new MessageBus();
    const events: CommunicatorEvent[] = [];
    const sink: CommunicatorSink = (e) => events.push(e);
    // 不注入 decideFn → 走 defaultCommunicatorDecide(生产同路径)
    const comm = new Communicator({
      bus,
      settings: { provider: "fake", apiKey: "sk-fake", modelId: "fake", thinkingLevel: "off" },
      agentDir: "/tmp/agentdir/communicator",
      cwd: "/tmp",
      systemPrompt: "",
      disableLlm: true,
    });

    const decision = await comm.routeUserMessage("今天天气不错", "conv-b2", sink);
    expect(decision.kind).toBe("chat");

    // 无占位 delta/done —— chat 回复只来自 Pi session(kernel.prompt 后置调用)
    expect(events.filter((e) => e.type === "delta")).toHaveLength(0);
    expect(events.filter((e) => e.type === "done")).toHaveLength(0);
    // bus 上不再落「已收到」broadcast(timeline 不会出现占位气泡)
    expect(bus.size()).toBe(0);
    expect(events.filter((e) => e.type === "bus_event")).toHaveLength(0);
    // thinking 生命周期事件保留(UI 状态不受影响)
    const thinking = events.filter((e) => e.type === "thinking");
    expect(thinking.length).toBeGreaterThanOrEqual(2);
  });

  it("task 分支行为不变:broadcast 给 planner + onTask 仍被调 + 确认 delta 保留", async () => {
    const bus = new MessageBus();
    const events: CommunicatorEvent[] = [];
    const sink: CommunicatorSink = (e) => events.push(e);
    const onTask = vi.fn();
    const comm = new Communicator({
      bus,
      settings: { provider: "fake", apiKey: "sk-fake", modelId: "fake", thinkingLevel: "off" },
      agentDir: "/tmp/agentdir/communicator",
      cwd: "/tmp",
      systemPrompt: "",
      disableLlm: true,
      onTask,
    });

    // 用默认 decide:「重构 X 模块」命中 task 正则(生产同路径)
    const decision = await comm.routeUserMessage("重构 X 模块", "conv-b2", sink);
    expect(decision.kind).toBe("task");

    // broadcast 给 planner 不变
    expect(bus.size()).toBe(1);
    const m = bus.snapshot()[0]!;
    expect(m.kind).toBe("broadcast");
    expect(m.toRole).toBe("planner");
    expect(m.payload).toBe("重构 X 模块");
    // onTask 仍被调(task 双执行问题留待批次 5b,见 §B2;本批次不动)
    expect(onTask).toHaveBeenCalledTimes(1);
    expect(onTask).toHaveBeenCalledWith({ goal: "重构 X 模块", conversationId: "conv-b2" });
    // 用户确认 delta 保留
    const deltas = events.filter((e) => e.type === "delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as Extract<CommunicatorEvent, { type: "delta" }>).text).toContain("收到任务");
  });
});