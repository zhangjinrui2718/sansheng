/**
 * A4 · `[未播报]` 行首分流 + `thinking` 折叠(设计 1 §2.10.4 / §2.12 的 A4)
 *
 * ── 本文件钉的三件事(每件都有正负样本)──────────────────────────
 *
 *   1. **`[未播报]` 那一行按行首分流**,不与播报混在一个气泡里 —— 但**不滤掉**
 *      (它是「判断过、决定不打扰你」在会话记录里唯一的现场,§2.10.4)。
 *      判据的负样本是设计 ④ 明确要的那条:正文**中段**引述 `"[未播报]"` 不得分流。
 *   2. **`thinking` 默认折叠**,且折叠时渲染产物里**没有推理正文** —— 展开才进 DOM。
 *   3. **折叠状态在组件内、每块一份**,不跨轮共享、不进 store。
 *
 * ── 为什么是「纯函数 + 纯组件 + SSR」这三层 ──────────────────────
 *
 * `MessageList` 从 zustand 取数,而 SSR 下 store 读 server snapshot(`setState`
 * 驱动不了,见 `tests/web/message-list.test.ts` 文件头)—— 判据抽成纯函数
 * (`splitWorkLog`)、渲染抽成纯 props 组件(`TurnView` / `ConversationStream` /
 * `ThinkingDisclosure`),两者合起来覆盖「哪些行进哪一块、渲染成什么样」。
 *
 * ⚠️ **SSR 点不动按钮**:所以「展开才可见」只能靠把 `open` 变成 prop
 * (`ThinkingDisclosure`)直测两条状态的渲染产物;`ThinkingBlock` 只持有一位状态。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationStream, TurnView, splitWorkLog } from "@/components/chat/MessageList";
import { THINKING_DEFAULT_OPEN, ThinkingDisclosure } from "@/components/chat/ThinkingBlock";
import type { ConversationPartition } from "@/lib/data";
import type { Turn } from "@/stores/chat";

function turn(
  id: string,
  role: Turn["role"],
  agentId: string | null,
  blocks: Turn["blocks"],
  // ⚠️ W2-④ 起 `origin` 是必填(`TurnOrigin`)。这些样本都是**甲方通道**里的轮
  // (工作记录 / 思考折叠都只在能上屏的轮里才有意义)⇒ 默认给「用户触发的那一轮」。
  origin: Turn["origin"] = { source: "turn", trigger: { kind: "user" } },
): Turn {
  // `projectId` 是 `Turn` 的必填字段(`tests/` 不在两条 tsconfig 的 include 里,
  // 漏填 tsc 不会报 —— 见 `tests/web/channel-filter.test.ts` 的同一处说明)。
  return { id, projectId: "p-test", role, agentId, blocks, startedAt: 0, origin };
}

function assistant(text: string): Turn {
  return turn("m1", "assistant", "bm", [{ kind: "text", text }]);
}

function render(t: Turn, streaming = false): string {
  return renderToStaticMarkup(createElement(TurnView, { turn: t, streaming }));
}

/**
 * 出货提示词里那条**真实**的格式示例(`business_manager.core.md` 的代码块)。
 *
 * 用它而不是自己编一段的理由:分流判据要对付的正是这条 —— 它是**硬折行的三行**
 * (第一行结尾是「钱」,没有句末标点),而提示词的要求写的是「一行,最多两句」。
 * 拿不到示例就**抛错**:判据的前提没了,不许静默通过(本项目「坏掉的检查不等
 * 于检查失败」那条纪律)。
 */
function shippedWorkLogExample(): string {
  const src = readFileSync(
    join(process.cwd(), "harness/system_prompts/business_manager.core.md"),
    "utf8",
  );
  const m = /```\n(\[未播报\][\s\S]*?)```/.exec(src);
  const body = m?.[1]?.replace(/\n$/, "");
  if (body === undefined || body === "") {
    throw new Error("提示词里找不到 `[未播报]` 的格式示例 —— 这条测试的前提没了");
  }
  return body;
}

/** 把渲染产物切成「工作记录块」与「其余(甲方气泡 + 别的带)」。 */
const WORK_LOG_BLOCK = /<div[^>]*data-channel="work-log"[^>]*>([\s\S]*?)<\/div>/;

function splitHtml(html: string): { block: string | null; rest: string } {
  const m = WORK_LOG_BLOCK.exec(html);
  if (m === null || m[0] === undefined) return { block: null, rest: html };
  return { block: m[1] ?? "", rest: html.replace(m[0], "") };
}

describe("A4 · `[未播报]` 的行首分流(纯函数)", () => {
  it("行首匹配 → 正文切成「播报」+「工作记录」两块(顺序不变)", () => {
    const example = shippedWorkLogExample();
    const segs = splitWorkLog(`收到,我看了一遍。\n\n${example}`);
    expect(segs.map((s) => s.kind)).toEqual(["speech", "work_log"]);
    expect(segs[0]?.text).toBe("收到,我看了一遍。");
    expect(segs[1]?.text).toBe(example);
  });

  // ── 设计 ④ 明确要的负样本:行中不得分流 ──────────────────────────
  it("⚠️ 负样本:正文**中段**出现 `\"[未播报]\"` 不分流(那是引述,是对甲方说的话)", () => {
    const text = "你问的那行 `\"[未播报]\"` 是我自己留的工作记录,不是给你的话。";
    const segs = splitWorkLog(text);
    expect(segs).toHaveLength(1);
    expect(segs[0]?.kind).toBe("speech");
    expect(segs[0]?.text).toBe(text);
  });

  it("行首的水平空白仍算行首(提示词示例写在代码块里,缩进不该破坏判据)", () => {
    const segs = splitWorkLog("  [未播报] 评估 1 条,不播。");
    expect(segs.map((s) => s.kind)).toEqual(["work_log"]);
  });

  it("负样本:`- [未播报] …`(列表项)不算行首 —— 那已经是一条正文", () => {
    const segs = splitWorkLog("- [未播报] 评估 1 条,不播。");
    expect(segs.map((s) => s.kind)).toEqual(["speech"]);
  });

  it("出货提示词的示例是硬折行三行 —— 续行属于同一条工作记录(空行为界)", () => {
    const example = shippedWorkLogExample();
    // 正样本自检:它真的是多行,否则这条测试什么也没测
    expect(example.split("\n").length).toBeGreaterThan(1);

    const segs = splitWorkLog(`先说一句给甲方的话。\n\n${example}\n\n接着播报下一件事。`);
    expect(segs.map((s) => s.kind)).toEqual(["speech", "work_log", "speech"]);
    expect(segs[1]?.text).toBe(example);
    expect(segs[2]?.text).toBe("接着播报下一件事。");
  });

  it("没有 `[未播报]` 的正文原样返回(既有渲染路径一个字符都不变)", () => {
    const text = "| 模块 | 优先级 |\n| --- | --- |\n| 认证 | **P0** |";
    const segs = splitWorkLog(text);
    expect(segs).toEqual([{ kind: "speech", text }]);
  });

  it("空行只是分隔符 —— 不产出空气泡", () => {
    const segs = splitWorkLog("\n\n[未播报] 评估 1 条。\n\n\n");
    expect(segs).toEqual([{ kind: "work_log", text: "[未播报] 评估 1 条。" }]);
  });
});

describe("A4 · 渲染:工作记录不在甲方气泡里,也没被滤掉", () => {
  it("该行只出现在工作记录块里,气泡里只有播报", () => {
    const example = shippedWorkLogExample();
    const html = render(assistant(`收到,我看了一遍。\n\n${example}`));
    const { block, rest } = splitHtml(html);

    expect(block, "工作记录块必须真的渲染出来").not.toBeNull();
    // 正样本:整条工作记录(含硬折行的续行)都在那一块里 —— 没有被截断、没有被滤掉
    expect(block).toContain("[未播报]");
    expect(block).toContain(example);
    expect(block, "播报不该被卷进工作记录块").not.toContain("收到,我看了一遍。");

    // ⚠️ 关键判据:该行**不在气泡里**(气泡在 rest 里,rest 里没有它)
    expect(rest).toContain("收到,我看了一遍。");
    expect(rest).not.toContain("[未播报]");
    expect(rest, "续行也不许留在气泡里(那正是「混在一起」)").not.toContain("都没动");
  });

  // ── 与纯函数那一层配对的端到端负样本 ─────────────────────────────
  it("⚠️ 负样本:行中引述 `\"[未播报]\"` 的消息不产生工作记录块", () => {
    const html = render(assistant("你问的那行 `\"[未播报]\"` 是我自己留的工作记录。"));
    expect(html).not.toContain('data-channel="work-log"');
    expect(html).toContain("[未播报]");
  });

  it("甲方自己打的 `[未播报]` 不被分流(不替用户改写输入)", () => {
    const html = render(turn("u1", "user", null, [{ kind: "text", text: "[未播报] 这是我自己打的" }]));
    expect(html).not.toContain('data-channel="work-log"');
    expect(html).toContain("[未播报] 这是我自己打的");
  });

  it("工作记录与播报之间靠 `data-channel` 分开(渲染层真的用上了这个判据)", () => {
    const html = render(assistant("[未播报] 评估 1 条,不播。"));
    const { block, rest } = splitHtml(html);
    expect(block).toContain("评估 1 条");
    // 负样本:它没有走气泡那套(只有工作记录时,气泡元素一个都不该有)
    expect(rest).not.toContain("评估 1 条");
    expect(rest, "只有工作记录时不该再有气泡").not.toContain("rounded-lg px-4 py-3");
  });
});

describe("A4 · `thinking` 默认折叠(折叠时 DOM 里没有推理正文)", () => {
  const REASONING = "先看甲方这句话的意图…这里是我真正的推理过程,不该在折叠态出现。";

  it("默认值是折叠,且渲染产物里看不到推理正文", () => {
    expect(THINKING_DEFAULT_OPEN, "默认必须是折叠").toBe(false);

    const html = render(turn("m1", "assistant", "bm", [{ kind: "thinking", text: REASONING }]));
    expect(html).toContain("思考");
    expect(html, "折叠态不能把推理正文放进渲染产物").not.toContain(REASONING);
    expect(html, "折叠态连前 60 字预览都不许有(旧实现漏在这里)").not.toContain("先看甲方这句话的意图");
    expect(html).toContain('aria-expanded="false"');
  });

  it("展开时才渲染推理正文(`open` 是唯一开关)", () => {
    const html = renderToStaticMarkup(
      createElement(ThinkingDisclosure, {
        text: REASONING,
        open: true,
        onToggle: () => {},
      }),
    );
    expect(html).toContain(REASONING);
    expect(html).toContain('aria-expanded="true"');
  });

  it("两轮各自的思考都折叠 —— 折叠状态不在轮之间共享", () => {
    const a = turn("mA", "assistant", "bm", [{ kind: "thinking", text: "第一轮的推理正文 AAA" }]);
    const b = turn("mB", "assistant", "bm", [{ kind: "thinking", text: "第二轮的推理正文 BBB" }]);
    const history: ConversationPartition["timeline"] = [
      { turn: a, channel: "client" },
      { turn: b, channel: "client" },
    ];
    const html = renderToStaticMarkup(
      createElement(ConversationStream, { history, streaming: [], hiddenNote: null }),
    );
    expect(html).not.toContain("第一轮的推理正文 AAA");
    expect(html).not.toContain("第二轮的推理正文 BBB");
    // 两块各自的折叠壳都在(不是一块被共享掉)
    expect(html.match(/aria-expanded="false"/g)?.length).toBe(2);
  });

  /**
   * ⚠️ 这条是**源码级**断言(本仓前端测试没有 DOM,点不动按钮 ⇒ 只能守结构)。
   * 它守的不是「行为」,而是那条最容易写错的结构:折叠状态必须是组件内的
   * `useState`,一旦被搬进 store(第二处真相)或模块级变量(跨轮共享)就红。
   * 行为那一半由上两条(SSR 折叠态 / 展开态)守着。
   */
  it("折叠状态在组件内:用 useState,不引 store", () => {
    const src = readFileSync(
      join(process.cwd(), "web/src/components/chat/ThinkingBlock.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(src).toMatch(/useState\(THINKING_DEFAULT_OPEN\)/);
    expect(src, "折叠状态不许写进 chat store").not.toMatch(/stores\/chat/);
  });
});
