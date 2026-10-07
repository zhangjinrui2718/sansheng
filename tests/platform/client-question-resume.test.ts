/**
 * 020 · `resume_client`:甲方答复了业务经理的提问,**必须有人被叫醒**
 *
 * ── 这一批为什么值得单独一个文件 ─────────────────────────────────
 *
 * 真机事故(2026-10-06 09:09,项目「美股自动化交易平台方案设计」):
 *
 *   09:08:16 业务经理 `ask_client` 提问「W1 数据源组合,您想怎么走?」
 *   09:09:26 甲方在待答面板点了答复 → `POST /api/client-questions/:id/answer`
 *            写了 decision 工件 + `answers` 审计边 + 提问转 `accepted`
 *   09:12:17 `GET /live` ⇒ **四个角色 todos 全空** / `openWorks: 0` / `runningTurns: 0`
 *
 * 答复**确实在库里**(decision 工件在那儿,审计边在那儿),而系统再没有产生过
 * 一条消息。根因不是答复没记下来,是**没有任何一行记下「答复到了、他还没看」** ——
 * 于是排空器每 10 秒查一次库,每次都读到「无事可做」,而「无事可做」与
 * 「组织已经把活干完了」在日志里长得一模一样。
 *
 * 它是 7-L 那次修复的**漏网之鱼**:「提问者进 blocked、但对方不会主动知道」
 * 当时只治了 agent↔agent 的 `asks` 表(`answer_pending_ask`),而
 * `client_question` 是**另一条通道**。同一个病,两条通道只治了一条。
 *
 * ── 这个文件钉的四件事 ──────────────────────────────────────────
 *
 *   ① **负样本**:提问还没被答复时,**一条待办都不许有**。球在甲方那边,
 *      每 10 秒叫醒业务经理就是空转 —— 与 `resolve_blocked_work` 的抑制条件
 *      是同一条纪律的两面。这条不钉,规则会退化成「每 10 秒烧一次 token」。
 *   ② **正样本**:答复一落库,下一次排空就有 `resume_client`,而且排第一。
 *   ③ **终止判据**:处置完之后不再有 —— 靠 `consumed_at`,不靠尝试预算。
 *   ④ **at-least-once**:回合失败/被中断**不消费**,下次排空重来。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertWork, markWorkReviewed } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { openDeliverableSession } from "../../src/platform/storage/repo/sessions.js";
import {
  recordClientQuestion, markClientQuestionAnswered, listUnconsumedClientAnswers,
  getClientQuestions,
} from "../../src/platform/storage/repo/clientQuestions.js";
import { collectTodos, drainProject, renderTask } from "../../src/platform/runtime/dispatcher.js";
import type { DrainTurnReport } from "../../src/platform/runtime/dispatcher.js";

/**
 * 027 起正文住文件:测试里仍从「想写的正文」造出**落点三列** ——
 * sha256 与字节数都是真的(`node:crypto` 现算),不是占位串;正文本身不再进库。
 * 夹具仍然说得出「这件工件的正文是这一句」,只是表达成 (落点, 哈希, 字节数)。
 */
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
  ensureProjectOrg(db, "p1", T0);
  // ⚠️ 必须有**至少一条**工作项,且必须**已整合已交付**:项目零工作项时
  // `decompose_project` 成立,根工作项 done+已审而无交付物时 `integrate` /
  // `handover` 成立 —— 那些都不是本文件要测的东西,却会让断言变成在测两件事。
  // 这里一次把它们全部封死,让 `visited` 里只剩本文件关心的那一条。
  insertWork(db, {
    id: "wk_seed", projectId: "p1", parentWorkId: null, title: "已完成的子项",
    goal: "占位,让 decompose / integrate / review 都不成立",
    status: "done", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
  });
  markWorkReviewed(db, "wk_seed", T0);
  insertArtifact(db, {
    id: "art_delivered", projectId: "p1", conversationId: null, kind: "deliverable",
    status: "accepted", authorAgentId: "pm", title: "已交付的交付物", ...bodyAt("artifacts/art_delivered.md", "正文"),
    metadataJson: null, createdAt: T0 + 10, updatedAt: T0 + 10, workId: "wk_seed",
  });
  // 交付会话那条边 = `handover` 的终止判据(017)。不建它,handover 会一直成立。
  openDeliverableSession(db, {
    id: "s_deliv", projectId: "p1", deliverableArtifactId: "art_delivered", createdAt: T0 + 11,
  });
});
afterEach(() => db.close());

const okTurn: DrainTurnReport = { aborted: false, timedOut: false, text: "", toolCalls: [] };
const failedTurn: DrainTurnReport = { aborted: false, timedOut: false, text: "", toolCalls: [], failed: true };

/**
 * 走**生产写口**造一次「业务经理问了甲方」(tools/client.ts 的同一对调用)。
 *
 * ⚠️ 刻意不直接 `insertArtifact` 了事:那会跳过 `recordClientQuestion`,
 * 而那正是这次事故的形态(工件落了、台账没落)。测试自己走一遍生产路径,
 * 才不会在「夹具绕过了接线」的情况下绿。
 */
function askClient(question: string): string {
  const id = `q_${++seq}`;
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null, kind: "client_question",
    status: "open", authorAgentId: "bm", title: question, ...bodyAt(`artifacts/${id}.md`, question),
    metadataJson: null, createdAt: T0 + seq, updatedAt: T0 + seq, workId: null,
  });
  recordClientQuestion(db, {
    questionArtifactId: id, projectId: "p1", askedBy: "bm", askedAt: T0 + seq,
  });
  return id;
}

/** 甲方答复(同样走生产写口:`decision` 工件 + 台账回填)。 */
function answerClient(questionId: string, answer: string): string {
  const decId = `art_${++seq}`;
  insertArtifact(db, {
    id: decId, projectId: "p1", conversationId: null, kind: "decision",
    status: "accepted", authorAgentId: "bm", title: `甲方答复:${questionId}`,
    ...bodyAt(`artifacts/${decId}.md`, answer), metadataJson: JSON.stringify({ answersQuestionId: questionId, source: "client" }),
    createdAt: T0 + 100 + seq, updatedAt: T0 + 100 + seq, workId: null,
  });
  db.prepare(`UPDATE artifacts SET status = 'accepted' WHERE id = ?`).run(questionId);
  markClientQuestionAnswered(db, questionId, decId, T0 + 100 + seq);
  return decId;
}

const board = () => collectTodos({ db, projectId: "p1", now: T0, reportBatchSize: 1 });
const kinds = (): string[] => board().runnable.map((t) => t.kind);

describe("① 负样本:球在甲方那边时,一条待办都不许有", () => {
  it("刚提问、还没答复 ⇒ 零待办(不是 `resume_client`,是**什么都没有**)", () => {
    askClient("W1 数据源组合,您想怎么走?");
    expect(kinds()).not.toContain("resume_client");
    expect(kinds(), "球在甲方那边,叫醒谁都是空转").toEqual([]);
  });

  it("**这是最容易写坏的一条**:加了「有 open 提问就提醒」就会退化成每 10 秒烧一次", () => {
    askClient("问题 A");
    askClient("问题 B");
    // 两次查询之间时间在走(兜底定时器每 10 秒一次),而答案必须**一模一样**。
    expect(kinds()).toEqual([]);
    expect(kinds()).toEqual([]);
    expect(listUnconsumedClientAnswers(db, "p1")).toEqual([]);
  });
});

describe("② 正样本:答复一落库,下一次排空就有人被叫醒", () => {
  it("答复后出现 `resume_client`,refs 指的就是那几条提问", () => {
    const q1 = askClient("W1 您倾向哪种?");
    answerClient(q1, "完全免费版");
    const todos = board().runnable;
    const resume = todos.filter((t) => t.kind === "resume_client");
    expect(resume).toHaveLength(1);
    expect(resume[0]!.agentId).toBe("bm");
    expect(resume[0]!.refs).toEqual([q1]);
    expect(resume[0]!.label).toContain("1");
  });

  it("**排第一**:甲方刚点完答复,不该隔一整轮汇报才得到回应", () => {
    const q1 = askClient("W1 您倾向哪种?");
    answerClient(q1, "完全免费版");
    // 造一条同样成立的 `report_downstream`(下游事件未消费)—— 它的历史优先级
    // 是最后一位(11)。两条同时成立时,`resume_client` 必须先跑。
    db.prepare(
      `INSERT INTO dispatch_events (project_id, kind, subject_id, summary, created_at)
       VALUES ('p1', 'work_done', 'wk_x', '一条下游结果', ?)`,
    ).run(T0);
    const todos = board().runnable;
    expect(todos.map((t) => t.kind)).toEqual(["resume_client", "report_downstream"]);
  });

  it("多条未处置的答复合成**一条**待办(集合谓词,不是每条一个回合)", () => {
    const q1 = askClient("A");
    answerClient(q1, "答 A");
    const q2 = askClient("B");
    answerClient(q2, "答 B");
    const resume = board().runnable
      .filter((t) => t.kind === "resume_client");
    expect(resume).toHaveLength(1);
    expect(resume[0]!.refs).toEqual([q1, q2]);
  });

  it("渲染出来的现场带**答复工件的 id**,不靠标题猜", () => {
    const q1 = askClient("W1 您倾向哪种?");
    const decId = answerClient(q1, "完全免费版");
    const todo = board().runnable
      .find((t) => t.kind === "resume_client")!;
    const text = renderTask(db, todo);
    expect(text).toContain(q1);
    expect(text).toContain(decId);
    // 它是 nudge 不是命令:不该替模型决定「现在去问下一项」——那是它该自己判断的
    expect(text).toContain("这个答复**改变了什么**");
    expect(text).not.toContain("下一步是问 W2");
  });
});

describe("③ 终止判据:处置完就不再有(靠 `consumed_at`,不靠预算)", () => {
  it("回合成功 ⇒ 消费掉 ⇒ 第二次排空没有 `resume_client`", async () => {
    const q1 = askClient("W1 您倾向哪种?");
    answerClient(q1, "完全免费版");
    const deps = {
      db, projectId: "p1" as const, now: () => T0, log: () => {}, reportBatchSize: 1,
      runAgentTurn: async (): Promise<DrainTurnReport> => okTurn,
      runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
    };
    const first = await drainProject(deps);
    // ⚠️ 这里**只按被测的 kind 过滤**,不再断言整张 `visited`:
    // 2026-10-06 之后这个夹具**同时**满足 `close_finished_project`(它就是一个
    // 「全做完 + 已交付」的项目),而那条待办的次数取决于尝试预算 —— 把它写进
    // 逐字比对里,本文件每换一个 `maxAttemptsPerTodo` 就要改一次断言,而它测的
    // 根本不是收口。「收口也成立」由下面那条独立用例钉住。
    expect(first.visited.filter((v) => v.kind === "resume_client").map((v) => v.agentId))
      .toEqual(["bm"]);
    const second = await drainProject(deps);
    expect(second.visited.some((v) => v.kind === "resume_client"), "消费了就不该再叫").toBe(false);
    expect(getClientQuestions(db, [q1]).get(q1)?.consumedAt).toBe(T0);
  });

  it("消费判据是「回合成功」,**与模型做了什么无关**(所以不会变成「模型忘了就永远在」)", async () => {
    const q1 = askClient("W1 您倾向哪种?");
    answerClient(q1, "完全免费版");
    const r = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, reportBatchSize: 1,
      maxAttemptsPerTodo: 2,
      // 假业务经理:回合成功但**什么都不做** —— 平台仍然消费。
      //
      // ⚠️ 这是刻意与「模型有没有真的处置了」解耦的:处置的内容在会话消息与
      // `decision` 工件里(7-N:事后能从产物里看出当时发生了什么),而**要不要
      // 再叫一次**只由「这一回合成功了吗」决定 —— 与另外三支(审查 / 汇报 /
      // 交付会话)完全同形。若改成「模型没写工件就不消费」,一次模型忘了落库
      // 就会变成「同一条答复被反复叫醒」,那比多消费一次坏得多。
      runAgentTurn: async (): Promise<DrainTurnReport> => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(r.visited.filter((v) => v.kind === "resume_client")).toHaveLength(1);
    expect(r.newlyExhausted.map((t) => t.kind)).not.toContain("resume_client");
  });
});

describe("④ at-least-once:回合失败/被中断**不消费**", () => {
  it("失败的回合不消费 ⇒ 同一轮排空里反复重来,直到预算用尽(而不是静默丢掉答复)", async () => {
    const q1 = askClient("W1 您倾向哪种?");
    answerClient(q1, "完全免费版");
    const failed = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, reportBatchSize: 1,
      maxAttemptsPerTodo: 3,
      runAgentTurn: async (): Promise<DrainTurnReport> => failedTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    // ⚠️ **3 次而不是 1 次**,而且这是**正确**行为:不消费 ⇒ 下一轮查库时待办
    // 仍然成立 ⇒ 又会被派出去。at-least-once 的代价就是「宁可多看几次」。
    // 写成 1 次反而会把「失败不消费」这条纪律悄悄改成「失败即放弃」。
    // 只看被测的那一类(理由同上面那条:整张表会把别的规则的预算次数也绑进来)
    expect(failed.visited.filter((v) => v.kind === "resume_client").map((v) => v.kind))
      .toEqual(["resume_client", "resume_client", "resume_client"]);
    expect(getClientQuestions(db, [q1]).get(q1)?.consumedAt, "失败不消费").toBeNull();
    expect(failed.newlyExhausted.map((t) => t.kind)).toContain("resume_client");
    expect(failed.stopDetail).toContain("尝试预算");
  });

  it("预算用尽后**下一次排空**仍然在(预算是限流不是判据 —— 判据是 consumed_at)", () => {
    const q1 = askClient("W1 您倾向哪种?");
    answerClient(q1, "完全免费版");
    // 先把预算烧掉
    for (let i = 0; i < 3; i++) {
      drainProject({
        db, projectId: "p1", now: () => T0, log: () => {}, reportBatchSize: 1,
        maxAttemptsPerTodo: 3,
        runAgentTurn: async (): Promise<DrainTurnReport> => failedTurn,
        runWork: async () => { throw new Error("不该被调用"); },
      });
    }
    // 答复**还在**库里等人处理 —— 它没有被任何机制「放弃」
    expect(listUnconsumedClientAnswers(db, "p1").map((r) => r.questionArtifactId)).toEqual([q1]);
  });

  it("成功的那一次消费掉它,答复从此不再出现", async () => {
    const q1 = askClient("W1 您倾向哪种?");
    answerClient(q1, "完全免费版");
    const ok = await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, reportBatchSize: 1,
      maxAttemptsPerTodo: 9,
      runAgentTurn: async (): Promise<DrainTurnReport> => okTurn,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(ok.visited.filter((v) => v.kind === "resume_client").map((v) => v.kind))
      .toEqual(["resume_client"]);
    expect(getClientQuestions(db, [q1]).get(q1)?.consumedAt).toBe(T0);
  });
});
