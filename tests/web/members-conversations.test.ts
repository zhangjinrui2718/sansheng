/**
 * 成员页「**他说了什么**」—— 某一个成员的对话全文(进行中 + 已完成)
 *
 * ── 用户要的是什么(2026-10-26 原话)──────────────────────────────────
 *
 * 「我想看看每一个agent 进行中、已完成的**具体的对话内容**,只读就好了,
 *   在成员的这个页面中新增这项功能」。
 *
 * 成员页原来那块「他产生了什么对话」是 `member-conversations` 给的一页**摘要**
 * (每条截到 90 字、新的在前、默认折叠)。那不是「对话内容」—— 它是**清单**
 * (谁说了几条)。所以这一块换成了**全文**读面。
 *
 * ── 这一份测试钉住的判据 ────────────────────────────────────────────
 *
 *   ① **「进行中」与「已完成」两块都在**,且**内容**摆在明面上(不是摘要)。
 *   ② **「读不到」≠「0 条」**、**「还没查过」≠「0 条」** —— 与 2026-10-06 那条
 *      「「读不到」不许显示成「没有发言」」同款纪律(上一版的判据 ⑪,本文件
 *      把它接到新组件上)。
 *   ③ **条数是线头的真值**,不是「这一页有几条」—— 两者混在一起的那一版会
 *      在消息一多时**静默少数**。
 *   ④ **正文不截断**(原来那块截到 90 字)—— 负样本:一条 300 字的消息必须
 *      **完整**出现在页面上。
 *   ⑤ **思考与正文分开**(7-I):在飞轮里「他在想」与「他在说」不是一件事。
 *
 * 组件是**纯 props 的**(`AgentConversationBody`),与 `MemberPane` /
 * `ConversationCard` 同一处置 —— 导出给测试,不起服务、不 stub fetch。
 *
 * ── 一个渲染细节(写断言时必须知道)────────────────────────────────
 *
 * `renderToStaticMarkup` 会在**相邻文本节点**之间插 `<!-- -->`
 * (例如 `共 {5} 条` → `共 <!-- -->5<!-- --> 条`)。所以断言**正文**一律先过
 * `visible()`(它同时剥掉标签里的属性 —— 页面上故意把判断依据写进了
 * `title=`,那是用户看不见的字,不能算进正文)。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AgentConversationLineView,
  MemberActivityView,
  MemberView,
  SessionMessageView,
} from "@shared/types/platform";
import { AgentConversationBody, liveTurnParts } from "@/components/members/AgentConversations";
import { MemberPane } from "@/routes/Members";
import type { Turn } from "@/stores/chat";

/** 只留**可见正文**:去掉标签(属性跟在里面一起走)与 SSR 插的 `<!-- -->`。 */
const visible = (html: string): string =>
  html
    .replace(/ title="[^"]*"/g, "")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]*>/g, "");

// ── 夹具 ────────────────────────────────────────────────────────

const AGENT_ID = "agent-wk";
const SESSION = "s-main";

const line = (over: Partial<AgentConversationLineView> = {}): AgentConversationLineView => ({
  sessionId: SESSION,
  title: null,
  kind: "main",
  channel: "internal",
  messageCount: 2,
  lastMessageAt: 1_700_000_000_000,
  ...over,
});

const msg = (over: Partial<SessionMessageView> = {}): SessionMessageView => ({
  id: "m1",
  projectId: "p-1",
  sessionId: SESSION,
  agentId: AGENT_ID,
  agentName: "研究员",
  kind: "assistant",
  content: "我把导出接口写完了。",
  createdAt: 1_700_000_000_000,
  origin: { source: "turn", trigger: { kind: "user" } },
  ...over,
});

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: "t1",
  projectId: "p-1",
  sessionId: SESSION,
  role: "research_worker",
  blocks: [{ kind: "text", text: "我正在写导出接口…" }],
  startedAt: 1_700_000_000_000,
  agentId: AGENT_ID,
  origin: { source: "turn", trigger: { kind: "user" } },
  ...over,
});

function renderBody(over: Partial<React.ComponentProps<typeof AgentConversationBody>> = {}): string {
  return renderToStaticMarkup(
    createElement(AgentConversationBody, {
      agentName: "研究员",
      lines: [line()],
      messages: [msg()],
      truncated: false,
      selectedSessionId: SESSION,
      loading: false,
      error: null,
      live: [],
      onSelectSession: () => {},
      ...over,
    }),
  );
}

describe("成员页 · 「他说了什么」:进行中 + 已完成的对话内容", () => {
  it("① 两块都在:**正在说什么** 与 **已说完的**", () => {
    const text = visible(renderBody());
    expect(text).toContain("正在说什么");
    expect(text).toContain("已说完的");
  });

  it("①「进行中」:有在飞轮 ⇒ 显示轮数与**正文**(不是「在跑」两个字)", () => {
    const text = visible(renderBody({ live: [turn()] }));
    expect(text).toContain("1 轮正在流");
    expect(text).toContain("我正在写导出接口…");
    // 负样本:只剩一个「在跑」的灯 ⇒ 那答不了「他在说什么」
    expect(text).not.toContain("此刻没有正在流的回复");
  });

  it("①「进行中」:没有在飞轮 ⇒ 如实说「此刻没有正在流的回复」,并说清它的边界", () => {
    const text = visible(renderBody());
    expect(text).toContain("此刻没有正在流的回复");
    expect(text).toContain("回合结束后才落库");
  });

  it("①「已完成」:正文摆在明面上(全文,不截断)", () => {
    // ⚠️ 末尾那个**唯一标记**不能省:正文是一串重复的「细节说明。」时,
    //    `long.slice(-40)` 与截断版的末尾**逐字相同** ⇒ 那条断言恒真
    //    (变异自检实测:把正文截到 90 字,测试仍然全绿)。标记让「尾部还在吗」
    //    成为一个真问题。
    const long = "把导出接口写完了。" + "细节说明。".repeat(60) + "【末尾标记】";
    const text = visible(renderBody({ messages: [msg({ content: long })] }));
    expect(text).toContain("把导出接口写完了。");
    // 负样本:原来的那块截到 90 字 ⇒ 长消息会被切掉尾巴
    expect(text, "正文不许被截断(原来那块截到 90 字)").toContain("【末尾标记】");
    expect(text, "整段正文都要在").toContain(long);
  });

  it("②「读不到」不许显示成「0 条」,且必须带出原因", () => {
    const text = visible(renderBody({ error: "Failed to fetch", lines: [], messages: [] }));
    expect(text).toContain("读不到");
    expect(text).toContain("Failed to fetch");
    expect(text, "把请求失败说成「0 条」就是撒谎").not.toContain("共 0 条");
  });

  it("②「还没查过」也不许显示成「0 条」", () => {
    const text = visible(renderBody({ loading: true, lines: [], messages: [] }));
    expect(text).toContain("正在读取");
    expect(text, "还没查过 ≠ 他一句都没说过").not.toContain("共 0 条");
  });

  it("② 真的一条都没有(查过了、是空的)⇒ 那才说「还没有留下任何发言记录」", () => {
    const text = visible(renderBody({ lines: [], messages: [] }));
    expect(text).toContain("还没有留下任何发言记录");
    expect(text).toContain("共 0 条");
  });

  it("③ 条数取**线头的真值**,不是「这一页有几条」", () => {
    // 线头说 5 条,这一页只给了 2 条正文(窗口)⇒ 界面必须说 5 条
    const text = visible(
      renderBody({
        lines: [line({ messageCount: 5 })],
        messages: [msg({ id: "m1" }), msg({ id: "m2", content: "第二条" })],
      }),
    );
    expect(text).toContain("共 5 条");
    expect(text, "窗口不许冒充总数").not.toContain("共 2 条");
  });

  it("④ 甲方在同一条线上的话**作为上下文**出现,并标出那是甲方说的", () => {
    const text = visible(
      renderBody({
        messages: [
          msg({ id: "m0", agentId: null, agentName: null, kind: "user", content: "把导出接口写完" }),
          msg({ id: "m1" }),
        ],
      }),
    );
    expect(text).toContain("把导出接口写完");
    expect(text).toContain("甲方");
  });

  it("⑤ 思考与正文分开(7-I):「他在想」不许混进「他在说」", () => {
    const parts = liveTurnParts(
      turn({
        blocks: [
          { kind: "thinking", text: "先看一下导出接口的签名" },
          { kind: "text", text: "我正在写导出接口…" },
          { kind: "tool", tool: { id: "t", name: "code.exec" } },
        ],
      }),
    );
    expect(parts.text).toBe("我正在写导出接口…");
    expect(parts.text, "思考不许混进正文").not.toContain("先看一下导出接口的签名");
    expect(parts.thinking).toBe("先看一下导出接口的签名");
    expect(parts.tools).toEqual(["code.exec"]);
  });

  it("线名:有名字用名字,没名字**不编一个**(`null` → 「主对话」)", () => {
    const withTitle = visible(renderBody({ lines: [line({ title: "第二版方案" })] }));
    expect(withTitle).toContain("第二版方案");
    const without = visible(renderBody({ lines: [line({ title: null, kind: "main" })] }));
    expect(without).toContain("主对话");
  });

  it("「已说完的」那块是**折叠块**且默认收起(不然一屏被几百条消息刷满)", () => {
    const html = renderBody();
    expect((html.match(/<details/g) ?? []).length, "折叠块存在(details 渲染出来了)").toBeGreaterThan(0);
    expect(/<details[^>]*\sopen/.test(html), "有 details 是展开的 —— 默认折叠的承诺破了").toBe(false);
    // 负样本:内容**在**那个折叠块里(不是被删了)
    expect(visible(html)).toContain("我把导出接口写完了。");
  });

  it("多条线时线头一个一个列出来(带各自的条数)", () => {
    const text = visible(
      renderBody({
        lines: [
          line({ sessionId: "s-main", messageCount: 3 }),
          line({ sessionId: "s-thread", title: "第二版方案", kind: "thread", messageCount: 1 }),
        ],
        selectedSessionId: "s-main",
      }),
    );
    expect(text).toContain("第二版方案");
    expect(text).toContain("3 条");
    expect(text).toContain("1 条");
  });
});

describe("成员页 · 成员面板里那一块的位置与归属", () => {
  const WK: MemberView = {
    id: AGENT_ID,
    role: "research_worker",
    displayName: "研究员",
    specialization: "engineering",
  };
  const activity: MemberActivityView = {
    agentId: AGENT_ID,
    turn: null,
    currentWorks: [],
    readyWorks: 0,
    waitingWorks: 0,
    todos: [],
    exhaustedTodos: 0,
    lastMessage: null,
  };

  it("面板里有「他说了什么」这一块(原来的「他产生了什么对话」摘要列表**没了**)", () => {
    const html = renderToStaticMarkup(
      createElement(MemberPane, {
        member: WK,
        activity,
        projectId: "p-1",
        artifacts: [],
        runtime: "host",
        dispatch: null,
        fetchedAt: 1_700_000_000_000,
        now: 1_700_000_000_000,
      }),
    );
    const text = visible(html);
    expect(text).toContain("他说了什么");
    // 负样本:那块 90 字摘要列表不许还在(它是「清单」,不是「内容」)
    expect(text).not.toContain("他产生了什么对话");
  });
});
