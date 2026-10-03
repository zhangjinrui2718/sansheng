/**
 * 批次 8-B · 终态播报(沟通员 Observer 身份的执行点)
 *
 * 本文件守的是角色职能核查里的第二条 P0(见 docs/AGENT-AUDIT-2026-10-03.md §1.1 第 5 条):
 * 沟通员的出厂提示词写着「Observer:只在终态主动向用户播报一句话结果」,代码侧也有
 * 一整套 startObserver/enableObserver,**但从无调用方** —— 死接线。用户跑完一个 plan,
 * 只看到一张卡片,没有任何人跟他说话。
 *
 * 播报器要守的四条:
 *  1. **LLM 正常** → 用模型的话(`source: "llm"`),并清洗 markdown。
 *  2. **LLM 抛错 / 返回垃圾 / 空字符串** → 退回确定性文案(`source: "fallback"`),
 *     **且文案里的每个数字都来自真实输入** —— 降级不等于可以含糊。
 *  3. **失败/中止也要说话**,且要说清失败在哪一步。
 *  4. **永不抛、永不返回空**:最差路径也必须给用户一句真话。
 */
import { describe, expect, it } from "vitest";
import { fallbackReportText, makeRunReporter, type RunReportInput } from "../../src/server/agents/runReport.js";

const base: RunReportInput = {
  conversationId: "conv_test",
  goal: "把三生跑通",
  outcome: "completed",
  todos: [
    { title: "接上工具", status: "resolved" },
    { title: "跑一次端到端", status: "resolved" },
  ],
  deliveries: [{ title: "接通报告", preview: "执行者把三生跑通了,证据在这" }],
};

describe("8-B · 终态播报", () => {
  it("① LLM 正常时用模型的话,并剥掉 markdown / 围栏 / 标题", async () => {
    const reporter = makeRunReporter({
      getModel: () => null,
      getApiKey: () => undefined,
      llmCall: async () =>
        "```\n## 播报\n- **完成**:三生已经跑通了,主要成果是接通报告。\n```",
    });
    const r = await reporter(base);
    expect(r.source).toBe("llm");
    expect(r.text).toContain("三生已经跑通");
    expect(r.text).not.toContain("```");
    expect(r.text).not.toContain("##");
    expect(r.text.startsWith("- **完成**")).toBe(false);
  });

  it("② LLM 抛错 / 空输出 / 垃圾输出 → 降级文案,且数字来自真实输入", async () => {
    for (const llmCall of [
      async () => {
        throw new Error("network down");
      },
      async () => "",
      async () => "   ",
    ]) {
      const reporter = makeRunReporter({ getModel: () => null, getApiKey: () => undefined, llmCall });
      const r = await reporter(base);
      expect(r.source).toBe("fallback");
      expect(r.text).toContain("2/2"); // 2 项 resolved / 共 2 项
      expect(r.text).toContain("接通报告"); // 第一条交付物标题
    }
  });

  it("③ 失败与中止都要有话说,且说清哪一步失败", async () => {
    const failed = fallbackReportText({
      ...base,
      outcome: "failed",
      todos: [
        { title: "接上工具", status: "resolved" },
        { title: "跑一次端到端", status: "failed" },
      ],
      reason: "工具超时",
    });
    expect(failed).toContain("1/2");
    expect(failed).toContain("工具超时");

    const aborted = fallbackReportText({ ...base, outcome: "aborted", todos: [], deliveries: [], reason: "用户中止" });
    expect(aborted).toContain("中止");
    expect(aborted).toContain("用户中止");
  });

  it("④ 没有模型 / 没有 apiKey 也照样给出一句真话(离线不装死)", async () => {
    const reporter = makeRunReporter({ getModel: () => null, getApiKey: () => undefined });
    const r = await reporter(base);
    expect(r.source).toBe("fallback");
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("⑤ 降级文案不编造:没有交付物时不说「成果」", () => {
    const text = fallbackReportText({ ...base, deliveries: [] });
    expect(text).not.toContain("主要成果");
  });
});