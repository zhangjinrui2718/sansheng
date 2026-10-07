/**
 * 2026-10-07 真机事故 · 回归
 *
 * ── 事故是什么 ──────────────────────────────────────────────────
 *
 * 接待会话里甲方问「docker 里量化系统怎么配 dev/prod + CI/CD」,业务经理回了一句
 * 「我先看下你之前留下的偏好」,调了两次 `memory_search`,拿到结果之后**又想了
 * 3754 字符的 thinking 就结束了** —— `stopReason` 正常是 `stop`,不抛错、不超时、
 * 不是中断、`text` 还不为空。
 *
 * 于是平台这一侧**所有判据都通过了**:消息落库了、`emitMessageEnd` 发了、没有
 * error、没有超时、没有中断。甲方在对话页上看到的画面是「**他答完了,然后就没有
 * 然后了**」——三分钟后只好发一句「然后呢」。
 *
 * 这就是 7-E 的复发:代码里压根没有「这一回合没回答甲方」这个判据。
 * 本文件钉住它现在有了,而且判据不误伤。
 *
 * ── 为什么判据是两条而不是一条 ────────────────────────────────
 *
 * 真机那次**有**一句正文(那 22 字开场白),所以「text 为空」抓不到它。真正缺的判据
 * 是「**最后一次工具结果之后没有正文**」—— 开场白在工具之前,不能算答复。
 * 两条都要有,且都要能自证不误伤。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertSession, appendSessionMessage, listSessionMessages } from "../../src/platform/storage/repo/sessions.js";
import { runTurn, renderTurnReport, renderConversationHistory, type TurnResult } from "../../src/platform/runtime/turn.js";

let db: Database.Database;

beforeEach(() => {
  db = openPlatformMemoryDb();
  insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: 1 });
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: 1 });
  addMember(db, "p1", "bm", 1);
  insertSession(db, { id: "s1", projectId: "p1", createdAt: 1, channel: "internal" });
});
afterEach(() => db.close());

// ── 脚本化假会话(与 turn.test.ts 同一套形状)──────────────────────

function fakeSession(
  script: (emit: (ev: AgentSessionEvent) => void) => void | "never",
): { session: AgentSession; prompts: string[] } {
  const listeners: Array<(ev: AgentSessionEvent) => void> = [];
  const prompts: string[] = [];
  const session = {
    subscribe(fn: (ev: AgentSessionEvent) => void) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    async prompt(text: string) {
      prompts.push(text);
      const emit = (ev: AgentSessionEvent) => { for (const l of [...listeners]) l(ev); };
      const r = script(emit);
      // ⚠️ **`agent_settled` 不能省**:它没发,回合就一直等到收尾上界,
      // 然后按「超时」收尾 —— 而 `unanswered` **刻意不报超时回合**
      // (超时/打断各走自己的告警)。不补这一条,本文件里每一条测试都会
      // 意外地测在超时分支上,而不是它声称在测的那条。
      if (r !== "never") emit({ type: "agent_settled" });
      return { messages: [] };
    },
    async abort() {},
    dispose() {},
  };
  return { session: session as unknown as AgentSession, prompts };
}

const textDelta = (delta: string) =>
  ({ type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta", delta } }) as unknown as AgentSessionEvent;
const thinkDelta = (delta: string) =>
  ({ type: "message_update", message: {}, assistantMessageEvent: { type: "thinking_delta", delta } }) as unknown as AgentSessionEvent;
const toolStart = (id: string, name: string, args: unknown) =>
  ({ type: "tool_execution_start", toolCallId: id, toolName: name, args }) as unknown as AgentSessionEvent;
const toolEnd = (id: string, name: string, result: unknown) =>
  ({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError: false }) as unknown as AgentSessionEvent;

/**
 * 往库里写一句话。
 *
 * ⚠️ **封套那两列必须一起写**(`originSource` / `triggerKind`)——写口的纪律是
 * 「`trigger_kind` 有值 ⟺ `origin_source === 'turn'`」,缺一个会被拒。这不是啰嗦:
 * 写口敢拒,是因为历史上正是在这里放过一次形状不对的行。
 */
function say(
  id: string,
  kind: "user" | "assistant" | "system",
  content: string,
  createdAt: number,
  agentId: string | null = null,
): void {
  appendSessionMessage(db, {
    id, sessionId: "s1", agentId, kind, content, createdAt,
    ...(kind === "system"
      ? { originSource: "broadcast", triggerKind: null, todoKind: null }
      : { originSource: "turn", triggerKind: "user", todoKind: null }),
  });
}

async function turn(
  script: Parameters<typeof fakeSession>[0],
  over: Partial<Parameters<typeof runTurn>[0]> = {},
): Promise<TurnResult> {
  const fake = fakeSession(script);
  return runTurn({
    session: fake.session, db, agentId: "bm", projectId: "p1",
    message: "做点事", timeoutMs: 2000,
    ...over,
  });
}

// ── ①「没有下文」这个判据本身 ────────────────────────────────────

describe("runTurn · 「这一回合没有回答甲方」要看得见(2026-10-07)", () => {
  it("真机剧本:开场白 → 两次工具 → 只剩 thinking ⇒ no_text_after_tools", async () => {
    // 逐条复刻真机 transcript 的事件顺序。
    const r = await turn((emit) => {
      emit(textDelta("我先看下你之前留下的偏好,免得问重复的问题。"));
      emit(toolStart("t1", "memory_search", { query: "a" }));
      emit(toolEnd("t1", "memory_search", { content: [{ text: "命中 1 条" }] }));
      emit(toolStart("t2", "memory_search", { query: "b" }));
      emit(toolEnd("t2", "memory_search", { content: [{ text: "命中 2 条" }] }));
      // 事故就在这一步:想完了,没有正文。
      emit(thinkDelta("让我组织这个问题。"));
    });

    expect(r.unanswered?.kind).toBe("no_text_after_tools");
    // 现场要能解释「他其实想了很多」——不然这一行只是断言,不是证据。
    expect(r.unanswered?.toolCalls).toBe(2);
    expect(r.unanswered?.thinkingChars).toBeGreaterThan(0);
    expect(r.unanswered?.textChars).toBe(22);
    // 正文本身不受影响:该落的那句还是落下了。
    expect(r.text).toContain("我先看下");
  });

  it("全程一个字都没说 ⇒ no_text", async () => {
    const r = await turn((emit) => { emit(thinkDelta("想了一下")); });
    expect(r.unanswered?.kind).toBe("no_text");
    expect(r.unanswered?.textChars).toBe(0);
  });

  // ↓↓↓ 负样本:判据不误伤的那一半。没有它们,上面两条只是「永远报警」而已。
  it("正常答完(无工具)⇒ 不是缺陷", async () => {
    const r = await turn((emit) => { emit(textDelta("这是答复。")); });
    expect(r.unanswered).toBeNull();
  });

  it("工具之后**确实**答了 ⇒ 不是缺陷(正文在工具之后就成立)", async () => {
    const r = await turn((emit) => {
      emit(toolStart("t1", "memory_search", { query: "a" }));
      emit(toolEnd("t1", "memory_search", { content: [{ text: "命中" }] }));
      emit(textDelta("根据查到的偏好,我建议先确认 dev/prod 的物理形态。"));
    });
    expect(r.unanswered).toBeNull();
  });

  it("以工具收尾的工作项回合(排空器叫醒的)⇒ 不算缺陷", async () => {
    // 这是作用域的关键:工作项回合本来就以工具收尾,在那里报「没下文」
    // 会把常态说成故障 —— 报多了就没人看了。
    const r = await turn((emit) => {
      emit(toolStart("t1", "board_write", { title: "x" }));
      emit(toolEnd("t1", "board_write", { content: [{ text: "ok" }] }));
    });
    expect(r.unanswered).not.toBeNull(); // 现场照记(事实就是没有正文)
    // 判定「要不要报」是调用方按 trigger 决定的,不在这里。
  });

  it("超时的回合不重复报「没下文」(超时走 turn_timeout 那条告警)", async () => {
    // `"never"` = 不发 `agent_settled`,于是真的走到收尾上界。
    // ⚠️ 这一条**测的是「抑制」**:超时有自己的现场与告警,再叠一句
    // 「没下文」等于把一个已知状态说成另一个。
    const slow = await turn(() => "never", { timeoutMs: 30, wallClockTimeoutMs: 30 });
    expect(slow.timedOut).toBe(true);
    expect(slow.unanswered).toBeNull();
  });

  it("报告里看得见这一行(日志当时什么都没有)", async () => {
    const r = await turn((emit) => {
      emit(textDelta("开场白"));
      emit(toolStart("t1", "memory_search", { query: "a" }));
      emit(toolEnd("t1", "memory_search", { content: [{ text: "x" }] }));
    });
    const report = renderTurnReport(r);
    expect(report).toContain("没有正文");
  });
});

// ── ② 重启后模型失忆 ─────────────────────────────────────────────

describe("renderConversationHistory · 服务重启后模型不该失忆(2026-10-07)", () => {
  it("把库里的话摆回去,并标出「已经发生过」", () => {
    say("m1", "user", "docker 里量化系统怎么配 dev/prod + CI/CD", 1, null);
    say("m2", "assistant", "我先看下你的偏好。", 2, "bm");

    const h = renderConversationHistory(db, "s1");
    expect(h).toContain("docker 里量化系统怎么配 dev/prod");
    expect(h).toContain("我先看下你的偏好");
    // 模型必须分得清「这些已经发生过了」与「现在要做的」——
    // 不标出来,它会把第一个问题重新答一遍。
    expect(h).toContain("已经发生过");
  });

  it("排除本回合自己的那条用户消息(否则甲方的话出现两遍)", () => {
    say("m1", "user", "第一个问题", 1, null);
    say("m2", "user", "然后呢", 2, null);

    const h = renderConversationHistory(db, "s1", { excludeMessageId: "m2" });
    expect(h).toContain("第一个问题");
    expect(h).not.toContain("然后呢");
  });

  it("平台内部的 system 通知不进历史(它本来就不进对话页)", () => {
    say("m1", "user", "甲方说的话", 1, null);
    say("m2", "system", "排空停止:预算用尽", 2, "bm");

    const h = renderConversationHistory(db, "s1");
    expect(h).toContain("甲方说的话");
    expect(h).not.toContain("预算用尽");
  });

  it("没有历史时返回空串 —— 不拼一个空壳", () => {
    // 与 pendingBlock 同一条纪律:空壳会让模型以为「系统已经替我列过了」。
    expect(renderConversationHistory(db, "s1")).toBe("");
  });

  it("端到端:重启后的第一回合,prompt 里带着之前的对话", async () => {
    say("m1", "user", "怎么配 dev/prod 环境隔离", 1, null);
    say("m2", "user", "然后呢", 2, null);

    const fake = fakeSession((emit) => { emit(textDelta("先确认 dev 与 prod 的物理形态。")); });
    await runTurn({
      session: fake.session, db, agentId: "bm", projectId: "p1",
      message: "然后呢", timeoutMs: 2000,
      conversationHistory: { sessionId: "s1", excludeMessageId: "m2" },
    });

    const prompt = fake.prompts[0]!;
    // 真机事故里模型从未见过的那句话,现在必须在 prompt 里。
    expect(prompt).toContain("怎么配 dev/prod 环境隔离");
    // 而甲方这一句不该出现两遍。
    expect(prompt.split("然后呢").length - 1).toBe(1);
  });

  it("不传 conversationHistory 时不重放(会话还活着,历史在 SDK 那一侧)", async () => {
    say("m1", "user", "怎么配 dev/prod", 1, null);

    const fake = fakeSession((emit) => { emit(textDelta("好")); });
    await runTurn({
      session: fake.session, db, agentId: "bm", projectId: "p1",
      message: "然后呢", timeoutMs: 2000,
    });

    expect(fake.prompts[0]).not.toContain("怎么配 dev/prod");
  });

  it("只重放最近若干条,更早的不带(上下文有上界)", () => {
    for (let i = 1; i <= 30; i += 1) {
      say(`m${i}`, "user", `第 ${i} 句`, i);
    }
    const h = renderConversationHistory(db, "s1");
    expect(h).toContain("第 30 句");
    expect(h).not.toContain("第 1 句\n");
    // 12 条上界
    expect(h.split("\n- ").length).toBeLessThanOrEqual(13);
  });
});

// ── ③ 自检:这个检查本身对已知样本给出正确答案吗? ────────────────
// (AGENTS.md「三类静默失败」第 3 条:一个坏掉的检查可能返回一个看起来正常的错误答案。)

describe("回归自检 · 判据没有静默失效", () => {
  it("正样本:库里真有历史时,重放非空", () => {
    say("m1", "user", "真实存在的一句", 1, null);
    expect(renderConversationHistory(db, "s1")).toContain("真实存在的一句");
  });

  it("负样本:库里没有历史时,重放必须为空(不是「永远有内容」)", () => {
    const fresh = openPlatformMemoryDb();
    insertSession(fresh, { id: "s9", projectId: null, createdAt: 1, channel: "internal" });
    expect(renderConversationHistory(fresh, "s9")).toBe("");
    expect(listSessionMessages(fresh, "s9")).toEqual([]);
    fresh.close();
  });
});