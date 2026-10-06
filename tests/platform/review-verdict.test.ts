/**
 * 021 · `review_verdict`:质检的结论必须落成一行,而且平台照它走
 *
 * ── 它堵的是什么 ────────────────────────────────────────────────
 *
 * 真机事故(2026-10-06 08:57,项目「美股自动化交易平台方案设计」):
 *
 *   质检审根工作项 W0「整合与最终交付」,**判不通过** —— 6 条验收判据 0 条达成、
 *   1 条部分、5 条未达成,严重程度「中(不阻塞交付但应当补做)」,并给出可执行的
 *   修复路径。审查意见落成一条 3352 字的 `review_finding` 工件。
 *
 *   而库里的工作项是 `status='done'` + `review_state='done'`。
 *
 * 根因:`markWorkReviewed` 的判据是**「质检那个回合成功结束了」**,不是「判通过」。
 * 于是「通过」与「不通过」在库里**长得一模一样**,而那段写着不通过的散文
 * **没有任何机器读者** —— 不会被再审一次(`listWorksPendingReview` 不再返回它),
 * 不会变成新工作项,不会进 outbox。质检的否定结论是**死信**。
 *
 * 8 条 `review_finding` 全部 `status='open'`(连 7 条「审查通过」的也是)——
 * `status` 根本没在承载 verdict,这是判据缺失的旁证。
 *
 * 与 020 是**同一个病**:平台能写出来,但没有读者。
 *
 * ── 本文件钉的四件事 ──────────────────────────────────────────
 *
 *   ① `fail` ⇒ 走 `works.status` **唯一写口**重开 → `review_state` 回 `none`
 *      → `execute_work` 规则下一次查库就捡起来跑第二轮(依赖树一个字不动)。
 *   ② `pass` ⇒ **不改**工作项(标已审是消费块的活,判据是「回合成功」,
 *      与另外三支同纪律)—— 工具只负责「判据存在」。
 *   ③ **缺 verdict ⇒ 不消费** ⇒ 重审(判据翻转的 fail-closed 方向)。
 *   ④ 参数与外键的错误**响亮**:不合法枚举必须回灌允许集合(8-F 教训),
 *      跨项目必须拒。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { ROLE_SPECS, factoryToolset } from "../../src/platform/identity/role.js";
import {
  insertWork, getWork, markWorkReviewed, listWorksPendingReview, updateWorkStatus,
} from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { latestReviewVerdict, listReviewVerdicts } from "../../src/platform/storage/repo/reviewVerdicts.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Project } from "../../shared/types/platform.js";

let db: Database.Database;
let project: Project;
let seq = 0;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, {
    id: "p1", name: "美股平台方案", client: "个人用户", goal: "一份完整方案文档",
    status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
  project = loadProjectForAuthz(db, "p1")!;
  // 待审的产出:done + review_state=pending(质检那条待办的判据)
  insertWork(db, {
    id: "W0", projectId: "p1", parentWorkId: null, title: "整合与最终交付",
    goal: "收敛为一份完整方案文档", status: "done", assigneeAgentId: "wk",
    createdAt: T0, updatedAt: T0,
  });
});
afterEach(() => db.close());

function qaCtx(over: Partial<ToolRunContext> = {}): ToolRunContext {
  const qa = db.prepare(`SELECT * FROM agents WHERE role = 'quality_reviewer'`).get() as {
    id: string;
  };
  return {
    db,
    agent: { id: qa.id, role: "quality_reviewer", specialization: null, displayName: "质检" },
    project,
    now: () => T0 + 100,
    newId: (p) => `${p}_${++seq}`,
    ...over,
  };
}
function call(args: Record<string, unknown>, over: Partial<ToolRunContext> = {}): ToolResult {
  const r = dispatch("review_verdict", args, qaCtx(over));
  if (r instanceof Promise) throw new Error("review_verdict 应当是同步的");
  return r;
}
function okText(r: ToolResult): string {
  if (!r.ok) throw new Error(`期望成功,失败[${r.code}] ${r.message}`);
  return r.text;
}
function errOf(r: ToolResult): Extract<ToolResult, { ok: false }> {
  if (r.ok) throw new Error(`期望失败,成功:${r.text}`);
  return r;
}

describe("① fail:平台退回重做(走 status 唯一写口)", () => {
  it("不通过 ⇒ `done` 退回 `in_progress` 且 `review_state` 归 `none`", () => {
    okText(call({ workId: "W0", verdict: "fail", severity: "medium" }));
    const w = getWork(db, "W0")!;
    // ⚠️ 是 `in_progress` **不是** `open`:`WORK_TRANSITIONS`【裁决 ①】只给了
    // `done → in_progress` 这一条出边(「审查后退回重做」)。`done → open` 不存在。
    expect(w.status).toBe("in_progress");
    expect(w.reviewState, "迁出 done 按迁移表清成 none —— 它要重新跑,不是重新审").toBe("none");
  });

  it("**退回之后 `execute_work` 规则下一次查库就能捡起它**(不是只改了个字段)", () => {
    okText(call({ workId: "W0", verdict: "fail", severity: "high" }));
    // `myOpenWorks` 认 `open|in_progress` 且前置满足(W0 无前置)⇒ worker 会被叫醒。
    // 这里断言库里的形状,规则侧的完整通路由 dispatcher 的测试覆盖。
    expect(getWork(db, "W0")!.status).toBe("in_progress");
    expect(listWorksPendingReview(db, "p1"), "退回了就不再是「等审」").toEqual([]);
  });

  it("不通过也要能指着那份审查意见(现场可追)", () => {
    insertArtifact(db, {
      id: "rf1", projectId: "p1", conversationId: null, kind: "review_finding",
      status: "open", authorAgentId: "qa", title: "W0 审查不通过", body: "6 条判据 0 条达成",
      metadataJson: null, createdAt: T0 + 50, updatedAt: T0 + 50, workId: "W0",
    });
    okText(call({ workId: "W0", verdict: "fail", severity: "medium", findingArtifactId: "rf1" }));
    expect(latestReviewVerdict(db, "W0")?.findingArtifactId).toBe("rf1");
  });

  it("**改判必须留痕**:先 fail 后 pass,两行都在,读面取最新那条", () => {
    okText(call({ workId: "W0", verdict: "fail", severity: "medium" }));
    // 质检改判(比如甲方拍板后撤回了异议)。worker 补做一轮后再次 done,
    // 这次**走唯一写口**迁回 done —— 不是直接 UPDATE(那会绕过 §2.7)。
    const back = updateWorkStatus(db, "W0", "done", T0 + 800);
    if (!back.ok) throw new Error(`夹具:补做一轮失败 ${back.message}`);
    okText(call({ workId: "W0", verdict: "pass", severity: "low" }, { now: () => T0 + 900 }));
    const all = listReviewVerdicts(db, "W0");
    expect(all.map((v) => v.verdict)).toEqual(["fail", "pass"]);
    expect(latestReviewVerdict(db, "W0")?.verdict, "读面取最新一条").toBe("pass");
  });
});

describe("② pass:工具不改工作项(标已审是消费块的活)", () => {
  it("通过 ⇒ 写一行结论,但 `status` / `review_state` 一个字节都不动", () => {
    const before = getWork(db, "W0")!;
    okText(call({ workId: "W0", verdict: "pass", severity: "low" }));
    const after = getWork(db, "W0")!;
    expect(after.status).toBe(before.status);
    expect(after.reviewState).toBe(before.reviewState);
    expect(latestReviewVerdict(db, "W0")?.verdict).toBe("pass");
  });
});

describe("③ 缺 verdict ⇒ 不消费 ⇒ 重审(判据翻转的 fail-closed 方向)", () => {
  it("**没有 pass 结论就不许标已审** —— 这正是事故的堵点", async () => {
    // 手工模拟「质检回合结束了,但它没调 review_verdict」
    const { drainProject } = await import("../../src/platform/runtime/dispatcher.js");
    const before = getWork(db, "W0")!.reviewState;
    expect(before).toBe("pending");
    await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxRounds: 1,
      // 假质检:回合**成功**结束,但什么都没写
      runAgentTurn: async (): Promise<{
        aborted: boolean; timedOut: boolean; text: string; toolCalls: readonly [];
      }> => ({ aborted: false, timedOut: false, text: "", toolCalls: [] }),
      runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
    });
    expect(
      getWork(db, "W0")!.reviewState,
      "回合成功**不等于**审过了 —— 少一次 markWorkReviewed 就是这次修复的全部意义",
    ).toBe("pending");
  });

  it("给了 pass 结论 ⇒ 同样那一轮就会标已审(证明上一条不是恒真)", async () => {
    const { drainProject } = await import("../../src/platform/runtime/dispatcher.js");
    const { insertReviewVerdict } = await import("../../src/platform/storage/repo/reviewVerdicts.js");
    await drainProject({
      db, projectId: "p1", now: () => T0, log: () => {}, maxRounds: 1,
      runAgentTurn: async (): Promise<{
        aborted: boolean; timedOut: boolean; text: string; toolCalls: readonly [];
      }> => {
        insertReviewVerdict(db, {
          workId: "W0", projectId: "p1", verdict: "pass", severity: "low",
          findingArtifactId: null, note: "夹具", reviewedBy: "qa", createdAt: T0,
        });
        return { aborted: false, timedOut: false, text: "", toolCalls: [] };
      },
      runWork: async () => { throw new Error("这一串里没有工作项要执行"); },
    });
    expect(getWork(db, "W0")!.reviewState).toBe("done");
  });
});

describe("④ 错误必须响亮(8-F:回灌允许集合)", () => {
  it("verdict 不在闭集 ⇒ 拒绝并回灌 `pass` / `fail`", () => {
    const r = errOf(call({ workId: "W0", verdict: "PASS", severity: "low" }));
    expect(r.code).toBe("invalid_args");
    expect(r.alternatives).toEqual(["pass", "fail"]);
    expect(getWork(db, "W0")!.status, "一个字节都不许写").toBe("done");
  });

  it("severity 不在闭集 ⇒ 拒绝并回灌三档", () => {
    const r = errOf(call({ workId: "W0", verdict: "fail", severity: "urgent" }));
    expect(r.alternatives).toEqual(["low", "medium", "high"]);
    expect(latestReviewVerdict(db, "W0"), "没写进去").toBeNull();
  });

  it("findingArtifactId 指向的不是 review_finding ⇒ 拒(否则「现场」是假的)", () => {
    insertArtifact(db, {
      id: "n1", projectId: "p1", conversationId: null, kind: "note",
      status: "open", authorAgentId: "qa", title: "随便一条", body: "x",
      metadataJson: null, createdAt: T0, updatedAt: T0, workId: null,
    });
    const r = errOf(call({ workId: "W0", verdict: "fail", severity: "low", findingArtifactId: "n1" }));
    expect(r.code).toBe("invalid_args");
    expect(getWork(db, "W0")!.status).toBe("done");
  });

  it("工作项不存在 ⇒ not_found;**别的项目的工作项 ⇒ denied**", () => {
    expect(errOf(call({ workId: "nope", verdict: "pass", severity: "low" })).code).toBe("not_found");
    insertProject(db, {
      id: "p2", name: "别的", client: "x", goal: "y", status: "active", createdAt: T0,
    });
    ensureProjectOrg(db, "p2", T0);
    insertWork(db, {
      id: "W_other", projectId: "p2", parentWorkId: null, title: "t", goal: "g",
      status: "done", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    expect(
      errOf(call({ workId: "W_other", verdict: "fail", severity: "low" })).code,
      "跨项目必须拒 —— 与授权层用同一个码,读日志的人不必区分两种拒绝",
    ).toBe("denied");
  });
});

describe("⑤ 边界:质检能「说」不合格,不能「自己改」", () => {
  it("`review_verdict` **不持 `work.update`** —— 重开是平台做的,不是质检", () => {
    const tools = factoryToolset("quality_reviewer");
    expect(tools, "质检不许直接改工作项状态").not.toContain("work_update");
    expect(tools).toContain("review_verdict");
    expect(ROLE_SPECS.quality_reviewer.writeKinds).toEqual(["review_finding"]);
  });
});

