/**
 * 2026-10-06 真机终局批次的验收:**项目永远收不了口** + **验收现场看不见「要达成什么」**
 *
 * ── 这一批为什么存在 ────────────────────────────────────────────────
 *
 * 同一个项目(「美股自动化交易平台方案设计」)跑完之后,库里的现场是:
 *
 *   · 11 条工作全部 `status='done'` + `review_state='done'`
 *   · 6 条 `review_verdict`,最后一条 `pass`(16:27 终审通过)
 *   · `dispatch_events` 无未消费行 · `dispatch_attempts` 无残留行
 *   · `client_questions` 15 条全部 `answered` 且 `consumed`
 *   · `openWorks=0` / `pendingQuestions=0` / `openBlockers=0` / `runningTurns=0`
 *
 * 而 `projects.status` 是 **`active`**。用户看到的字面就是「什么都没在干,但项目
 * 还在进行中」—— 而这两种状态在界面上的距离是**零像素**。
 *
 * 同一个项目里还有第二处:甲方在 W0 收尾时**明确答复**选 A(要「一份」)、**否掉**
 * 了「接受 7 份子文档」;而质检的审查原文是「严格按整改 work_brief 的『目录式引用
 * + 严禁复述/改写』硬约束执行,4 条判据全部满足」—— **甲方那句诉求没有任何一条
 * 机制携带到验收环节**。`grep -n goal dispatcher.ts` 在这一批之前零命中。
 *
 * ── 这些测试守的到底是什么 ──────────────────────────────────────────
 *
 * 不是「提示词里写了那句话」。是**三条结构性判据**:
 *
 *   1. 收口待办**由库里的状态推出**(八件事同时成立),而且它**一成立就被叫醒** ——
 *      `project_close` 工具一直有生产调用方却**零自动触发**(7-E 的复发)。
 *   2. 终止判据落在 `projects.status` 一列上 ⇒ 重启后自动补跑,且**不会重复叫**。
 *   3. 质检那个回合的提示词里**真的带着** `works.goal` 与 `projects.goal` ——
 *      「判据在提示词里、达成目标的定义不在」是这个洞的准确形状。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject, closeProject, getProjectRow } from "../../src/platform/storage/repo/projects.js";
import { openDeliverableSession } from "../../src/platform/storage/repo/sessions.js";
import { insertWork, markWorkReviewed } from "../../src/platform/storage/repo/works.js";
import { insertBlocker } from "../../src/platform/storage/repo/blockers.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertDeliveryVerdict } from "../../src/platform/storage/repo/deliveryVerdicts.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  collectTodos, renderTask, drainProject, RULES, NUDGE_CAPABILITIES,
} from "../../src/platform/runtime/dispatcher.js";
import type { DrainTurnReport } from "../../src/platform/runtime/dispatcher.js";
import type { TodoBoard } from "../../src/platform/runtime/dispatcher.js";

const T0 = 1_700_000_000_000;
const P = "p_close";
const BM = "bm";

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

beforeEach(() => {
  db = openPlatformMemoryDb();
  insertProject(db, {
    id: P, name: "美股平台方案", client: "个人用户",
    // ⚠️ 甲方立项时说的那句「要达成什么」——验收现场必须看得见它。
    goal: "出一份完整方案文档,不要七份分章的",
    status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, P, T0);
});

afterEach(() => db.close());

/**
 * 造一个「一切做完且已交付」的项目 —— 收口规则的**正样本**。
 *
 * 每一步都对应判据里的一格;下面的用例逐条把它**拆掉**,证明那一格真的参与判定
 * (而不是「判据恒为真,顺带也会在对的场景里成立」)。
 */
function seedFinishedProject(over: {
  workStatus?: "done" | "in_progress";
  reviewed?: boolean;
  deliverableStatus?: "accepted" | "open";
  delivered?: boolean;
  /**
   * **甲方收不收**(029)。`null` = 甲方还没表态 —— 那是「待收货」,
   * 与「作者写了 `accepted`(定稿)」是**两件不同的事**。
   *
   * 缺省 `"accept"`,因为其余每一格测的都是**别的机制**;把它缺省成 `null`
   * 会让这一格里所有用例一起变红,而那些红与该用例要证明的事无关。
   */
  clientVerdict?: "accept" | "reject" | null;
  pendingQuestion?: boolean;
  unconsumedAnswer?: boolean;
  openBlocker?: boolean;
} = {}): void {
  insertWork(db, {
    id: "wk_root", projectId: P, parentWorkId: null, title: "整合与最终交付",
    goal: "把七份子文档整合成一份交付给甲方",
    status: over.workStatus ?? "done", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
  });
  if (over.reviewed !== false) markWorkReviewed(db, "wk_root", T0);

  insertArtifact(db, {
    id: "art_d1", projectId: P, conversationId: null, kind: "deliverable",
    status: over.deliverableStatus ?? "accepted", authorAgentId: "pm",
    title: "美股自动化交易平台完整方案", ...bodyAt("artifacts/art_d1.md", "正文"),
    metadataJson: null, createdAt: T0 + 1, updatedAt: T0 + 1, workId: "wk_root",
  });

  if (over.delivered !== false) {
    openDeliverableSession(db, {
      id: "s_d1", projectId: P, deliverableArtifactId: "art_d1", createdAt: T0 + 2,
    });
  }

  // ── 甲方的验收裁决(029)──────────────────────────────────────
  //
  // ⚠️ **它只能在「已交付」时写**:`POST /api/artifacts/:id/verdict` 的四条拒收
  // 之一就是「还没交付给你」。夹具照这个形状造,否则会造出一个 HTTP 面根本
  // 写不出来的状态(而那种夹具会让「后端会拒」这条判据失效)。
  const verdict = over.clientVerdict === undefined ? "accept" : over.clientVerdict;
  if (verdict !== null && over.delivered !== false) {
    insertDeliveryVerdict(db, {
      projectId: P, artifactId: "art_d1", verdict,
      note: verdict === "reject" ? "夹具:甲方要改" : null, createdAt: T0 + 3,
    });
  }

  if (over.pendingQuestion === true) {
    insertArtifact(db, {
      id: "q_open", projectId: P, conversationId: null, kind: "client_question",
      status: "open", authorAgentId: BM, title: "还有一项要您拍板", ...bodyAt("artifacts/q_open.md", "正文"),
      metadataJson: null, createdAt: T0 + 3, updatedAt: T0 + 3, workId: null,
    });
  }
  if (over.unconsumedAnswer === true) {
    // `client_questions` 台账:`answered_at` 有值而 `consumed_at` 没有 —— 020 之后
    // 「答复到了、业务经理还没处置」在库里是一条**独立**的行。
    insertArtifact(db, {
      id: "q_ans", projectId: P, conversationId: null, kind: "client_question",
      status: "accepted", authorAgentId: BM, title: "您选了 A", ...bodyAt("artifacts/q_ans.md", "正文"),
      metadataJson: null, createdAt: T0 + 4, updatedAt: T0 + 4, workId: null,
    });
    db.prepare(
      `INSERT INTO client_questions
         (question_artifact_id, project_id, asked_by, asked_at, answer_artifact_id, answered_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("q_ans", P, BM, T0 + 4, "q_ans", T0 + 5);
  }
  if (over.openBlocker === true) {
    insertBlocker(db, {
      id: "bl1", projectId: P, title: "缺一份券商费率表",
      detail: "只有甲方能提供", severity: "medium",
      status: "open", raisedByAgentId: "pm", createdAt: T0 + 6, updatedAt: T0 + 6,
    });
  }
}

const kindsOf = (board: TodoBoard): string[] => board.runnable.map((t) => t.kind);
const hasClose = (board: TodoBoard): boolean => kindsOf(board).includes("close_project");

// ══════════════════════════════════════════════════════════════════
// ① 收口规则:正样本 + 逐格拆掉
// ══════════════════════════════════════════════════════════════════

describe("① `close_finished_project`:八件事同时成立才叫醒业务经理", () => {
  it("正样本:全做完 + 审过 + 有已验收交付物 + 已交付 ⇒ 叫醒一次业务经理", () => {
    seedFinishedProject();
    const board = collectTodos({ db, projectId: P, now: T0 });
    expect(kindsOf(board), "一个做完了的项目必须有一条收口待办").toContain("close_project");
    const todo = board.runnable.find((t) => t.kind === "close_project")!;
    expect(todo.agentId).toBe(BM);
    expect(todo.role, "收口是业务判断,不是平台能从库里推出来的结论").toBe("business_manager");
    expect(todo.key, "key 用项目 id —— 进度就等于 status 变终态").toBe(`close_project:${P}`);
  });

  it("⚠️ 正样本自检:上面那条不是「判据恒为真」", () => {
    // 项目里**什么都没有**时它不成立 —— 否则「它总在成立」只是因为条件写空了。
    const board = collectTodos({ db, projectId: P, now: T0 });
    expect(hasClose(board), "零工作项、零交付物 ⇒ 不是「做完了」").toBe(false);
  });

  it("每一格都真的参与判定:拆掉任意一格,它就不成立", () => {
    // ⚠️ 这一条是本文件的核心验收:八个格子**逐个**拆一遍。
    // 只测正样本的话,一个「只要有任何交付物就成立」的规则也能全绿。
    const cases: Array<[string, Parameters<typeof seedFinishedProject>[0]]> = [
      ["还有没做完的工作项", { workStatus: "in_progress" }],
      ["做完了但还没审", { reviewed: false }],
      ["交付物还没验收(accepted 才是资格)", { deliverableStatus: "open" }],
      ["交付物还没交付给甲方", { delivered: false }],
      ["还有问题在等甲方", { pendingQuestion: true }],
      ["甲方的答复到了还没处置", { unconsumedAnswer: true }],
      ["还有没解决的阻塞", { openBlocker: true }],
      // ── 2026-10-08(029)新增的两格 ──────────────────────────────
      //
      // ⚠️ 这两格是这次改动的**全部意义**:在此之前,「甲方验收了」在库里
      // 就是 `status='accepted'`,而那是**申请人自己写的**(PM 提示词逐字教它
      // 这么写)。所以下面这两格以前**根本不存在** —— 判据读的是作者的自述。
      ["已交付但甲方还没验收(待收货)", { clientVerdict: null }],
      ["甲方拒收了这一版", { clientVerdict: "reject" }],
    ];
    for (const [why, over] of cases) {
      db.close();
      db = openPlatformMemoryDb();
      insertProject(db, {
        id: P, name: "美股平台方案", client: "个人用户",
        goal: "出一份完整方案文档", status: "active", createdAt: T0,
      });
      ensureProjectOrg(db, P, T0);
      seedFinishedProject(over);
      expect(hasClose(collectTodos({ db, projectId: P, now: T0 })), why).toBe(false);
    }
  });

  it("没有已验收交付物时**不**收口 —— 「工作项全 done 而甲方手上什么都没有」不算完成", () => {
    // 这是真机上最难看的那种终局:过程全绿、交付物为零。
    insertWork(db, {
      id: "wk_root", projectId: P, parentWorkId: null, title: "整合与最终交付",
      goal: "g", status: "done", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    markWorkReviewed(db, "wk_root", T0);
    expect(hasClose(collectTodos({ db, projectId: P, now: T0 })),
      "一份交付物都没有 ⇒ 甲方手上什么都没有,不能算完成").toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// ② 终止判据:落在一列上,不靠预算
// ══════════════════════════════════════════════════════════════════

describe("② 终止判据是 `projects.status`,不是尝试预算", () => {
  it("项目一进终态,规则立刻不成立(**不会**把已关闭的项目重新叫活)", () => {
    seedFinishedProject();
    expect(hasClose(collectTodos({ db, projectId: P, now: T0 }))).toBe(true);

    closeProject(db, P, "done", T0 + 10);
    expect(getProjectRow(db, P)?.status).toBe("done");
    expect(hasClose(collectTodos({ db, projectId: P, now: T0 + 10 })),
      "关掉之后还叫 = 用户会被问第二次同一个问题,而关掉不可逆").toBe(false);
  });

  it("业务经理真的关掉之后,下一轮排空不再叫它(端到端一次)", async () => {
    seedFinishedProject();
    const report: DrainTurnReport = { aborted: false, timedOut: false, text: "", toolCalls: [] };
    const first = await drainProject({
      db, projectId: P, now: () => T0, log: () => {},
      runAgentTurn: async () => report,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(first.visited.map((v) => v.kind)).toContain("close_project");

    // 模拟业务经理按提示词做了判断:调 `project_close`
    closeProject(db, P, "done", T0 + 10);
    const second = await drainProject({
      db, projectId: P, now: () => T0 + 20, log: () => {},
      runAgentTurn: async () => report,
      runWork: async () => { throw new Error("不该被调用"); },
    });
    expect(second.visited.map((v) => v.kind), "已收口 ⇒ 再也不叫").not.toContain("close_project");
  });
});

// ══════════════════════════════════════════════════════════════════
// ③ 收口那个回合的提示词:摆事实 + 说「你来判断」
// ══════════════════════════════════════════════════════════════════

describe("③ `renderTask(close_project)`:摆事实、不代替判断", () => {
  const textOf = (): string => {
    seedFinishedProject();
    const board = collectTodos({ db, projectId: P, now: T0 });
    return renderTask(db, board.runnable.find((t) => t.kind === "close_project")!);
  };

  it("把甲方立项时那句「要达成什么」摆出来 —— 它是收口与否的靶子", () => {
    const text = textOf();
    expect(text).toContain("出一份完整方案文档");
    expect(text, "靶子必须在场,否则判的是「过程收口」不是「这件事做完了」")
      .toContain("这个项目当初要达成什么");
  });

  it("列出最终交付物 —— 甲方手上就是这些", () => {
    const text = textOf();
    expect(text).toContain("art_d1");
    expect(text).toContain("美股自动化交易平台完整方案");
    expect(text).toContain("最终交付物");
  });

  it("**不给**「关掉吧」这种命令,并把不可逆写明白", () => {
    const text = textOf();
    expect(text, "收口是业务判断 —— 平台不下命令(§2.11.3)")
      .toContain("但平台不知道该不该收");
    expect(text).toContain("不可逆");
    expect(text, "必须给「还差东西」留一条出路,否则模型只会照办")
      .toContain("还差东西");
  });

  it("只读结构化的列:**不抄工件正文**(规则不做语义猜测,渲染现场同理)", () => {
    const text = textOf();
    expect(text).not.toContain("正文");
  });
});

// ══════════════════════════════════════════════════════════════════
// ④ 质检现场必须带「要达成什么」
// ══════════════════════════════════════════════════════════════════

describe("④ `renderTask(review_work)`:判据在提示词里,达成目标的定义也得在", () => {
  const reviewText = (): string => {
    seedFinishedProject({ reviewed: false });
    const board = collectTodos({ db, projectId: P, now: T0 });
    return renderTask(db, board.runnable.find((t) => t.kind === "review_work")!);
  };

  it("带着**这条工作项**的 goal —— 之前这里只渲染 id / 标题 / 负责人", () => {
    // 真机形状:`review_work` 的任务正文问「目标达成了吗?」,而目标**压根不在
    // 那个回合的提示词里** ⇒ 质检转头去读项目经理的整改 brief 当判据。
    const text = reviewText();
    expect(text).toContain("把七份子文档整合成一份交付给甲方");
  });

  it("也带着**项目**的 goal —— 只看工作项的 goal,「它在为总靶子服务吗」仍然不可判", () => {
    const text = reviewText();
    expect(text).toContain("出一份完整方案文档,不要七份分章的");
  });

  it("**判据优先级写死**:goal > 项目 goal > brief,且冲突时以 goal 为准并记录", () => {
    // 这一条才是治住真机那次的:brief 把「一份」定义成「一份目录」,质检对着
    // brief 判 pass。这一段必须明说 brief **不能定义「做成什么」**。
    const text = reviewText();
    expect(text).toContain("只定义「怎么做」");
    expect(text).toContain("以 1 / 2 为准");
    expect(text).toContain("不要拿 brief 覆盖 goal");
  });

  it("goal 为空时如实说「没有判据」,**不编一个**", () => {
    insertWork(db, {
      id: "wk_nogoal", projectId: P, parentWorkId: null, title: "没有写目标的那条",
      goal: "", status: "done", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    const board = collectTodos({ db, projectId: P, now: T0 });
    const todo = board.runnable.find((t) => t.kind === "review_work" && t.refs.includes("wk_nogoal"));
    expect(todo, "先自检:这条确实等着审(否则下面是在测一句空话)").toBeDefined();
    expect(renderTask(db, todo!)).toContain("这条工作项的 `goal` 是空的");
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑤ integrate:分章结论不算「整合完」
// ══════════════════════════════════════════════════════════════════

describe("⑤ `renderTask(integrate)`:根的 goal 决定要一份还是几份", () => {
  it("把根工作项的 goal 摆出来,并写明「分章结论 ≠ 总稿」", () => {
    // 真机现场:项目经理写了 7 份分章结论挂到根上,平台立刻认为整合完成、
    // 根工作项自动收口 —— 而甲方要的是「一份」。平台分不清这两者,因为**结构上
    // 没有这个字段**;所以把它写成判据交给模型。
    seedFinishedProject();
    const board = collectTodos({ db, projectId: P, now: T0 });
    const todo = board.runnable.find((t) => t.kind === "integrate");
    // 夹具里根已经有交付物 ⇒ 不成立;直接造一个没有的
    expect(todo, "根上已有交付物 ⇒ integrate 不成立(先自检)").toBeUndefined();

    insertWork(db, {
      id: "wk_fresh", projectId: P, parentWorkId: null, title: "整合与最终交付",
      goal: "交一份整合后的完整文档",
      status: "done", assigneeAgentId: "wk", createdAt: T0 + 20, updatedAt: T0 + 20,
    });
    // `integrate` 的资格是「收口**且审过**」—— 只 done 不审是 `review_work` 的活
    markWorkReviewed(db, "wk_fresh", T0 + 20);
    const b2 = collectTodos({ db, projectId: P, now: T0 + 20 });
    const integrate = b2.runnable.find((t) => t.kind === "integrate");
    expect(integrate, "新根还没有交付物 ⇒ integrate 成立").toBeDefined();
    const text = renderTask(db, integrate!);
    expect(text).toContain("交一份整合后的完整文档");
    expect(text).toContain("几份分章结论不算交付");
    expect(text, "反过来也要给 —— goal 说要分章节时就按分章交")
      .toContain("判据是这条 goal,不是这句提示词");
  });
});

// ══════════════════════════════════════════════════════════════════
// ⑥ 规则表本身的闭合性(这一批新加的那一条在表里)
// ══════════════════════════════════════════════════════════════════

describe("⑥ 新规则在表里,且判据全读结构化的列", () => {
  it("`close_finished_project` 认领 `close_project`,没有别的规则抢", () => {
    const owners = RULES.filter((r) => r.then.kind === "close_project");
    expect(owners.map((r) => r.id)).toEqual(["close_finished_project"]);
  });

  it("`project.close` 在 `NUDGE_CAPABILITIES` 里(否则它收口之后没人重查一次)", () => {
    // 「代码里写了逻辑」不等于「它有读者」——`project_close` 工具一直有生产调用方
    // 却零自动触发,就是这条纪律的复发。
    expect(NUDGE_CAPABILITIES).toContain("project.close");
  });
});