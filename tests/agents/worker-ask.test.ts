/**
 * 批次 7-L · worker 提问的判断轮
 *
 * 用户 2026-10-03 原话(总线升级里看到的):
 * 「总线实际的功能是用于 agent 之间做信息交互的,意思就是沟通员和后面几个
 * 干活的 agent 做信息交互,worker 升级了问题,应该要问的是沟通员,而不是用户,
 * 如果沟通员解决不了,那么沟通员负责和我沟通,让我判断决策。另外要说的是,
 * 不要所有的问题都要我来回答,沟通员需要根据和我对齐的信息,先判断一轮。」
 *
 * 7-L 之前这条链路是:executor → kernel 硬编码 knowIt=false → 直接问用户。
 * 「沟通员先自己判一轮」写在提示词里,但代码里从未执行过 —— 提示词在骗人。
 *
 * 本文件守的是那条链路的三个岔口:
 *   1. 判断轮答得了 → 用户**零打扰**,执行者照常被 decision 恢复;
 *   2. 判断轮答不了 → 升级的是**沟通员自己起的 q-comm-***,fromRole=communicator;
 *   3. 判断轮缺席 / 抛错 / 解析不出来 → 退回 7-L 之前的行为(不卡死执行者)。
 */
import { describe, it, expect, vi } from "vitest";

import { MessageBus } from "../../src/server/agents/messageBus.js";
import {
  Communicator,
  parseWorkerAskVerdict,
  type CommunicatorEvent,
  type CommunicatorSink,
  type WorkerAskAdjudicateFn,
} from "../../src/server/agents/communicator.js";
import type { BusMessage, CommunicatorDecision } from "../../shared/types/agents.js";

function makeComm(extra?: { workerAskAdjudicate?: WorkerAskAdjudicateFn | null }) {
  const bus = new MessageBus();
  const events: CommunicatorEvent[] = [];
  const sink: CommunicatorSink = (e) => events.push(e);
  const comm = new Communicator({
    bus,
    settings: { provider: "fake", apiKey: "sk-fake", modelId: "fake", thinkingLevel: "off" },
    agentDir: "/tmp/agentdir/communicator",
    cwd: "/tmp",
    systemPrompt: "",
    decideFn: async (): Promise<CommunicatorDecision> => ({ kind: "chat", reply: "" }),
    disableLlm: true,
    ...(extra ?? {}),
  });
  return { bus, comm, events, sink };
}

/** 一条 executor 提问(kernel 用 recordExternal 合成的那种)。 */
function workerQuestion(bus: MessageBus, payload = "问题正文", reason = "judgment"): BusMessage {
  return bus.recordExternal({
    id: "q-exec-test01",
    ts: Date.now(),
    direction: "worker→comm",
    fromRole: "executor",
    toRole: "communicator",
    conversationId: "conv-1",
    kind: "question",
    payload,
    context: { todoId: "todo-3", hypothesisId: "hyp-1", reason, executorSessionId: "exec-1" },
  });
}

describe("批次 7-L · 判断轮:沟通员自己答", () => {
  it("verdict=answer → 不发 pending_question,用户零打扰", async () => {
    const { bus, comm, events, sink } = makeComm({
      workerAskAdjudicate: async () => ({
        kind: "answer",
        answer: "按方案 A 走,命名沿用现有约定。",
        basis: "方案 B 要改三处调用点,代价明显更大。",
      }),
    });
    workerQuestion(bus);
    const answered: Array<[string, string]> = [];
    const escalated: string[] = [];

    const res = await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {
      onAnswer: (qid, a) => answered.push([qid, a]),
      onEscalate: (qid) => escalated.push(qid),
    });

    expect(res.replied).toBe(true);
    // 用户侧零事件:没有任何 pending_question
    expect(events.filter((e) => e.type === "pending_question")).toHaveLength(0);
    expect(escalated).toEqual([]);
    // 答案确实下发了,而且是挂在**执行者那条问题**上
    expect(answered).toEqual([["q-exec-test01", "按方案 A 走,命名沿用现有约定。"]]);
  });

  it("verdict=answer → 总线上留下一条 comm→worker 的 reply(可审计)", async () => {
    const { bus, comm, sink } = makeComm({
      workerAskAdjudicate: async () => ({ kind: "answer", answer: "就这么定。", basis: "上下文够。" }),
    });
    workerQuestion(bus);
    await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {});

    const reply = bus.snapshot().find((m) => m.kind === "reply");
    expect(reply).toBeTruthy();
    expect(reply?.fromRole).toBe("communicator");
    expect(reply?.toRole).toBe("executor");
    expect(reply?.direction).toBe("comm→worker");
    expect(reply?.questionId).toBe("q-exec-test01");
  });

  it("判断轮拿到了执行者问题的全文(不是一句摘要)—— 没有全文就无从判断", async () => {
    let seen = "";
    const { bus, comm, sink } = makeComm({
      workerAskAdjudicate: async (input) => {
        seen = input.question;
        return { kind: "answer", answer: "a", basis: "b" };
      },
    });
    workerQuestion(bus, "要不要把 executor 升级改成 executor→comm→user?");
    await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {});
    expect(seen).toContain("executor→comm→user");
  });
});

describe("批次 7-L · 判断轮:升级给用户", () => {
  it("verdict=escalate → 问用户的是**沟通员新起的问题**,不是执行者那条", async () => {
    const { bus, comm, sink } = makeComm({
      workerAskAdjudicate: async () => ({
        kind: "escalate",
        question: "删掉旧数据这一步,你确定要现在做吗?",
        lean: "我倾向先跑 dry-run。",
        ruledOut: "已经排除:直接重跑任务(同样不可逆,且更慢)。",
      }),
    });
    workerQuestion(bus);
    const escalated: string[] = [];

    const res = await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {
      onEscalate: (qid) => escalated.push(qid),
    });

    expect(res.replied).toBe(false);
    expect(res.questionId).not.toBe("q-exec-test01");
    expect(res.questionId).toMatch(/^q-comm-/);
    // 用户回答的是沟通员的问题 → 登记的必须是这个新 id
    expect(escalated).toEqual([res.questionId]);
  });

  it("pending_question.fromRole 是 communicator,不是 executor", async () => {
    const { bus, comm, events, sink } = makeComm({
      workerAskAdjudicate: async () => ({
        kind: "escalate",
        question: "这一刀要不要落?",
        lean: "倾向落。",
        ruledOut: "已排除 B。",
      }),
    });
    workerQuestion(bus);
    await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {});

    const pending = events.find((e) => e.type === "pending_question") as
      | Extract<CommunicatorEvent, { type: "pending_question" }>
      | undefined;
    expect(pending?.fromRole).toBe("communicator");
  });

  it("给用户看的是沟通员自己写的问法 + 倾向 + 已排除项(不是转述执行者原话)", async () => {
    const { bus, comm, events, sink } = makeComm({
      workerAskAdjudicate: async () => ({
        kind: "escalate",
        question: "这一刀要不要落?",
        lean: "我倾向落。",
        ruledOut: "已排除 B。",
      }),
    });
    workerQuestion(bus, "执行者的原始问法");
    await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {});

    const pending = events.find((e) => e.type === "pending_question") as
      | Extract<CommunicatorEvent, { type: "pending_question" }>
      | undefined;
    expect(pending?.payload).toContain("这一刀要不要落?");
    expect(pending?.payload).toContain("我倾向落。");
    expect(pending?.payload).toContain("已排除 B。");
    // 关键:用户看到的不是执行者的原话
    expect(pending?.payload).not.toContain("执行者的原始问法");
  });

  it("总线上留下 comm→user 的 question(审计流如实记录两级交互)", async () => {
    const { bus, comm, sink } = makeComm({
      workerAskAdjudicate: async () => ({
        kind: "escalate",
        question: "要授权吗?",
        lean: "要。",
        ruledOut: "无。",
      }),
    });
    workerQuestion(bus);
    const res = await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {});

    const commToUser = bus.snapshot().find((m) => m.direction === "comm→user" && m.kind === "question");
    expect(commToUser).toBeTruthy();
    expect(commToUser?.id).toBe(res.questionId);
    expect(commToUser?.fromRole).toBe("communicator");
    expect(commToUser?.toRole).toBe("user");
    expect(commToUser?.context?.["workerQuestionId"]).toBe("q-exec-test01");
  });
});

describe("批次 7-L · 退化路径:永远不能把执行者卡死", () => {
  it("没有注入判断轮 → 退回 7-L 之前的行为(原样升级,q-exec-* 不变)", async () => {
    const { bus, comm, events, sink } = makeComm({ workerAskAdjudicate: null });
    workerQuestion(bus, "破坏性操作,需要确认");
    const res = await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {});

    expect(res.replied).toBe(false);
    expect(res.questionId).toBe("q-exec-test01");
    const pending = events.find((e) => e.type === "pending_question") as
      | Extract<CommunicatorEvent, { type: "pending_question" }>
      | undefined;
    expect(pending?.fromRole).toBe("executor");
    expect(pending?.payload).toBe("破坏性操作,需要确认");
  });

  it("判断轮抛错 → 退回升级,执行者仍可被用户救回来", async () => {
    const { bus, comm, sink } = makeComm({
      workerAskAdjudicate: async () => {
        throw new Error("provider 炸了");
      },
    });
    workerQuestion(bus);
    const res = await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {});
    expect(res.replied).toBe(false);
    expect(res.questionId).toBe("q-exec-test01");
  });

  it("onAnswer 抛错不影响 handleWorkerAsk 返回(宿主的问题不外溢)", async () => {
    const { bus, comm, sink } = makeComm({
      workerAskAdjudicate: async () => ({ kind: "answer", answer: "a", basis: "b" }),
    });
    workerQuestion(bus);
    const res = await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {
      onAnswer: () => {
        throw new Error("kernel 写库失败");
      },
    });
    expect(res.replied).toBe(true);
  });

  it("knowIt=true 的老路径不受影响(bus.ask 建的 pending 照常 resolve)", async () => {
    const { bus, comm, sink } = makeComm({
      workerAskAdjudicate: async () => ({
        kind: "escalate",
        question: "不该走到这",
        lean: "",
        ruledOut: "",
      }),
    });
    const p = bus.ask({ fromRole: "executor", conversationId: "conv-1", payload: "需要 API key 吗?" });
    await comm.handleWorkerAsk(bus.snapshot()[0]!, true, "不需要,settings 里有", sink, {});
    expect(await p).toBe("不需要,settings 里有");
  });
});

describe("批次 7-L · parseWorkerAskVerdict", () => {
  it("answer 分支", () => {
    expect(parseWorkerAskVerdict('{"verdict":"answer","answer":"走 A","basis":"B 更贵"}')).toEqual({
      kind: "answer",
      answer: "走 A",
      basis: "B 更贵",
    });
  });

  it("escalate 分支(lean / ruledOut 缺省时不带键)", () => {
    expect(
      parseWorkerAskVerdict('{"verdict":"escalate","question":"要不要?","lean":"要","ruledOut":"排除 B"}'),
    ).toEqual({ kind: "escalate", question: "要不要?", lean: "要", ruledOut: "排除 B" });
    expect(parseWorkerAskVerdict('{"verdict":"escalate","question":"要不要?"}')).toEqual({
      kind: "escalate",
      question: "要不要?",
    });
  });

  it("带 markdown 围栏 / 前后废话也能解析(jsonRepair 兜底)", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const raw = ["好的,我判断如下:", fence + "json", '{"verdict":"answer","answer":"走 A","basis":"x"}', fence].join("\n");
    expect(parseWorkerAskVerdict(raw)?.kind).toBe("answer");
  });

  it("以下情形一律 null(调用方据此退回升级,绝不凭空编答案)", () => {
    expect(parseWorkerAskVerdict("")).toBeNull();
    expect(parseWorkerAskVerdict("我不知道")).toBeNull();
    expect(parseWorkerAskVerdict('{"verdict":"answer"}')).toBeNull(); // 没有 answer
    expect(parseWorkerAskVerdict('{"verdict":"answer","answer":"  "}')).toBeNull();
    expect(parseWorkerAskVerdict('{"verdict":"escalate"}')).toBeNull(); // 没有 question
    expect(parseWorkerAskVerdict('{"verdict":"ask_user"}')).toBeNull(); // 不认识的 verdict
  });

  it("调用方:adjudicate 返回 null → 升级,且不产生 answer", async () => {
    const onAnswer = vi.fn();
    const onEscalate = vi.fn();
    const { bus, comm, sink } = makeComm();
    workerQuestion(bus);
    const res = await comm.handleWorkerAsk(bus.snapshot()[0]!, false, "", sink, {
      adjudicate: async () => null,
      onAnswer,
      onEscalate,
    });
    expect(res.replied).toBe(false);
    expect(onAnswer).not.toHaveBeenCalled();
    expect(onEscalate).toHaveBeenCalledOnce();
  });
});
