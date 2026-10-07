/**
 * W3-① · **封套落库**(migration 019)—— 「刷新之后判据消失」那个缺口的闭合判据
 *
 * ── 缺口的形状(修之前)──────────────────────────────────────────
 *
 * 显示判据是两半(`web/src/lib/data.ts` 的 `channelOf`):
 *
 *     进甲方通道 ⟺ 用户消息 ∨ `source === "broadcast"` ∨ `trigger.kind === "user"` 的回合正文
 *
 * 这两维此前**只在 WS 封套上**(内存里),库里一条都没落 ⇒ 流式那一路对,而
 * **REST 回填**那一路只能给 `origin: "unknown"` ⇒ 判据退化成「按角色的两跳」
 * ⇒ 业务经理(`clientFacing`)被工件/待办叫醒的那一轮正文,**刷新一次又出现在
 * 对话页上**(流式视图与刷新后视图不一致,而界面上看不出来)。
 *
 * ── 本文件钉住的四层(每一层都有正负样本)────────────────────────
 *
 *   1. **仓储**:`appendSessionMessage` 落两列 → `listSessionMessages` 原样读回;
 *      写口的**三条不变式**(`trigger_kind` 有值 ⟺ `origin_source === "turn"`)
 *      拒绝三种畸形;
 *   2. **读面**:`messageOriginOf` 把两列合成 `MessageOrigin` 的三个分支,
 *      并对畸形组合**抛**;
 *   3. **HTTP 两条读路**:`GET /projects/:id/messages`(对话页)与
 *      `GET /projects/:id/member-conversations`(成员页)都带 `origin` ——
 *      后者是**第二条**读路,它的 SQL 是**显式列名**(不是 `SELECT *`),
 *      漏了那两列时「新写的行」与「019 之前的存量行」在类型上长得一模一样;
 *   4. **schema**:两列的 CHECK 真的在(裸 SQL 塞非法值要被拒),
 *      而 `NULL/NULL`(存量行形状)必须被接受。
 *
 * ⚠️ 第 4 层为什么用裸 SQL 而不是走仓储:仓储的守卫会在**应用层**先抛,
 * 于是「CHECK 到底在不在」根本没被测到 —— 一个不存在的约束看起来和
 * 一个存在的约束一模一样(本项目三类静默失败之一)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import {
  appendSessionMessage, insertSession, listSessionMessages,
  type SessionMessageSource, type SessionMessageTriggerKind,
} from "../../src/platform/storage/repo/sessions.js";
import { listProjectMessages, messageOriginOf } from "../../src/platform/transport/views.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { MessageOrigin, SessionMessageView } from "@shared/types/platform.js";

const P = "p-origin";
const S = "s-origin";
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
  insertSession(db, { id: S, projectId: P, createdAt: clock });
  for (const [id, role, name] of [
    ["bm", "business_manager", "业务经理"],
    ["wk", "research_worker", "研究员"],
  ] as const) {
    insertAgent(db, { id, role, specialization: null, displayName: name, createdAt: clock });
  }
});

afterEach(() => {
  db.close();
});

/** 落一条助手消息,封套由调用方给(这就是宿主 `serve.ts` 那几处的形状)。 */
function put(
  originSource: SessionMessageSource | null,
  triggerKind: SessionMessageTriggerKind | null,
  agentId: string | null = "bm",
  content = "正文",
): string {
  seq += 1;
  const id = `m${seq}`;
  appendSessionMessage(db, {
    id, sessionId: S, agentId, kind: "assistant", content, createdAt: (clock += 1),
    originSource, triggerKind,
  });
  return id;
}

function app(over?: Partial<HttpDeps>) {
  return createPlatformApp({
    db,
    dataDir: "/tmp/w3-origin-test",
    cwd: "/tmp",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/w3-origin-test", factoryDir: "/tmp/w3-origin-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
    ...over,
  });
}

// ── 1. 仓储:写进去、读回来 ─────────────────────────────────────

describe("① 仓储:`appendSessionMessage` 落两列,`listSessionMessages` 原样读回", () => {
  it("三种合法形状逐条往返(turn/user、turn/todo、broadcast/null)", () => {
    put("turn", "user", "bm", "甲方问的那一轮");
    put("turn", "todo", "wk", "被待办叫醒的那一轮");
    put("broadcast", null, "bm", "播报");
    put(null, null, null, "平台通知");

    const rows = listSessionMessages(db, S);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => [r.originSource, r.triggerKind])).toEqual([
      ["turn", "user"],
      ["turn", "todo"],
      ["broadcast", null],
      [null, null],
    ]);
    // 正样本自检:读回的确实是**四条不同的**行(不是同一行被数了四遍)
    expect(new Set(rows.map((r) => r.id)).size).toBe(4);
  });

  it("写口的不变式:三种畸形一律**抛**(不静默降级成一个猜的封套)", () => {
    const bad: Array<[SessionMessageSource | null, SessionMessageTriggerKind | null, string]> = [
      ["turn", null, "回合必须有触发维度"],
      ["broadcast", "user", "播报不许带触发维度"],
      [null, "todo", "没有封套就不该有触发维度"],
    ];
    for (const [source, kind, why] of bad) {
      expect(() => put(source, kind), why).toThrow(/封套形状不合法/);
    }
    // 负样本自检:上面三次抛之后,表里一条都没多
    expect(listSessionMessages(db, S)).toHaveLength(0);
  });

  it("`null/NULL` 是**合法**形状(019 之前的存量行 / 平台通知)", () => {
    expect(() => put(null, null)).not.toThrow();
    expect(listSessionMessages(db, S)[0]?.originSource).toBeNull();
  });
});

// ── 2. 读面:两列 → MessageOrigin ──────────────────────────────

describe("② 读面:`messageOriginOf` 合成 `MessageOrigin`", () => {
  it("三个分支逐条对上(且播报那一支**不读** trigger)", () => {
    put("turn", "user");
    put("turn", "todo");
    put("broadcast", null);
    put(null, null);
    const origins = listSessionMessages(db, S).map(messageOriginOf);
    expect(origins).toEqual([
      { source: "turn", trigger: { kind: "user" } },
      { source: "turn", trigger: { kind: "todo" } },
      { source: "broadcast" },
      { source: "unknown" },
    ] satisfies MessageOrigin[]);
  });

  it("畸形组合(绕过写口写出来的)**抛**,不猜", () => {
    expect(() =>
      messageOriginOf({
        id: "x", sessionId: S, agentId: "bm", kind: "assistant",
        content: "c", createdAt: 1, originSource: "turn", triggerKind: null,
      }),
    ).toThrow(/封套形状不合法/);
    expect(() =>
      messageOriginOf({
        id: "x", sessionId: S, agentId: "bm", kind: "assistant",
        content: "c", createdAt: 1, originSource: null, triggerKind: "user",
      }),
    ).toThrow(/封套形状不合法/);
  });
});

// ── 3. HTTP:两条读路都带 origin ────────────────────────────────

describe("③ HTTP:对话页与成员页**两条**读路都带 origin", () => {
  it("`GET /projects/:id/messages`(对话页)带封套", async () => {
    put("turn", "todo", "bm", "工件触发的内部交代");
    put("broadcast", null, "bm", "播报:第三条路线已交付");

    const res = await app().request(`/api/projects/${P}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: SessionMessageView[] };
    expect(body.messages.map((m) => m.origin)).toEqual([
      { source: "turn", trigger: { kind: "todo" } },
      { source: "broadcast" },
    ]);
  });

  it("`GET /projects/:id/member-conversations`(成员页 —— **显式列名**的那条 SQL)也带封套", async () => {
    put("turn", "todo", "bm", "内部交代");

    const res = await app().request(`/api/projects/${P}/member-conversations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ agentId: string | null; messages: SessionMessageView[] }>;
    };
    const bm = body.groups.find((g) => g.agentId === "bm");
    expect(bm, "bm 组必须存在").toBeDefined();
    // ⚠️ 这条 SQL 是 `SELECT m.id, …, m.origin_source, m.trigger_kind`(不是 `*`):
    // 漏列时这里会拿到 `unknown`,而**存量行也是 `unknown`** —— 两者在类型上区分不了。
    expect(bm?.messages[0]?.origin).toEqual({ source: "turn", trigger: { kind: "todo" } });
  });

  it("`listProjectMessages`(对话页那条归并读路)也带封套 —— 存量行如实是 unknown", () => {
    put("turn", "todo");
    put(null, null); // 019 之前的存量行形状
    expect(listProjectMessages(db, P, 100).map((m) => m.origin)).toEqual([
      { source: "turn", trigger: { kind: "todo" } },
      { source: "unknown" },
    ]);
  });
});

// ── 4. schema:CHECK 真的在 ─────────────────────────────────────

describe("④ schema:两列的 CHECK 真的在(裸 SQL 验,绕开仓储的守卫)", () => {
  const rawInsert = (source: string | null, kind: string | null): void => {
    seq += 1;
    db.prepare(
      `INSERT INTO session_messages
         (id, session_id, agent_id, kind, content, created_at, origin_source, trigger_kind)
       VALUES (?, ?, 'bm', 'assistant', 'c', ?, ?, ?)`,
    ).run(`raw${seq}`, S, (clock += 1), source, kind);
  };

  it("负样本:两个闭集各自拒绝未定义取值", () => {
    expect(() => rawInsert("bogus", null)).toThrow(/CHECK/);
    expect(() => rawInsert("turn", "bogus")).toThrow(/CHECK/);
    // 自检:两次都真的没写进去(而不是「抛了但其实写进去了」)
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM session_messages`).get(),
    ).toEqual({ n: 0 });
  });

  it("正样本:`NULL/NULL` 与四种合法组合都接受", () => {
    rawInsert(null, null);
    rawInsert("turn", "user");
    rawInsert("turn", "todo");
    rawInsert("broadcast", null);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM session_messages`).get(),
    ).toEqual({ n: 4 });
  });

  it("migration 019 已登记进 `schema_version`(不是「文件在但没跑」)", () => {
    const row = db
      .prepare(`SELECT name FROM schema_version WHERE version = 19`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("message_origin");
  });
});
