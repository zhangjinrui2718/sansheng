/**
 * 待答队列:「已收口项目的提问」不再是待答(2026-10-07 真机事故)
 *
 * ── 事故是什么 ──────────────────────────────────────────────────
 *
 * 真机:项目「美股自动化交易平台方案设计·单报告合并版」于 2026-10-07 **00:27**
 * 收口(`done`)。业务经理在**收口之后 8.5 小时**(09:03 / 09:13)又提了 3 个问题。
 * 三条一直挂在全局「待答」面板里 —— 而**没有任何人会被叫醒去处理它们**:
 *
 *   ① 提得到:`authorize.ts` 的 `PROJECT_SCOPED_PREFIXES` **不含 `client.`**,
 *      所以收口后 `ask_client` 仍然可用(有意:「豁免的是说话,不是改」)。
 *   ② 没人处理:`host/serve.ts` 的 `drainAll` 排 `listProjects(db, "active")`,
 *      **终态项目永远不进排空器**。
 *   ③ ⇒ 用户点「回答」只会多落一条 `decision`,**没有任何人会被叫醒**,
 *      而这一条仍然挂着。
 *
 * 「待答」承诺的是「你答了会有人处理」。兑现不了的队列不是队列,是**看起来很正常**
 * 的噪音 —— 它与「有人欠你三个回答」在屏幕上长得一模一样。
 *
 * ── 这个测试盯三件事 ────────────────────────────────────────────
 *
 *   ① **跨项目本身是有意的**(不能顺手改成只显示当前项目 —— 那会让别处的提问
 *      重新变成没人知道,那正是这个面板当初存在的理由);
 *   ② **收口项目的提问必须被排除**,且**条数必须一起返回**(不许静默丢弃);
 *   ③ **事实一条都不删**:工件与 `client_questions` 行原样在库里,项目页那个
 *      项目内的读面照常显示。
 *
 * 判据的形状是「**它对已知样本给出了正确答案**」,不是「跑完了没报错」——
 * 所以每一组都带**正样本 + 负样本**:一个必须留在队列里,一个必须被排除,
 * 而一个**什么都排除**的检查会让负样本绿、正样本红,方向相反的错法同理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, closeProject, type ProjectStatus } from "../../src/platform/storage/repo/projects.js";
import {
  insertArtifact,
  listArtifacts,
} from "../../src/platform/storage/repo/artifacts.js";
import { listAllClientQuestions } from "../../src/platform/transport/views.js";

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
let bm: string;
const T0 = 1_700_000_000_000;

function mkProject(name: string, status: ProjectStatus = "active"): string {
  const id = `pj${++seq}`;
  insertProject(db, {
    id, name, client: "甲方", goal: "g", status: "active", createdAt: T0 + seq,
  });
  if (status !== "active") closeProject(db, id, status, T0 + seq + 1);
  return id;
}

/** 一条 `client_question` 工件 —— 待答队列的**唯一**数据来源。 */
function ask(pid: string, q: string): string {
  const id = `art${++seq}`;
  insertArtifact(db, {
    id, projectId: pid, conversationId: null, kind: "client_question", status: "open",
    authorAgentId: bm, title: q, ...bodyAt(`artifacts/${id}.md`, q), metadataJson: null,
    createdAt: T0 + seq * 10, updatedAt: T0 + seq * 10,
  });
  return id;
}

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  bm = "ag_bm";
  insertAgent(db, { id: bm, role: "business_manager", specialization: null, displayName: "业务经理", createdAt: T0 });
});
afterEach(() => db.close());

describe("待答队列 · 收口项目的提问不算待答", () => {
  it("真机形状:active 与 done 两个项目各 1 条 → 只留 active 那条,并报出被排除的条数", () => {
    const live = mkProject("还在进行");
    const closed = mkProject("已收口", "done");
    const qLive = ask(live, "还在进行的那个问题");
    const qClosed = ask(closed, "收口之后才提的那个问题");

    const r = listAllClientQuestions(db);
    expect(r.questions.map((q) => q.id)).toEqual([qLive]);
    expect(r.fromClosedProjects).toBe(1);
    expect(r.questions.some((q) => q.id === qClosed)).toBe(false);
  });

  it("**跨项目本身保留**:两个都在进行的项目,两条都在队列里", () => {
    // 这条钉的是**接口**:后端仍然给全局列表 —— 2026-10-12 起「待答」面板改成按项目
    // 显示,但那是**显示口径**,不是数据面的隐藏(别处要用、要审计的都还拿得到)。
    // ⚠️ 筛选落在 `web/src/lib/questionScope.ts`(回归 `tests/web/question-scope.test.ts`),
    // 别把它顺手挪到后端 —— 那会让「本项目有几件待答」这种问题**无接口可问**。
    const a = mkProject("项目甲");
    const b = mkProject("项目乙");
    const qa = ask(a, "甲的问题");
    const qb = ask(b, "乙的问题");
    const r = listAllClientQuestions(db);
    expect(r.questions.map((q) => q.id).sort()).toEqual([qa, qb].sort());
    expect(r.fromClosedProjects).toBe(0);
    // 队列是 FIFO:早问的先答
    expect(r.questions[0].createdAt).toBeLessThanOrEqual(r.questions[1].createdAt);
  });

  it("**abandoned 也算收口**(与 done 同形,不是一个特例)", () => {
    const gone = mkProject("放弃了", "abandoned");
    ask(gone, "放弃之后提的问题");
    const r = listAllClientQuestions(db);
    expect(r.questions).toHaveLength(0);
    expect(r.fromClosedProjects).toBe(1);
  });

  it("**paused 仍然算待答** —— 暂停不是收口,排空器还会叫它", () => {
    const paused = mkProject("暂停中", "paused");
    ask(paused, "暂停期间的问题");
    const r = listAllClientQuestions(db);
    expect(r.questions).toHaveLength(1);
    expect(r.fromClosedProjects).toBe(0);
  });

  it("**事实一条都不删**:工件与工件状态原样在库里(项目页那个读面还要用)", () => {
    const closed = mkProject("已收口", "done");
    const q = ask(closed, "还在库里");
    expect(listAllClientQuestions(db).questions).toHaveLength(0);
    // 排除的只是**待答队列的资格**,不是数据本身
    expect(listArtifacts(db, closed, { kind: "client_question", status: "open" })).toHaveLength(1);
    expect(listArtifacts(db, closed)[0].id).toBe(q);
  });

  it("已答复 / 被否决的不在队列里(这条判据本来就存在,别被这次改动弄坏)", () => {
    const p = mkProject("进行中");
    const answered = ask(p, "已答的");
    db.prepare(`UPDATE artifacts SET status='accepted' WHERE id=?`).run(answered);
    ask(p, "还没答的");
    const r = listAllClientQuestions(db);
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0].question).toBe("还没答的");
    expect(r.fromClosedProjects).toBe(0);
  });

  it("空库:两个计数都是 0(而不是抛错或返回 null)", () => {
    const r = listAllClientQuestions(db);
    expect(r.questions).toEqual([]);
    expect(r.fromClosedProjects).toBe(0);
  });

  // ── `closedProjectQuestions`(2026-10-12 加)────────────────────────
  //
  // 为什么加:面板改成按项目显示之后,光有 `fromClosedProjects` 那个**全局**计数
  // 答不对问题 —— 它会把别的项目的收口条数报在当前项目名下。所以那批排除掉的提问
  // 也要**带项目坐标**给出来。回归 `tests/web/question-scope.test.ts` 管显示侧。

  it("收口的那批**带项目坐标**给出来(所以前端能数出「本项目」那一份)", () => {
    const live = mkProject("还在进行");
    const closed = mkProject("已收口", "done");
    const qLive = ask(live, "还在进行的那个问题");
    const qClosed = ask(closed, "收口之后才提的那个问题");

    const r = listAllClientQuestions(db);
    expect(r.closedProjectQuestions.map((q) => q.id)).toEqual([qClosed]);
    expect(r.closedProjectQuestions[0].projectId).toBe(closed);
    expect(r.closedProjectQuestions[0].projectName).toBe("已收口");
    // 两份数据**互补且不重叠**:一条能答、一条只数
    expect(r.questions.map((q) => q.id)).toEqual([qLive]);
    expect(r.questions.some((q) => q.id === qClosed)).toBe(false);
    expect(r.closedProjectQuestions.some((q) => q.id === qLive)).toBe(false);
  });

  it("`fromClosedProjects` 与那份列表**同源**(别让两个数字各说各话)", () => {
    const live = mkProject("还在进行");
    const d1 = mkProject("已收口一", "done");
    const d2 = mkProject("已收口二", "abandoned");
    ask(live, "还在等的");
    ask(d1, "收口后问的 1");
    ask(d2, "收口后问的 2");
    const r = listAllClientQuestions(db);
    expect(r.fromClosedProjects).toBe(2);
    expect(r.closedProjectQuestions).toHaveLength(r.fromClosedProjects);
  });

  it("收口的那批**按时间排**(与队列同一套排序)", () => {
    const d = mkProject("已收口", "done");
    ask(d, "早的");
    ask(d, "晚的");
    const r = listAllClientQuestions(db);
    expect(r.closedProjectQuestions).toHaveLength(2);
    expect(r.closedProjectQuestions[0].createdAt).toBeLessThanOrEqual(
      r.closedProjectQuestions[1].createdAt,
    );
  });

  it("**判据自检**:若有人把收口那批也塞回 `questions`(失去区分),这一格会红", () => {
    // 「只能数、不能答」这条靠的是**两份列表不重叠**。所以这里把两份合起来验一遍:
    // 1 条能答 + 1 条只能数 = 2,而不是 2 条都能答。
    const closed = mkProject("已收口", "done");
    ask(closed, "收口后问的");
    const r = listAllClientQuestions(db);
    expect(r.questions.length + r.closedProjectQuestions.length).toBe(1);
    expect(r.questions).toHaveLength(0);
    expect(r.closedProjectQuestions).toHaveLength(1);
  });

  it("排空器确实只跑 active —— **这条是本测试存在的理由**,别让它悄悄变成别的", () => {
    // 判据在**源码**里而不是 import 一个函数(那个函数要整个 host 才能跑)。
    // 负样本自检:模式写错时这个 grep 会返回 0 命中,而那看起来像「排空器不过滤」。
    const src = readFileSync(
      join(import.meta.dirname, "../../src/platform/host/serve.ts"), "utf8",
    );
    expect(src).toMatch(/listProjects\(\s*db\s*,\s*"active"\s*\)/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";