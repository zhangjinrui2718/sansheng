/**
 * 成员页「**他说了什么**」的数据源:`GET /api/projects/:id/agents/:agentId/conversations`
 *
 * ── 这个端点存在的理由(2026-10-26 用户裁决)──────────────────────────────
 *
 * 用户原话:「我想看看每一个agent 进行中、已完成的**具体的对话内容**,只读就好了,
 * 在成员的这个页面中新增这项功能」。
 *
 * 成员页原先那块「他产生了什么对话」接的是 `/member-conversations` 的那一组
 * **摘要**:每条**截到 90 字**、**新的在前**、默认折叠。那不是「对话内容」——
 * 它是一张清单(谁说了几条)。本端点答的是**内容**:
 *
 *   · `lines[]`   —— 他有消息的**对话线**(逐条线 + 每条线他说了几条);
 *   · `messages[]` —— 选中那条线的**全文**,**正序**(旧 → 新)。
 *
 * ── 三条判据(正负样本都要有)───────────────────────────────────────────
 *
 * ① **只回「他的话 + 甲方在同一线上的话」** —— 别的角色说的话不在这里
 *    (那在它们自己的面板里);**平台通知(`kind='system'`)也不在这里**
 *    (那在项目页「组织运行态」)。⚠️ 甲方的话与平台通知在库里都是
 *    `agent_id IS NULL`,必须靠 `kind` 分开 —— 只按 `agent_id` 过滤会把
 *    平台通知端上来。
 *
 * ② **条数是 SQL `GROUP BY` 的真值**,而 `messages` 是一**页**(窗口)。
 *    两者混在一起的那一版会在消息一多时**静默少数** —— 而少数的那一版和
 *    正确的那一版在屏幕上长得一模一样。
 *
 * ③ **顺序是正序**。窗口取的是**最近 N 条**,交回去要倒回旧 → 新,不然
 *    读起来像倒放。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { appendSessionMessage, insertSession } from "../../src/platform/storage/repo/sessions.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { AgentConversationsResponse } from "@shared/types/platform.js";

const P = "p-agents";
const MAIN = "s-main";
const THREAD = "s-thread";
let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  insertProject(db, {
    id: P, name: "登录系统", client: "甲方", goal: "把登录做出来",
    status: "active", createdAt: clock,
  });
  insertSession(db, { id: MAIN, projectId: P, createdAt: clock, kind: "main" });
  insertSession(db, {
    id: THREAD, projectId: P, createdAt: clock + 1, kind: "thread", title: "第二版方案",
  });
  for (const [id, role, name] of [
    ["bm", "business_manager", "业务经理"],
    ["wk", "research_worker", "研究员"],
    ["qa", "quality_reviewer", "质检"],
  ] as const) {
    insertAgent(db, { id, role, specialization: null, displayName: name, createdAt: clock });
  }
});

afterEach(() => {
  db.close();
});

/** 落一条会话消息(`agentId: null` = 甲方的话 / 平台通知两者之一)。 */
function msg(
  agentId: string | null,
  kind: "user" | "assistant" | "system",
  content: string,
  sessionId: string = MAIN,
): void {
  seq += 1;
  clock += 1;
  appendSessionMessage(db, {
    id: `m${seq}`, sessionId, agentId, kind, content, createdAt: clock,
    // 封套(`origin_source` / `trigger_kind`)与本测试无关 ⇒ 显式 null / null。
    originSource: null, triggerKind: null,
  });
}

function app(over?: Partial<HttpDeps>) {
  const deps: HttpDeps = {
    db,
    dataDir: "/tmp/agent-conversations-test",
    cwd: "/tmp",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/agent-conversations-test", factoryDir: "/tmp/agent-conversations-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
    ...over,
  };
  return createPlatformApp(deps);
}

async function fetchAgent(
  agentId: string,
  query = "",
): Promise<AgentConversationsResponse> {
  const res = await app().request(`/api/projects/${P}/agents/${agentId}/conversations${query}`);
  expect(res.status, "端点必须存在且 200").toBe(200);
  return (await res.json()) as AgentConversationsResponse;
}

describe("成员页 · 他说了什么:全文读面", () => {
  it("端点存在且形状正确(projectId / agentId / lines / messages / truncated)", async () => {
    msg("wk", "assistant", "我把导出接口写完了");
    const body = await fetchAgent("wk");
    expect(body.projectId).toBe(P);
    expect(body.agentId).toBe("wk");
    expect(Array.isArray(body.lines)).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.truncated).toBe(false);
  });

  it("项目不存在 → 404 not_found(与其他项目端点同形)", async () => {
    const res = await app().request("/api/projects/p-不存在/agents/wk/conversations");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("正文只有「他的话 + 甲方在同一条线上的话」", async () => {
    msg(null, "user", "把导出接口写完");
    msg("wk", "assistant", "写完了");
    msg("bm", "assistant", "业务经理在甲方那条线上的话");
    msg(null, "system", "排空在 max_rounds 处停下(8 回合)");

    const body = await fetchAgent("wk");
    const texts = body.messages.map((m) => m.content);
    expect(texts).toContain("写完了");
    // 甲方的话**在**:他说的每一句都是回某一句话的,没有那一句就是一串没有对象的回答
    expect(texts, "甲方在同一条线上的话要作为上下文端上来").toContain("把导出接口写完");
    // 负样本 ①:别的角色的话不在这里(那在它自己的面板里)
    expect(texts, "别的角色说的话不许端上来").not.toContain("业务经理在甲方那条线上的话");
    // 负样本 ②:平台通知不在这里(那在项目页「组织运行态」)
    expect(texts, "平台通知不许端上来").not.toContain("排空在 max_rounds 处停下(8 回合)");
  });

  it("⚠️ 平台通知与甲方的话都靠 kind 分开(只看 agent_id 会把通知端上来)", async () => {
    msg(null, "user", "甲方的话");
    msg(null, "system", "平台的通知");
    msg("wk", "assistant", "研究员的话");

    const body = await fetchAgent("wk");
    const kinds = body.messages.map((m) => m.kind);
    // 正样本:库里那三行都在(否则下面两条负样本是空转)
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    // 负样本:系统通知不在
    expect(kinds, "系统通知必须被挡在外面").not.toContain("system");
    // 正样本自检:甲方那条确实在(它没被一起挡掉)
    expect(body.messages.find((m) => m.kind === "user")?.content).toBe("甲方的话");
  });

  it("顺序是**正序**(旧 → 新)", async () => {
    msg("wk", "assistant", "第一条");
    msg("wk", "assistant", "第二条");
    msg("wk", "assistant", "第三条");
    const body = await fetchAgent("wk");
    expect(body.messages.map((m) => m.content)).toEqual(["第一条", "第二条", "第三条"]);
  });

  it("线头 messageCount 是 SQL GROUP BY 的真值,且**只数他自己**", async () => {
    msg("wk", "assistant", "我的话 1");
    msg("wk", "assistant", "我的话 2");
    msg(null, "user", "甲方的话");
    msg(null, "system", "平台通知");
    msg("bm", "assistant", "别人的话");

    const body = await fetchAgent("wk");
    const line = body.lines.find((l) => l.sessionId === MAIN);
    expect(line?.messageCount, "只数他自己的话").toBe(2);

    // 独立算一遍真值(**不是**复用实现的那条 SQL)
    const truth = db
      .prepare(
        `SELECT m.session_id AS sessionId, COUNT(*) AS n
           FROM session_messages m
           JOIN project_sessions s ON s.id = m.session_id
          WHERE s.project_id = ? AND m.agent_id = ?
          GROUP BY m.session_id`,
      )
      .all(P, "wk") as Array<{ sessionId: string; n: number }>;
    expect(truth.length).toBe(1);
    expect(line?.messageCount).toBe(truth[0]!.n);
  });

  it("多条线:每条线一个线头,`?sessionId=` 选线", async () => {
    msg("wk", "assistant", "主对话里的话", MAIN);
    msg("wk", "assistant", "第二条线里的话", THREAD);

    const all = await fetchAgent("wk");
    expect(all.lines.length).toBe(2);
    const ids = all.lines.map((l) => l.sessionId);
    expect(ids).toContain(MAIN);
    expect(ids).toContain(THREAD);
    // 线名复用 `sessionSummariesOf`:有 title 就是它,没有就是 null(**不编一个出来**)
    expect(all.lines.find((l) => l.sessionId === THREAD)?.title).toBe("第二版方案");
    expect(all.lines.find((l) => l.sessionId === MAIN)?.title).toBeNull();

    const picked = await fetchAgent("wk", `?sessionId=${THREAD}`);
    expect(picked.sessionId).toBe(THREAD);
    expect(picked.messages.map((m) => m.content)).toEqual(["第二条线里的话"]);
  });

  it("传一条**他真没消息的线** → 退回第一条线并说清选了哪条(不报错、也不静默换)", async () => {
    msg("wk", "assistant", "主对话里的话", MAIN);
    const body = await fetchAgent("wk", `?sessionId=${THREAD}`);
    expect(body.sessionId, "端点必须说清它实际选了哪条").toBe(MAIN);
    expect(body.messages.map((m) => m.content)).toEqual(["主对话里的话"]);
  });

  it("窗口:超出 limit 时 truncated=true,且**恰好 limit 条时不算截断**", async () => {
    for (let i = 0; i < 5; i += 1) msg("wk", "assistant", `产出 ${i}`);

    const over = await fetchAgent("wk", "?limit=3");
    expect(over.messages.length).toBe(3);
    expect(over.truncated).toBe(true);
    // 取的是**最近 3 条**,再倒回正序
    expect(over.messages.map((m) => m.content)).toEqual(["产出 2", "产出 3", "产出 4"]);
    // 线头的真值**不受窗口影响**
    expect(over.lines.find((l) => l.sessionId === MAIN)?.messageCount).toBe(5);

    // 负样本:恰好 limit 条 ⇒ **不是**截断(拿 `rows.length === limit` 判会误报)
    const exact = await fetchAgent("wk", "?limit=5");
    expect(exact.messages.length).toBe(5);
    expect(exact.truncated, "刚好取完不是截断").toBe(false);
  });

  it("一条线都没有 → lines/messages 空、sessionId 为 null(不是「有组但 0 条」)", async () => {
    const body = await fetchAgent("wk");
    expect(body.lines).toEqual([]);
    expect(body.messages).toEqual([]);
    expect(body.sessionId).toBeNull();
    expect(body.truncated).toBe(false);
  });

  it("**跨项目隔离**:别的项目的线与消息都不出现", async () => {
    insertProject(db, {
      id: "p-别的", name: "别的项目", client: "甲方", goal: "别的",
      status: "active", createdAt: clock,
    });
    insertSession(db, { id: "s-别的", projectId: "p-别的", createdAt: clock });
    msg("wk", "assistant", "本项目的话", MAIN);
    msg("wk", "assistant", "别的项目的话", "s-别的");

    const body = await fetchAgent("wk");
    const texts = body.messages.map((m) => m.content);
    expect(texts).toEqual(["本项目的话"]);
    expect(body.lines.map((l) => l.sessionId)).toEqual([MAIN]);
  });

  it("一个角色在**所有线**上的消息都能取到(不只主对话)", async () => {
    msg("wk", "assistant", "主对话里的话", MAIN);
    msg("wk", "assistant", "第二条线里的话", THREAD);
    const body = await fetchAgent("wk");
    const total = body.lines.reduce((n, l) => n + l.messageCount, 0);
    expect(total, "线头上的计数之和 = 他在这个项目里说了几句").toBe(2);
  });
});
