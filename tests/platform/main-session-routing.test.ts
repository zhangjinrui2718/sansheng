/**
 * **「甲方看得到的那条对话」只有一处定义:`ensureMainSession`(按 `kind='main'` 认)**
 *
 * ── 这个文件钉的是 2026-10-07 真机事故的判据 ────────────────────────────
 *
 * 用户报的现象:「催收语音机器人技术方案这个项目都交付了,但是业务经理不给甲方回复」。
 * 库里的事实是:甲方自己那条主对话(`kind='main'`)从 `14:35:59` 起**3.5 小时一个字
 * 都没有**,而「已交付完成」那条播报躺在第 7 条**交付线**里 —— 因为那条线是
 * `handover` 为最后一份已验收交付物开的。
 *
 * 根因不是「模型不说话」,是**选线规则**:
 *
 *   `ensureSession(..., channel)` 的判据是 `(project_id, channel)` **取最新**那条,
 *   而它被当成了「主对话」。项目里一旦出现别的会话,这个「主对话」就漂:
 *
 *   · `channel='client'`:每份已验收交付物开一条交付线 ⇒ 返回**最后一条交付线**;
 *   · `channel='internal'`:甲方「另开一条」建的是 `kind='thread'` ⇒ 返回**最新那条线程**。
 *
 * 而前端默认展示、甲方发消息默认落的都是 `kind='main'` 那条(`web/src/stores/chat.ts`
 * 取 `s.kind === "main"`)⇒ 甲方的话与业务经理的回话**劈到两条线上**,屏幕上就是
 * 「不给回复」。
 *
 * 判据因此按 `kind` 认(**会话自己的身份**),不按 `channel` 认(channel 说的是
 * 「这条线是谁的」,主对话的 channel 本来就是 `internal`)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertSession, listSessions } from "../../src/platform/storage/repo/sessions.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { ensureMainSession, PlatformHub } from "../../src/platform/transport/hub.js";

let db: Database.Database;
let seq = 0;
const newId = (p: string): string => `${p}_test${++seq}`;

beforeEach(() => {
  seq = 0;
  db = openPlatformMemoryDb();
  insertProject(db, {
    id: "p1", name: "催收语音机器人技术方案", client: "甲方",
    goal: "g", status: "active", createdAt: 1,
  });
});
afterEach(() => {
  db.close();
});

const kindsOf = () =>
  listSessions(db, "p1").map((s) => ({ id: s.id, kind: s.kind, channel: s.channel }));

describe("ensureMainSession · 主对话按 kind 认,不按「谁最新」认", () => {
  it("项目里已有交付线 + 甲方另开的线程时,仍然返回 kind='main' 那条", () => {
    // 主对话(甲方说话的地方)
    insertSession(db, { id: "s_main", projectId: "p1", createdAt: 10, channel: "internal" });
    // 甲方「另开一条」⇒ kind='thread' + channel='internal'(这不是主对话)
    insertSession(db, {
      id: "s_thread", projectId: "p1", createdAt: 20, channel: "internal",
      kind: "thread", title: "问一下进度",
    });
    // `handover` 为一份已验收交付物开的交付线(更晚 ⇒ 旧判据会挑中它)。
    // `deliverable_artifact_id` 有外键,所以工件行得真在库里(027 起正文还住文件,
    // 这里按同一套「落点三列」造出来,不是占位串)。
    insertAgent(db, {
      id: "pm", role: "project_manager", displayName: "项目经理", createdAt: 1,
    });
    insertArtifact(db, {
      id: "d1", projectId: "p1", conversationId: null, kind: "deliverable",
      status: "accepted", authorAgentId: "pm", title: "整合交付", metadataJson: null,
      bodyPath: "artifacts/d1.md", bodySha256: "0".repeat(64), bodyBytes: 1,
      createdAt: 30, updatedAt: 30, workId: null,
    });
    insertSession(db, {
      id: "s_deliv", projectId: "p1", createdAt: 30, channel: "client",
      kind: "thread", title: "整合交付", deliverableArtifactId: "d1",
    });

    expect(
      ensureMainSession(db, "p1", 40, newId),
      "主对话被交付线/甲方开的线程抢走,就是真机那次「业务经理不给回复」的机制",
    ).toBe("s_main");
  });

  it("没有主对话时惰性建一条,且建出来的**就是** `kind='main'`(不是又一条线程)", () => {
    insertSession(db, {
      id: "s_thread", projectId: "p1", createdAt: 20, channel: "internal",
      kind: "thread", title: "问一下进度",
    });

    const id = ensureMainSession(db, "p1", 40, newId);
    expect(id).not.toBe("s_thread");
    const row = listSessions(db, "p1").find((s) => s.id === id);
    expect(row?.kind, "惰性建的必须是主对话 —— 否则下一次调用还会挑错").toBe("main");
    // 幂等:再问一次拿同一条,不会每次叫醒都建新的
    expect(ensureMainSession(db, "p1", 50, newId)).toBe(id);
    expect(kindsOf().filter((s) => s.kind === "main")).toHaveLength(1);
  });

  it("**播报的接线**也走主对话:`tell_client` 不许掉进交付线", async () => {
    // ⚠️ 这条钉的是**接线**,不是 `ensureMainSession` 本身 —— 只测那个函数的话,
    // `hub.ts` 的 `tell` 哪天被改回 `ensureSession(..., 'client')` 没人会发现
    // (真机事故里就是它把「已交付完成」那条播报送进了第 7 条交付线)。
    // 变异自检:把 `tell` 改回 `ensureSession(..., 'client')`,这条当场变红。
    insertAgent(db, {
      id: "bm", role: "business_manager", displayName: "业务经理", createdAt: 1,
    });
    insertSession(db, { id: "s_main", projectId: "p1", createdAt: 10, channel: "internal" });
    insertSession(db, {
      id: "s_deliv", projectId: "p1", createdAt: 20, channel: "client",
      kind: "thread", title: "整合交付",
    });
    const hub = new PlatformHub(
      { db, now: () => 30, newId: newId },
      {
        onUserMessage: async () => undefined,
        onAnswerQuestion: async () => undefined,
        onInterrupt: () => undefined,
      },
    );
    await hub.clientChannel.tell({ projectId: "p1", message: "交付物到了", agentId: "bm" });

    const rows = db
      .prepare(
        `SELECT session_id, content FROM session_messages
          WHERE session_id IN (SELECT id FROM project_sessions WHERE project_id = 'p1')`,
      )
      .all() as Array<{ session_id: string; content: string }>;
    expect(rows, "播报落主对话 —— 甲方在他的对话里就该看到这句").toEqual([
      { session_id: "s_main", content: "交付物到了" },
    ]);
  });

  it("接待会话(projectId === null)仍然是那条唯一的会话,不另建", () => {
    insertSession(db, { id: "s_intake", projectId: null, createdAt: 1 });
    expect(ensureMainSession(db, null, 2, newId)).toBe("s_intake");
    expect(listSessions(db, null)).toHaveLength(1);
  });

  it("项目不存在时响亮失败(与 ensureSession 同一条纪律:不许往不存在的项目里写消息)", () => {
    expect(() => ensureMainSession(db, "p_missing", 1, newId)).toThrow(/不存在/);
  });
});
