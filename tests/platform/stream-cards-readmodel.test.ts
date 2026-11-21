/**
 * v5(2026-11-20)「表态卡进流」的三个新读面 —— 塌缩事实的数据来源
 *
 * 对话流里的表态卡要**原地塌缩成一行事实**,而不是完结后凭空消失。三份塌缩
 * 事实各有自己的读面,这里逐个钉住:
 *
 *   ① `GET /api/client-questions` 的 `answered` —— 已答复提问行(塌缩 = 「已答复」行),
 *      `consumedAt` 区分「整理中 / 已落 decision 工件」两态(F3 窗口可见性迁到卡上);
 *   ② `GET /api/projects/:id` 的 `recentDeliveryVerdicts` —— 已裁决交付物的最新裁决
 *      (塌缩 = 「已接受 / 要改」行;裁决一落交付物就离开 awaitingAcceptance,
 *      没有这一份,验收卡就只能凭空消失);
 *   ③ `WorkView.confirmedAt` —— 计划卡确认后的塌缩(「已确认开工 · N 条」按批次锚定)。
 *
 * ⚠️ 走**生产写口**造数据(insertArtifact + recordClientQuestion / markClientQuestionAnswered
 * / insertDeliveryVerdict)—— 夹具绕过接线测出来的绿,保护不了接线(020 那次
 * 「工件落了、台账没落」的教训)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject, getProjectRow } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertArtifact, getArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import {
  recordClientQuestion, markClientQuestionAnswered, consumeClientAnswers,
} from "../../src/platform/storage/repo/clientQuestions.js";
import { insertDeliveryVerdict } from "../../src/platform/storage/repo/deliveryVerdicts.js";
import { listAllClientQuestions, toProjectDetail } from "../../src/platform/transport/views.js";

function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "美股平台方案", client: "个人用户",
    goal: "出一份完整方案文档", status: "active", createdAt: T0,
  });
  // 工件/工作项的作者列有指向 agents 的外键 —— 先把组织建出来。
  ensureProjectOrg(db, "p1", T0);
});
afterEach(() => db.close());

/** 生产写口:业务经理问甲方(工件 + 台账,同 tools/client.ts 的一对调用)。 */
function askClient(question: string): string {
  const id = `q_${++seq}`;
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null, kind: "client_question",
    status: "open", authorAgentId: "bm", title: question, ...bodyAt(`artifacts/${id}.md`, question),
    metadataJson: null, createdAt: T0 + seq, updatedAt: T0 + seq, workId: null,
  });
  recordClientQuestion(db, { questionArtifactId: id, projectId: "p1", askedBy: "bm", askedAt: T0 + seq });
  return id;
}

/** 生产写口:甲方答复(decision 工件 + 台账回填)。 */
function answerClient(questionId: string, at: number): string {
  const decId = `dec_${++seq}`;
  insertArtifact(db, {
    id: decId, projectId: "p1", conversationId: null, kind: "decision",
    status: "accepted", authorAgentId: "bm", title: `甲方答复:${questionId}`,
    ...bodyAt(`artifacts/${decId}.md`, "答案"), metadataJson: null,
    createdAt: at, updatedAt: at, workId: null,
  });
  db.prepare(`UPDATE artifacts SET status = 'accepted' WHERE id = ?`).run(questionId);
  markClientQuestionAnswered(db, questionId, decId, at);
  return decId;
}

/** 生产写口:一份交付物(验收裁决的靶子)。 */
function deliverable(id: string, title: string, at: number): string {
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null, kind: "deliverable",
    status: "accepted", authorAgentId: "wk", title, ...bodyAt(`artifacts/${id}.md`, "正文"),
    metadataJson: null, createdAt: at, updatedAt: at, workId: null,
  });
  return id;
}

describe("① answered 读面:已答复提问的塌缩事实", () => {
  it("答复落库 ⇒ answered 有一行;consumedAt 为 null = 还在 F3 窗口(整理中)", () => {
    const q = askClient("现金账户档位选哪个?");
    const dec = answerClient(q, T0 + 50);
    const { answered } = listAllClientQuestions(db);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({
      id: q, projectId: "p1",
      question: "现金账户档位选哪个?", // 与待答卡的 question 同源(工件标题)
      answeredAt: T0 + 50,
      consumedAt: null,
      decisionArtifactId: dec,
    });
  });

  it("业务经理处置(consume)之后 consumedAt 落值 —— 前端据此显示「已落 decision 工件」", () => {
    const q = askClient("问题 A");
    answerClient(q, T0 + 50);
    consumeClientAnswers(db, "p1", "bm", T0 + 60);
    const { answered } = listAllClientQuestions(db);
    expect(answered[0]?.consumedAt).toBe(T0 + 60);
  });

  it("没答复的不进 answered(open 的仍在 questions,两边不重复)", () => {
    askClient("还没答的问题");
    const { answered, questions } = listAllClientQuestions(db);
    expect(answered).toEqual([]);
    expect(questions).toHaveLength(1);
  });

  it("提问工件被清过库 ⇒ answered 少一行,不编文本(读不到不是空话)", () => {
    const q = askClient("会被清掉的问题");
    answerClient(q, T0 + 50);
    db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(q);
    expect(getArtifact(db, q)).toBeNull();
    expect(listAllClientQuestions(db).answered).toEqual([]);
  });
});

describe("② recentDeliveryVerdicts 读面:裁决塌缩事实", () => {
  it("裁决落库 ⇒ detail 里有一行(标题来自工件,时刻 = 裁决落库时刻)", () => {
    deliverable("art_d1", "最终交付物", T0 + 10);
    insertDeliveryVerdict(db, { projectId: "p1", artifactId: "art_d1", verdict: "accept", note: null, createdAt: T0 + 20 });
    const detail = toProjectDetail(db, getProjectRow(db, "p1")!);
    expect(detail?.recentDeliveryVerdicts).toEqual([
      { artifactId: "art_d1", title: "最终交付物", verdict: "accept", note: null, at: T0 + 20 },
    ]);
  });

  it("append-only 改判:每份交付物只给**最新**一条(reject 覆盖 accept)", () => {
    deliverable("art_d1", "最终交付物", T0 + 10);
    insertDeliveryVerdict(db, { projectId: "p1", artifactId: "art_d1", verdict: "accept", note: null, createdAt: T0 + 20 });
    insertDeliveryVerdict(db, { projectId: "p1", artifactId: "art_d1", verdict: "reject", note: "数据源错了", createdAt: T0 + 30 });
    const detail = toProjectDetail(db, getProjectRow(db, "p1")!);
    expect(detail?.recentDeliveryVerdicts).toHaveLength(1);
    expect(detail?.recentDeliveryVerdicts[0]).toMatchObject({ verdict: "reject", note: "数据源错了", at: T0 + 30 });
  });

  it("两份交付物 = 两行,时间降序(塌缩行按裁决时刻归并进流)", () => {
    deliverable("art_d1", "交付物一", T0 + 10);
    deliverable("art_d2", "交付物二", T0 + 11);
    insertDeliveryVerdict(db, { projectId: "p1", artifactId: "art_d1", verdict: "accept", note: null, createdAt: T0 + 20 });
    insertDeliveryVerdict(db, { projectId: "p1", artifactId: "art_d2", verdict: "reject", note: null, createdAt: T0 + 30 });
    const detail = toProjectDetail(db, getProjectRow(db, "p1")!);
    expect(detail?.recentDeliveryVerdicts.map((v) => v.artifactId)).toEqual(["art_d2", "art_d1"]);
  });

  it("裁决行不可能比工件活得久(FK);读面的 skip 分支只是 fail-closed 兜底", () => {
    // ⚠️ 这里钉的是**可达的不变量**:`delivery_verdicts.artifact_id` 指向工件,
    // 删工件会被 FK 拒 —— 所以「工件没了但裁决还在」根本不会发生(与
    // client_questions 不同,那张台账没有这条外键,清库场景才真实可达)。
    // recentDeliveryVerdictsOf 里的 `getArtifact === null ⇒ continue` 保留为
    // 兜底(与 awaitingAcceptanceOf 同一条纪律),但它的输入被 FK 保证非空。
    const id = deliverable("art_d1", "交付物", T0 + 10);
    insertDeliveryVerdict(db, { projectId: "p1", artifactId: id, verdict: "accept", note: null, createdAt: T0 + 20 });
    expect(() => db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id)).toThrow();
    expect(toProjectDetail(db, getProjectRow(db, "p1")!)?.recentDeliveryVerdicts).toHaveLength(1);
  });
});

describe("③ WorkView.confirmedAt:计划卡确认塌缩的锚", () => {
  it("未确认 ⇒ null;确认 ⇒ 原样透出(migration 033)", () => {
    insertWork(db, {
      id: "w1", projectId: "p1", parentWorkId: null, title: "没确认的活", goal: "g",
      status: "open", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    insertWork(db, {
      confirmedAt: T0 + 99,
      id: "w2", projectId: "p1", parentWorkId: null, title: "确认过的活", goal: "g",
      status: "in_progress", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    const detail = toProjectDetail(db, getProjectRow(db, "p1")!);
    const byId = new Map(detail?.works.map((w) => [w.id, w.confirmedAt]));
    expect(byId.get("w1")).toBeNull();
    expect(byId.get("w2")).toBe(T0 + 99);
  });
});
