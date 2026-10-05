/**
 * C4 · 交付会话(设计 1 §2.11.6):`ensureSession` 的显式通道 + `openDeliverableSession`
 *
 * ── 这个文件守的是 C4 真正的危险面 ───────────────────────────────
 *
 * C1 / A3 实测报过的那条地雷:**`ensureSession` 挑「最新那一条」**。
 *
 *   listSessions(db, projectId)  ORDER BY created_at DESC   ← 新的在前
 *   ensureSession(...)           existing[0]                 ← 于是拿到「最新那条」
 *
 * 交付会话一建出来,后续**所有角色**的消息(六个调用点)都会被写进它。表现是
 * **静默的**:消息一条不少,只是分错了会话 —— 界面上按 `agentId` 过滤仍然成立,
 * 「这条消息属于哪条对话」却已经错了。
 *
 * ⇒ 所以拆法不是「把排序反过来」,而是**让调用点显式声明通道**,库里按
 * `(project_id, channel)` 取。下面三组断言钉住的就是这件事:
 *
 *   ① **`client` 有明确回退**:交付对话还没开出来时落回项目内部会话 ——
 *      没有它,任何一个 `client` 调用点都会给项目**凭空造出**一条会话,
 *      「拆地雷不改行为」当场为假;
 *   ② **跨通道绝不串**(回归判据):交付对话建出来之后,`internal` 的消息
 *      (工作项执行 / 系统通知)必须留在项目主会话里;
 *   ③ **`openDeliverableSession` 幂等**:同一条交付物只建一条会话
 *      (at-least-once 的重放是安全的),而且它同时是 `handover` 的终止判据
 *      (读面 `runtime/dispatcher.ts` 的 `deliveredArtifactIds` 读的就是这一列)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import {
  appendSessionMessage, findSessionByChannel, getSession,
  insertSession, listSessionMessages, listSessions, openDeliverableSession,
  deliverableSessionId,
} from "../../src/platform/storage/repo/sessions.js";
// `ensureSession` 住在 transport/hub(它是「会话池」那条判据的维护点)
import { ensureSession } from "../../src/platform/transport/hub.js";

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

const newId = (p: string): string => `${p}_${++seq}`;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "语音机器人调研", client: "甲方",
    goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
});
afterEach(() => db.close());

/** 一条已验收的交付物(项目经理整合完的现场)。 */
function mkDeliverable(id = "d1"): string {
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null,
    kind: "deliverable", status: "accepted", authorAgentId: "pm",
    title: `交付物 ${id}`, body: "正文", metadataJson: null,
    createdAt: T0 + 100, updatedAt: T0 + 100, workId: null,
  });
  return id;
}

const open = (artifactId: string, at = T0 + 1000) =>
  openDeliverableSession(db, {
    projectId: "p1", deliverableArtifactId: artifactId, channel: "client", createdAt: at,
  });

const mainSessionId = () => ensureSession(db, "p1", T0, newId, "internal");
const clientSessionId = () => ensureSession(db, "p1", T0, newId, "client");

// ══════════════════════════════════════════════════════════════════
// ① 通道解析:六处调用点各自声明的实参,在库里是什么
// ══════════════════════════════════════════════════════════════════

describe("C4 · `ensureSession` 按 `(project_id, channel)` 取,不再挑「最新那条」", () => {
  it("**交付对话还不存在时,`client` 明确回退到项目内部会话**(拆地雷不改行为)", () => {
    // 第一次调用的是「甲方通道」的调用点(用户消息 / 播报 / 业务经理的回合)。
    // 旧写法在这里建出一条会话;新写法必须**建的是内部会话**,并让两种通道解析到
    // 同一条 —— 否则每个项目都会凭空多出一条会话(交付之前根本不存在第二条对话)。
    const first = clientSessionId();
    expect(mainSessionId(), "两种通道在交付之前必须解析到同一条会话").toBe(first);
    expect(listSessions(db, "p1")).toHaveLength(1);
    expect(getSession(db, first)).toMatchObject({ channel: "internal", deliverableArtifactId: null });
    // 负样本自检:再要一次内部通道**不会**又建一条
    expect(mainSessionId()).toBe(first);
    expect(listSessions(db, "p1")).toHaveLength(1);
  });

  it("首次调用声明 `internal` 也一样 —— 惰性建出来的会话**一律**是 internal", () => {
    const s = mainSessionId();
    expect(getSession(db, s)).toMatchObject({ channel: "internal" });
    // 交付对话只能由**平台**在 `handover` 成功后开:调用点声明 `client` 变不出它
    expect(clientSessionId()).toBe(s);
    expect(listSessions(db, "p1").map((x) => x.channel)).toEqual(["internal"]);
  });

  it("交付对话开出来之后:`client` → 交付对话,`internal` → 项目主会话(两条,各归各)", () => {
    const main = mainSessionId();
    const d = mkDeliverable("d1");
    const opened = open(d);
    expect(opened.created).toBe(true);
    expect(clientSessionId(), "甲方通道必须落在交付对话上").toBe(opened.sessionId);
    expect(mainSessionId(), "内部通道必须留在项目主会话上").toBe(main);
    expect(opened.sessionId).not.toBe(main);
  });

  it("**回归判据**:交付对话建出来之后再写一条 `internal` 的消息,它不得落进交付对话", () => {
    const main = mainSessionId();
    const opened = open(mkDeliverable("d1"));

    // 这就是宿主里 `runWorkInSession` 的形态(通道实参 `internal`)
    const workerSession = mainSessionId();
    appendSessionMessage(db, {
      id: "m_worker", sessionId: workerSession, agentId: "wk", kind: "assistant",
      content: "worker 的产出", createdAt: T0 + 2000,
      // 执行那条路今天全是 `todo` 触发的(封套与本来测的通道归属无关,
      // 但照实写 —— 见 `appendSessionMessage` 的必填实参说明)
      originSource: "turn", triggerKind: "todo",
    });
    // 系统通知那条也是 `internal`(announceDrain)
    appendSessionMessage(db, {
      id: "m_sys", sessionId: mainSessionId(), agentId: null, kind: "system",
      content: "⚠️ 组织停止推进", createdAt: T0 + 2001,
      originSource: null, triggerKind: null, // 平台通知不属于任何封套
    });
    // 双通道各写一条(甲方说的话 / 业务经理的播报走 `client`)
    appendSessionMessage(db, {
      id: "m_user", sessionId: clientSessionId(), agentId: null, kind: "user",
      content: "这份交付里第三条路线的依据是什么?", createdAt: T0 + 2002,
      originSource: "turn", triggerKind: "user", // 甲方亲口说的那一轮
    });

    expect(
      listSessionMessages(db, opened.sessionId).map((m) => m.id),
      "交付对话里只该有甲方通道的消息 —— worker / 系统通知串进来就是那条地雷复发",
    ).toEqual(["m_user"]);
    expect(listSessionMessages(db, main).map((m) => m.id)).toEqual(["m_worker", "m_sys"]);
  });

  it("**两次交付**:`client` 取最新那条(次序是全序:`created_at DESC, id DESC`)", () => {
    const d1 = open(mkDeliverable("d1"), T0 + 1000).sessionId;
    const d2 = open(mkDeliverable("d2"), T0 + 2000).sessionId;
    expect(clientSessionId()).toBe(d2);
    // 同一个 `created_at` 也不能漂:id 是第二个排序键
    const d3 = open(mkDeliverable("d3"), T0 + 2000).sessionId;
    expect(clientSessionId()).toBe([d2, d3].sort().reverse()[0]);
    expect(d1).not.toBe(d2);
    // 内部通道不受影响(每个项目仍然只有一条)
    expect(listSessions(db, "p1").filter((s) => s.channel === "internal")).toHaveLength(0);
    expect(mainSessionId()).toBe(mainSessionId());
  });

  it("接待会话不受通道实参影响(`project_id IS NULL` 那条全局唯一的会话)", () => {
    const a = ensureSession(db, null, T0, newId, "client");
    const b = ensureSession(db, null, T0 + 1, newId, "internal");
    expect(b).toBe(a);
    expect(getSession(db, a)).toMatchObject({ projectId: null, channel: "internal" });
    expect(listSessions(db, null)).toHaveLength(1);
  });

  it("项目不存在时两条通道都响亮拒绝(不静默建一条读不出来的会话)", () => {
    expect(() => ensureSession(db, "p_nope", T0, newId, "internal")).toThrow(/不存在/);
    expect(() => ensureSession(db, "p_nope", T0, newId, "client")).toThrow(/不存在/);
  });

  it("`findSessionByChannel` 是那条判据本身:接待会话(project_id IS NULL)不会被它查出来", () => {
    insertSession(db, { id: "s_intake", projectId: null, createdAt: T0 });
    expect(findSessionByChannel(db, "p1", "internal")).toBeNull();
    expect(findSessionByChannel(db, "p1", "client")).toBeNull();
    const s = mainSessionId();
    expect(findSessionByChannel(db, "p1", "internal")?.id).toBe(s);
    expect(findSessionByChannel(db, "p1", "client")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// ② openDeliverableSession:幂等 + 建出来的形状
// ══════════════════════════════════════════════════════════════════

describe("C4 · `openDeliverableSession`(平台在 `handover` 回合成功后开的那条对话)", () => {
  it("建出来的行:`channel='client'` + `deliverable_artifact_id` 指向那条交付物", () => {
    const d = mkDeliverable("d1");
    const r = open(d);
    expect(r).toEqual({ created: true, sessionId: deliverableSessionId(d) });
    expect(getSession(db, r.sessionId)).toEqual({
      id: "s_deliv_d1", projectId: "p1", createdAt: T0 + 1000,
      channel: "client", deliverableArtifactId: "d1",
    });
    // 它是**没有消息**的一条空对话:正文由业务经理随后的回合说,平台不替它叙事
    expect(listSessionMessages(db, r.sessionId)).toEqual([]);
  });

  it("**幂等**:同一条交付物只建一条会话(at-least-once 的重放安全)", () => {
    const d = mkDeliverable("d1");
    const first = open(d, T0 + 1000);
    const second = open(d, T0 + 9999);
    expect(second).toEqual({ created: false, sessionId: first.sessionId });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM project_sessions WHERE deliverable_artifact_id = ?`).get(d),
    ).toEqual({ n: 1 });
    // 幂等判据读的是**库**(那一列),不是本次调用的入参
    expect(listSessions(db, "p1")).toHaveLength(1);
  });

  it("**悬空引用被外键响亮拒掉**(NO ACTION,不是 CASCADE —— 删交付物不该连带删对话)", () => {
    expect(() => open("d_不存在")).toThrow(/FOREIGN KEY constraint failed/i);
    expect(listSessions(db, "p1")).toHaveLength(0);
  });

  it("`deliverable_artifact_id` 没有 ON DELETE 子句:删掉交付物**不**静默删掉那场对话", () => {
    // 这条断言读 schema 的原文,而不是靠行为推 —— 行为上「删了会怎样」取决于
    // 那一刻有没有外键在管,而 schema 原文是**判据本身**。
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='project_sessions'`)
      .get() as { sql: string };
    expect(row.sql).toMatch(/deliverable_artifact_id\s+TEXT\s+REFERENCES\s+artifacts\(id\)/i);
    expect(row.sql, "加了 ON DELETE 子句就改了失效方向")
      .not.toMatch(/deliverable_artifact_id\s+TEXT\s+REFERENCES\s+artifacts\(id\)\s+ON\s+DELETE/i);
  });

  it("`insertSession` 的缺省通道是 `internal`(既有调用方与测试不必声明它)", () => {
    insertSession(db, { id: "s_plain", projectId: "p1", createdAt: T0 });
    expect(getSession(db, "s_plain")).toMatchObject({ channel: "internal", deliverableArtifactId: null });
  });
});
