/**
 * 工作项级验收判据(037,2026-11-22)· 回归
 *
 * ── 它守着什么 ──────────────────────────────────────────────────
 *
 * 031 把**项目级**判据升级成了结构化数据,但「审什么」的真正单元是**工作项**:
 * 质检审每条产出,而 works 上只有 goal 散文。037 把判据搬到工作项级
 * (multica 的 issue 级 `acceptance_criteria` 同款):写入(work_create /
 * work_update)、读取(WorkView 原样透出)、消费(质检的 renderTask 逐条对照、
 * 拆解提示要求逐条给)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertProject, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  insertWork, getWork, updateWorkAcceptance,
} from "../../src/platform/storage/repo/works.js";
import { toWorkView } from "../../src/platform/transport/views.js";
import { collectTodos, renderTask } from "../../src/platform/runtime/dispatcher.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";

let db: Database.Database;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  insertProject(db, {
    id: "p1", name: "判据测试", client: "甲方", goal: "做出可验收的东西",
    status: "active", createdAt: T0,
  });
  ensureProjectOrg(db, "p1", T0);
});
afterEach(() => db.close());

function mkWork(over: { id?: string; status?: "open" | "done"; criteria?: string[] } = {}): string {
  const id = over.id ?? "wk_1";
  insertWork(db, {
    confirmedAt: 1, id, projectId: "p1", parentWorkId: null,
    title: `工作项 ${id}`, goal: "写出结论",
    status: over.status ?? "open", assigneeAgentId: "wk",
    ...(over.criteria !== undefined ? { acceptanceCriteria: over.criteria } : {}),
    createdAt: T0, updatedAt: T0,
  });
  return id;
}

describe("works.acceptance_criteria(037)· 存取", () => {
  it("create 带判据 → 读回逐条一致;不带 → 空数组(不是 null)", () => {
    mkWork({ id: "wk_a", criteria: ["覆盖 A/B 两种输入", "给出误判率数字"] });
    const w = getWork(db, "wk_a")!;
    expect(w.acceptanceCriteria).toEqual(["覆盖 A/B 两种输入", "给出误判率数字"]);

    mkWork({ id: "wk_b" });
    expect(getWork(db, "wk_b")!.acceptanceCriteria).toEqual([]);
  });

  it("整体替换:[] = 清空(显式动作,不是「没改」)", () => {
    mkWork({ id: "wk_c", criteria: ["旧判据"] });
    expect(updateWorkAcceptance(db, "wk_c", ["新判据 1", "新判据 2"])).toBe(true);
    expect(getWork(db, "wk_c")!.acceptanceCriteria).toEqual(["新判据 1", "新判据 2"]);
    expect(updateWorkAcceptance(db, "wk_c", [])).toBe(true);
    expect(getWork(db, "wk_c")!.acceptanceCriteria).toEqual([]);
  });

  it("坏 JSON 容错:不抛、按空数组读(一个判据存坏了不该让工作项读不出来)", () => {
    mkWork({ id: "wk_d" });
    db.prepare(`UPDATE works SET acceptance_criteria = '{oops' WHERE id = ?`).run("wk_d");
    expect(getWork(db, "wk_d")!.acceptanceCriteria).toEqual([]);
  });

  it("WorkView 原样透出(前端不再自己拼)", () => {
    mkWork({ id: "wk_e", criteria: ["判据一"] });
    const v = toWorkView(db, getWork(db, "wk_e")!, () => "研究员");
    expect(v.acceptanceCriteria).toEqual(["判据一"]);
  });
});

describe("works.acceptance_criteria(037)· 消费(质检的任务正文)", () => {
  it("判据给了 ⇒ renderTask 逐条摆出;没给 ⇒ 明说「未给」,不编", () => {
    // 一条 done 且待审(review_state='pending' 由 done 推导)+ 一条无判据的。
    mkWork({ id: "wk_r1", status: "done", criteria: ["结论必须有出处", "边界情况列出清单"] });
    mkWork({ id: "wk_r2", status: "done" });
    const board = collectTodos({ db, projectId: "p1", now: T0 + 10 });
    const todo = board.runnable.find((t) => t.kind === "review_work");
    expect(todo).toBeDefined();
    const text = renderTask(db, todo!);
    // 逐条对照的靶子要在场 —— 质检判的是「做成什么样算完」,不是 goal 散文。
    expect(text).toContain("结论必须有出处");
    expect(text).toContain("边界情况列出清单");
    expect(text).toContain("未给(037 结构化判据为空)");
    // 判据优先级阶梯:工作项级判据是第 1 层(在 goal 之前)。
    expect(text.indexOf("acceptanceCriteria")).toBeLessThan(text.indexOf("work_brief"));
  });

  it("拆解提示要求逐条给判据(给成散文 = 质检只能猜)", () => {
    const board = collectTodos({ db, projectId: "p1", now: T0 + 10 });
    const todo = board.runnable.find((t) => t.kind === "decompose_project");
    expect(todo).toBeDefined();
    expect(renderTask(db, todo!)).toContain("acceptanceCriteria");
  });
});

// ── 工具层(work_create / work_update 的参数面)──────────────────

let workRoot: string;
let seq = 0;
/** 项目经理身份的调用上下文(work_* 的合法持有人)。 */
function pmCtx(): ToolRunContext {
  const agent = getAgent(db, "pm")!;
  return {
    db, agent, project: loadProjectForAuthz(db, "p1")!,
    now: () => T0, newId: (p) => `${p}_${++seq}`,
    workspace: createGitWorkspace(), workspaceRoot: workRoot,
  };
}
function call(tool: string, args: Record<string, unknown>): ToolResult {
  const r = dispatch(tool, args, pmCtx());
  if (r instanceof Promise) throw new Error("sync only");
  return r;
}

describe("works.acceptance_criteria(037)· 工具层", () => {
  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), "ss-wa-"));
    // 工具层要的是显式成员关系(ensureProjectOrg 已加),再补 pm 的 loadProjectForAuthz 面。
  });
  afterEach(() => rmSync(workRoot, { recursive: true, force: true }));

  it("work_create 带判据 → 落库;类型不对 → 拒收(不是静默当没给)", () => {
    const r = call("work_create", {
      projectId: "p1", title: "调研", goal: "查清楚",
      assigneeRole: "research_worker",
      acceptanceCriteria: ["覆盖三种主流方案", "给出选型理由"],
    });
    expect(r.ok, r.ok ? "" : r.message).toBe(true);
    const w = getWork(db, "wk_1");
    expect(w!.acceptanceCriteria).toEqual(["覆盖三种主流方案", "给出选型理由"]);

    const bad = call("work_create", {
      projectId: "p1", title: "坏形状", goal: "g", assigneeRole: "research_worker",
      acceptanceCriteria: ["正经一条", 42],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_args");
  });

  it("work_update 整体替换:改判据不动状态;[] 清空也是显式动作", () => {
    insertWork(db, {
      confirmedAt: 1, id: "wk_u", projectId: "p1", parentWorkId: null,
      title: "改判据", goal: "g", status: "open", assigneeAgentId: "wk",
      acceptanceCriteria: ["旧判据"], createdAt: T0, updatedAt: T0,
    });
    const r = call("work_update", { workId: "wk_u", acceptanceCriteria: ["新判据"] });
    expect(r.ok, r.ok ? "" : r.message).toBe(true);
    expect(getWork(db, "wk_u")!.acceptanceCriteria).toEqual(["新判据"]);
    expect(getWork(db, "wk_u")!.status).toBe("open"); // 判据不是状态迁移

    const clear = call("work_update", { workId: "wk_u", acceptanceCriteria: [] });
    expect(clear.ok).toBe(true);
    expect(getWork(db, "wk_u")!.acceptanceCriteria).toEqual([]);
  });
});
