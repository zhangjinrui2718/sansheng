/**
 * 批次 5b-1 · P1 — decide 升级 LLM(正则启发式降级兜底)单测
 *
 * 契约(jev A 方案,用户提议 + jev 裁决 conf 1.00):
 *  - 新工厂 `makeLlmCommunicatorDecide(opts)`(src/server/agents/communicator.ts)
 *    返回 CommunicatorDecideFn:有模型时用 completeSimple(ws.ts makeLlmCall 同款
 *    模式)跑微型分类 prompt,输出严格 JSON
 *    `{"kind":"chat"|"task"|"feedback","taskGoal":"...","ack":"..."}`。
 *  - 解析失败 / 超时(默认 ≤4s,可配)/ 无模型 / 显式关闭(SANSHENG_DECIDE_LLM=0)
 *    → 降级 defaultCommunicatorDecide 正则启发式(保留,不删)。
 *  - DI seam:opts.llmCall 注入 fake(参照 AttachOptions.llmCallFactory 模式),
 *    注入时绕过模型/开关闸门(显式注入 = 显式测试意图,不走网络)。
 *  - 分类输入 = 用户 raw 消息 + 可选最近少量上下文(opts.recentHistory,
 *    ≤3 条、每条截断 80 字符 —— 消歧「继续/再跑一次」类省略句,延迟代价可忽略)。
 *
 * RED(基线 49d31ed):makeLlmCommunicatorDecide 不存在 → 全部 it 红。
 * 附:decide 延迟实测(injected-llm / fallback 两路径,stdout 打点,供批次报告)。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as communicatorMod from "../../src/server/agents/communicator.js";
import type { CommunicatorDecision } from "../../shared/types/agents.js";

/* ── mock pi-ai/compat 的 completeSimple(生产 decide 的真实 LLM 出口)── */
const __compat = vi.hoisted(() => ({
  calls: [] as Array<{ model: unknown; context: Record<string, unknown>; options: Record<string, unknown> }>,
  reply: null as null | {
    stopReason?: string;
    errorMessage?: string;
    content: Array<{ type: string; text?: string }>;
  },
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: async (
    model: unknown,
    context: Record<string, unknown>,
    options: Record<string, unknown>,
  ) => {
    __compat.calls.push({ model, context, options });
    if (__compat.reply) return __compat.reply;
    return { stopReason: "error", errorMessage: "no reply configured", content: [] };
  },
}));

/* ── 被测工厂(基线不存在 → undefined → 各 it 以清晰断言跑红)── */
interface DecideLlmOptions {
  getModel: () => unknown;
  llmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  timeoutMs?: number;
  fallback?: (input: { userText: string; conversationId: string }) => Promise<CommunicatorDecision>;
  recentHistory?: (conversationId: string) => Array<{ role: "user" | "assistant"; content: string }>;
}
type DecideFn = (input: { userText: string; conversationId: string }) => Promise<CommunicatorDecision>;

const factory = (communicatorMod as Record<string, unknown>)
  .makeLlmCommunicatorDecide as ((opts: DecideLlmOptions) => DecideFn) | undefined;

function makeDecide(opts: DecideLlmOptions): DecideFn {
  if (typeof factory !== "function") {
    throw new Error(
      "RED: communicator.ts 尚未导出 makeLlmCommunicatorDecide(批次 5b-1 P1 未实现)",
    );
  }
  return factory(opts);
}

const FAKE_MODEL = { provider: "openai", id: "gpt-4o-mini" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const textReply = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }] });

let savedGate: string | undefined;

beforeEach(() => {
  __compat.calls.length = 0;
  __compat.reply = null;
  savedGate = process.env.SANSHENG_DECIDE_LLM;
  // 默认清掉闸门,让「有模型 → 真走 completeSimple(mock)」路径可测
  delete process.env.SANSHENG_DECIDE_LLM;
});

afterEach(() => {
  if (savedGate === undefined) delete process.env.SANSHENG_DECIDE_LLM;
  else process.env.SANSHENG_DECIDE_LLM = savedGate;
});

describe("batch5b-1 P1 · makeLlmCommunicatorDecide(LLM 分类 + 正则降级)", () => {
  it("工厂已导出", () => {
    expect(factory).toBeTypeOf("function");
  });

  it("task:严格 JSON → kind=task,goal=taskGoal,ack 透传;分类 prompt 含 raw 消息", async () => {
    const seen: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async (i) => {
        seen.push(i);
        return JSON.stringify({
          kind: "task",
          taskGoal: "TG-MARK 重构 X 模块",
          ack: "ACK-MARK 已转入规划执行链路。",
        });
      },
    });
    const d = await decide({ userText: "帮我重构 X 模块", conversationId: "conv-p1" });
    expect(d.kind).toBe("task");
    if (d.kind === "task") {
      expect(d.goal).toBe("TG-MARK 重构 X 模块");
      expect(d.ack).toBe("ACK-MARK 已转入规划执行链路。");
    }
    // 分类 prompt:system 要求严格 JSON;user 段含 raw 原文
    expect(seen).toHaveLength(1);
    expect(seen[0]!.systemPrompt).toContain("JSON");
    expect(seen[0]!.systemPrompt).toContain("chat");
    expect(seen[0]!.systemPrompt).toContain("task");
    expect(seen[0]!.systemPrompt).toContain("feedback");
    expect(seen[0]!.userPrompt).toContain("帮我重构 X 模块");
  });

  it("chat:kind=chat → reply 空串(直答仍由 Pi session 负责,不产 canned 文本)", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () => JSON.stringify({ kind: "chat", taskGoal: "", ack: "" }),
    });
    const d = await decide({ userText: "你好呀", conversationId: "conv-p1" });
    expect(d.kind).toBe("chat");
    if (d.kind === "chat") expect(d.reply).toBe("");
  });

  it("feedback:kind=feedback → profileDelta 在场 + ack 透传", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () =>
        JSON.stringify({ kind: "feedback", taskGoal: "", ack: "ACK-FB 已收录。" }),
    });
    const d = await decide({ userText: "记住:我喜欢绿茶", conversationId: "conv-p1" });
    expect(d.kind).toBe("feedback");
    if (d.kind === "feedback") {
      expect(Object.keys(d.profileDelta).length).toBeGreaterThan(0);
      expect(d.ack).toBe("ACK-FB 已收录。");
    }
  });

  it("clarify:kind=clarify → question 透传(批次 7-C)", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () =>
        JSON.stringify({
          kind: "clarify",
          taskGoal: "",
          ack: "",
          question: "你说的『百外』是指面向百万用户规模的业务场景吗?",
        }),
    });
    const d = await decide({
      userText: "调研一份能够服务百外用户的语音机器人技术方案",
      conversationId: "conv-p1",
    });
    expect(d.kind).toBe("clarify");
    if (d.kind === "clarify") {
      expect(d.question).toBe("你说的『百外』是指面向百万用户规模的业务场景吗?");
    }
  });

  it("clarify:question 为空 → 解析失败降级正则(宁可 task 也不空问一句)", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () => JSON.stringify({ kind: "clarify", taskGoal: "", ack: "", question: "  " }),
    });
    const d = await decide({ userText: "帮我重构 X 模块", conversationId: "conv-p1" });
    // 降级到正则启发式 → 明确动作词 → task
    expect(d.kind).toBe("task");
  });

  it("clarify:context 字段在时透传", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () =>
        JSON.stringify({
          kind: "clarify",
          question: "交付一份文档还是可运行的代码?",
          context: "我先确认两件事,免得做出来不是你要的。",
        }),
    });
    const d = await decide({ userText: "调研语音机器人方案", conversationId: "conv-p1" });
    expect(d.kind).toBe("clarify");
    if (d.kind === "clarify") {
      expect(d.context).toBe("我先确认两件事,免得做出来不是你要的。");
    }
  });

  it("decide system prompt 含 clarify 的使用边界(防滥问 / 防不问)", async () => {
    const seen: Array<{ systemPrompt: string; userPrompt: string }> = [];
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async (input) => {
        seen.push(input);
        return JSON.stringify({ kind: "chat" });
      },
    });
    await decide({ userText: "你好", conversationId: "conv-p1" });
    const sys = seen[0]!.systemPrompt;
    expect(sys).toContain("clarify");
    // 明确的反滥用约束:不许拿问题当缓冲、能开工就 task
    expect(sys).toContain("别滥用");
    expect(sys).toContain("只问一个");
    expect(sys).toContain("绝对不要");
  });

  it("模型输出带 ```json fence / 前后噪音 → 仍能解析(宽容提取首个 JSON 对象)", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () =>
        '好的,分类如下:\n```json\n{"kind":"task","taskGoal":"FENCE-MARK","ack":"ok"}\n```',
    });
    const d = await decide({ userText: "部署一下", conversationId: "conv-p1" });
    expect(d.kind).toBe("task");
    if (d.kind === "task") expect(d.goal).toBe("FENCE-MARK");
  });

  it("JSON 解析失败 → 降级正则启发式(goal=raw 原文,无 ack)", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () => "我觉得这是一个 task,但我不想输出 JSON",
    });
    const d = await decide({ userText: "重构 X 模块", conversationId: "conv-p1" });
    // 正则 fallback 命中「重构」→ task,goal = raw 原文(与 defaultCommunicatorDecide 一致)
    expect(d.kind).toBe("task");
    if (d.kind === "task") {
      expect(d.goal).toBe("重构 X 模块");
      expect(d.ack).toBeUndefined();
    }
  });

  it("kind 非法枚举 → 降级正则启发式", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () => JSON.stringify({ kind: "question", taskGoal: "x", ack: "y" }),
    });
    const d = await decide({ userText: "你好呀", conversationId: "conv-p1" });
    expect(d.kind).toBe("chat"); // 正则 fallback:无动作词 → chat
  });

  it("taskGoal 缺失/空 → goal 回退用户 raw 原文", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () => JSON.stringify({ kind: "task", taskGoal: "", ack: "收到。" }),
    });
    const d = await decide({ userText: "跑一下 TSP-FALLBACK 测试", conversationId: "conv-p1" });
    expect(d.kind).toBe("task");
    if (d.kind === "task") expect(d.goal).toBe("跑一下 TSP-FALLBACK 测试");
  });

  it("超时(timeoutMs)→ 降级正则启发式,且总耗时受控", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      timeoutMs: 80,
      llmCall: async () => {
        await sleep(500);
        return JSON.stringify({ kind: "task", taskGoal: "LATE-MARK", ack: "x" });
      },
    });
    const t0 = Date.now();
    const d = await decide({ userText: "重构 X 模块", conversationId: "conv-p1" });
    const elapsed = Date.now() - t0;
    expect(d.kind).toBe("task");
    if (d.kind === "task") expect(d.goal).toBe("重构 X 模块"); // fallback raw,非 LATE-MARK
    expect(elapsed).toBeLessThan(400);
    // eslint-disable-next-line no-console
    console.log(`[decide-latency] timeout-fallback path: ${elapsed}ms (timeoutMs=80)`);
  });

  it("无模型(getModel→null,未注入 llmCall)→ 降级正则,不触网", async () => {
    const decide = makeDecide({ getModel: () => null });
    const d = await decide({ userText: "重构 X 模块", conversationId: "conv-p1" });
    expect(d.kind).toBe("task");
    if (d.kind === "task") expect(d.goal).toBe("重构 X 模块");
    expect(__compat.calls).toHaveLength(0);
  });

  it("SANSHENG_DECIDE_LLM=0 显式关闭 → 降级正则,不触网(测试/离线卫生闸门)", async () => {
    process.env.SANSHENG_DECIDE_LLM = "0";
    const decide = makeDecide({ getModel: () => FAKE_MODEL });
    const d = await decide({ userText: "重构 X 模块", conversationId: "conv-p1" });
    expect(d.kind).toBe("task");
    expect(__compat.calls).toHaveLength(0);
  });

  it("生产路径:有模型 + 闸门开 → 走 completeSimple(mock),model/context/maxTokens 正确", async () => {
    __compat.reply = textReply(
      JSON.stringify({ kind: "task", taskGoal: "CS-MARK 目标", ack: "CS-ACK" }),
    );
    const decide = makeDecide({ getModel: () => FAKE_MODEL });
    const d = await decide({ userText: "帮我迁移数据库", conversationId: "conv-p1" });
    expect(d.kind).toBe("task");
    if (d.kind === "task") {
      expect(d.goal).toBe("CS-MARK 目标");
      expect(d.ack).toBe("CS-ACK");
    }
    expect(__compat.calls).toHaveLength(1);
    const call = __compat.calls[0]!;
    expect(call.model).toBe(FAKE_MODEL);
    const ctx = call.context as { systemPrompt?: string; messages?: Array<{ role: string; content: string }> };
    expect(ctx.systemPrompt).toContain("JSON");
    expect(ctx.messages?.[0]?.role).toBe("user");
    expect(ctx.messages?.[0]?.content).toContain("帮我迁移数据库");
    // 延迟控制:输出长度受限(微型 JSON)。
    // 批次 7-C:上限 120 → 320 —— clarify 分支要多带一个中文 question
    // (约 80-120 字,中文 token 密度高),120 会把它截断导致 JSON 解析失败
    // → 静默降级回 task,新功能形同没加。maxTokens 是上限不是目标,
    // 模型写完即停,放宽不增加正常路径延迟。仍远小于模型自报的 maxTokens。
    expect(typeof call.options.maxTokens).toBe("number");
    expect((call.options.maxTokens as number)).toBeLessThanOrEqual(400);
  });

  it("completeSimple 返回 stopReason=error → 降级正则(不抛错)", async () => {
    __compat.reply = { stopReason: "error", errorMessage: "boom-network", content: [] };
    const decide = makeDecide({ getModel: () => FAKE_MODEL });
    const d = await decide({ userText: "重构 X 模块", conversationId: "conv-p1" });
    expect(d.kind).toBe("task");
    if (d.kind === "task") expect(d.goal).toBe("重构 X 模块");
  });

  it("recentHistory:注入时 prompt 含[最近对话]且逐条截断 80 字符;未注入时无该段", async () => {
    const seen: string[] = [];
    const long = "L".repeat(200);
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async (i) => {
        seen.push(i.userPrompt);
        return JSON.stringify({ kind: "chat", taskGoal: "", ack: "" });
      },
      recentHistory: () => [
        { role: "user", content: `CTX-MARK-OLD ${long}` },
        { role: "assistant", content: "旧回复短文本" },
      ],
    });
    await decide({ userText: "继续", conversationId: "conv-p1" });
    expect(seen[0]).toContain("[最近对话]");
    expect(seen[0]).toContain("CTX-MARK-OLD");
    expect(seen[0]).toContain("旧回复短文本");
    // 截断:200 字符的 L 串只保留前段(80 字符上限 + 省略标记,绝不全量进 prompt)
    expect(seen[0]).not.toContain("L".repeat(120));
    expect(seen[0]).toContain("[当前消息]");
    expect(seen[0]).toContain("继续");

    const decideNoHist = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async (i) => {
        seen.push(i.userPrompt);
        return JSON.stringify({ kind: "chat", taskGoal: "", ack: "" });
      },
    });
    await decideNoHist({ userText: "继续", conversationId: "conv-p1" });
    expect(seen[1]).not.toContain("[最近对话]");
  });

  it("延迟实测:injected-llm 快路径 decide 总耗时 < 300ms(打点进报告)", async () => {
    const decide = makeDecide({
      getModel: () => FAKE_MODEL,
      llmCall: async () => {
        await sleep(20);
        return JSON.stringify({ kind: "chat", taskGoal: "", ack: "" });
      },
    });
    const t0 = Date.now();
    await decide({ userText: "你好", conversationId: "conv-p1" });
    const llmMs = Date.now() - t0;
    const t1 = Date.now();
    const decideFallback = makeDecide({ getModel: () => null });
    await decideFallback({ userText: "你好", conversationId: "conv-p1" });
    const fbMs = Date.now() - t1;
    expect(llmMs).toBeLessThan(300);
    // eslint-disable-next-line no-console
    console.log(`[decide-latency] injected-llm(20ms fake): ${llmMs}ms; regex-fallback: ${fbMs}ms`);
  });
});
