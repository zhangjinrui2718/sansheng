/**
 * 收口复盘工件(project_close 自动落一条 note)· 测试
 *
 * ── 这一批钉住的判据 ──────────────────────────────────────────────
 *
 *   ① **close 之后 note 存在**:kind='note' / title=`复盘:<项目名>` /
 *      status='accepted' / authorAgentId=调用 close 的那个 agent;
 *   ② **计数字段与库一致**:工作项 done/cancelled、提问总数与已答复数、
 *      交付物份数(与 project_list 同一条 SQL)、历时(created→closed);
 *      全部来自结构化列,没有一项来自模型自述;
 *   ③ **cancelled 项被逐条列出**(「未做 / 已知限制」);没有 cancelled ⇒
 *      这一节整段不出现 —— 「没有取消」是事实,不是缺一节;
 *   ④ **先文件后插行**:正文落盘失败(工作区未装配)⇒ close 照常成功、
 *      **一行都不插**、文本如实告警(不回滚收口,也绝不留「有索引无内容」)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import {
  insertProject, addMember, loadProjectForAuthz, getProjectRow, markCloseConsent,
} from "../../src/platform/storage/repo/projects.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import {
  insertWork, getWork,
} from "../../src/platform/storage/repo/works.js";
import { insertAsk, answerAsk } from "../../src/platform/storage/repo/asks.js";
import { insertArtifact, listArtifacts } from "../../src/platform/storage/repo/artifacts.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";
import type { ProjectRole } from "../../src/platform/identity/role.js";

const T0 = 1_700_000_000_000;
const DAY = 86_400_000;
const PID = "pj_retro";

let db: Database.Database;
let workRoot: string;
let seq = 0;
let clock = T0;
const agents = new Map<string, Agent>();
let project: Project;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), "sansheng-project-retro-"));
  db = openPlatformMemoryDb();
  seq = 0;
  clock = T0;
  agents.clear();
  for (const role of ["business_manager", "project_manager", "research_worker"] as ProjectRole[]) {
    const id = `ag_${role}`;
    insertAgent(db, { id, role, specialization: null, displayName: role, createdAt: T0 });
    agents.set(id, { id, role, displayName: role });
  }
  insertProject(db, {
    id: PID, name: "复盘测试项目", client: "甲方", goal: "做完收好", status: "active", createdAt: T0,
  });
  for (const id of agents.keys()) addMember(db, PID, id, T0);
  project = loadProjectForAuthz(db, PID)!;
});

afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

function ctxFor(agentId: string, over: Partial<ToolRunContext> = {}): ToolRunContext {
  const agent = agents.get(agentId);
  if (!agent) throw new Error(`未知 agent ${agentId}`);
  return {
    db,
    agent,
    project,
    now: () => clock,
    newId: (prefix) => `${prefix}_new${++seq}`,
    workspace: createGitWorkspace(),
    workspaceRoot: workRoot,
    ...over,
  };
}

function call(agentId: string, tool: string, args: Record<string, unknown> = {}): ToolResult {
  const r = dispatch(tool, args, ctxFor(agentId));
  if (r instanceof Promise) throw new Error("本测试只覆盖同步工具");
  return r;
}

/** 027 起正文住文件:夹具直接造落点三列(sha 现算,不是占位串)。 */
function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

function mkWork(id: string, over: { status?: "open" | "done" | "cancelled"; title?: string } = {}): void {
  insertWork(db, { confirmedAt: 1,
    id, projectId: PID, parentWorkId: null,
    title: over.title ?? id, goal: "做完",
    status: over.status ?? "open",
    assigneeAgentId: "ag_research_worker",
    createdAt: T0, updatedAt: T0,
  });
}

function mkDeliverable(id: string): void {
  insertArtifact(db, {
    id, projectId: PID, conversationId: null,
    kind: "deliverable", status: "accepted", authorAgentId: "ag_research_worker",
    title: "最终报告", deliverableType: "html_report",
    ...bodyAt(`artifacts/${id}.html`, "<!doctype html><html><body>报告</body></html>"),
    metadataJson: null,
    createdAt: T0 + 1, updatedAt: T0 + 1,
  });
}

/** 复盘 note(项目里唯一一条 kind='note')。没有 ⇒ 抛出,让断言失败得可读。 */
function retroNote(): { id: string; title: string; status: string; authorAgentId: string; bodyPath: string; body: string } {
  const notes = listArtifacts(db, PID, { kind: "note" });
  if (notes.length !== 1) throw new Error(`期望恰好 1 条 note,实际 ${notes.length}`);
  const row = notes[0]!;
  const body = readFileSync(join(workRoot, "projects", PID, row.bodyPath), "utf8");
  return {
    id: row.id, title: row.title, status: row.status, authorAgentId: row.authorAgentId,
    bodyPath: row.bodyPath, body,
  };
}

// ══ ① + ② + ③ ════════════════════════════════════════════════

describe("project_close 落复盘 note", () => {
  it("close 之后 note 存在:字段正确、计数与库一致、cancelled 项被列出", () => {
    mkWork("wk_a", { status: "done", title: "路线调研 A" });
    mkWork("wk_b", { status: "done", title: "路线调研 B" });
    mkWork("wk_c", { status: "cancelled", title: "综合对比(旧路线)" });
    mkWork("wk_d", { status: "open", title: "没做完的收尾" });
    mkDeliverable("art_final");
    insertAsk(db, {
      id: "ak_1", projectId: PID, fromAgentId: "ag_business_manager", toAgentId: "ag_project_manager",
      question: "范围要不要收?", hypothesis: "默认按原范围走", createdAt: T0 + 2,
    });
    insertAsk(db, {
      id: "ak_2", projectId: PID, fromAgentId: "ag_project_manager", toAgentId: "ag_research_worker",
      question: "路线 B 的数据?", hypothesis: "公开年报可查", createdAt: T0 + 3,
    });
    answerAsk(db, "ak_2", T0 + 4, null); // 2 条提问、答复 1 条

    clock = T0 + 3 * DAY; // 恰好 3 天
    markCloseConsent(db, PID, T0);
    const r = call("ag_business_manager", "project_close", { outcome: "done" });
    if (!r.ok) throw new Error(`close 失败:${r.message}`);
    expect(getProjectRow(db, PID)?.status).toBe("done");

    const note = retroNote();
    expect(note.title).toBe("复盘:复盘测试项目");
    expect(note.status).toBe("accepted");
    // 归属调用 close 的 agent(business_manager 是唯一持 project.close 的角色)
    expect(note.authorAgentId).toBe("ag_business_manager");
    // 正文先落了文件:路径在项目仓的 artifacts/ 下,读得回来
    expect(note.bodyPath).toMatch(/^artifacts\//);

    // ② 计数字段与库一致(库里的行,不是工具的返回文本)
    expect(note.body).toContain("# 复盘:复盘测试项目");
    expect(note.body).toContain("完成 2 条 · 取消 1 条(共 4 条)");
    expect(note.body).toContain("共 2 条,已答复 1 条");
    expect(note.body).toContain("交付物:1 份");
    expect(note.body).toContain("约 3 天");
    expect(note.body).toContain(new Date(T0).toISOString());
    expect(note.body).toContain(new Date(T0 + 3 * DAY).toISOString());

    // ③ cancelled 项逐条列出(title + id)
    expect(note.body).toContain("未做 / 已知限制");
    expect(note.body).toContain("综合对比(旧路线)");
    expect(note.body).toContain("wk_c");
    // 调用文本里给得出工件 id
    expect(r.text).toContain(`复盘工件:${note.id}`);
  });

  it("没有被取消的工作项 ⇒「未做 / 已知限制」一节整段不出现(不是空一节)", () => {
    mkWork("wk_ok", { status: "done", title: "唯一一件活" });
    clock = T0 + DAY;
    markCloseConsent(db, PID, T0);
    const r = call("ag_business_manager", "project_close", { outcome: "done" });
    if (!r.ok) throw new Error(`close 失败:${r.message}`);
    const note = retroNote();
    expect(note.body).not.toContain("未做 / 已知限制");
    expect(note.body).toContain("取消 0 条");
    expect(r.text).toContain("复盘工件:");
  });

  it("abandoned 也落复盘(放弃不需要甲方验收,但同样要留下现场)", () => {
    mkWork("wk_x", { status: "cancelled", title: "做了一半的方向" });
    clock = T0 + DAY;
    const r = call("ag_business_manager", "project_close", { outcome: "abandoned", reason: "甲方砍预算" });
    if (!r.ok) throw new Error(`close 失败:${r.message}`);
    const note = retroNote();
    expect(note.body).toContain("放弃(abandoned) — 甲方砍预算");
    expect(note.body).toContain("做了一半的方向");
  });
});

// ══ ④ 失败形态 ════════════════════════════════════════════════

describe("复盘写不成:close 不回滚、一行都不插、文本如实告警", () => {
  it("工作区未装配 ⇒ close 照常成功、无 note 行、文本带装配告警", () => {
    mkWork("wk_y", { status: "done", title: "唯一一件活" });
    clock = T0 + DAY;
    // workspace / workspaceRoot 双双缺席(装配错误的现场:纯工具单测没接工作区)
    const noWorkspace: ToolRunContext = {
      db,
      agent: agents.get("ag_business_manager")!,
      project,
      now: () => clock,
      newId: (prefix) => `${prefix}_none${++seq}`,
    };
    markCloseConsent(db, PID, T0);
    const tool = dispatch("project_close", { outcome: "done" }, noWorkspace);
    if (tool instanceof Promise) throw new Error("同步工具");
    if (!tool.ok) throw new Error(`close 失败:${tool.message}`);
    expect(getProjectRow(db, PID)?.status).toBe("done"); // 收口照常发生
    expect(listArtifacts(db, PID, { kind: "note" })).toHaveLength(0); // 一行都不插
    expect(tool.text).toContain("复盘工件未写入");
    expect(tool.text).toContain("装配");
  });

  it("正文写盘失败 ⇒ 不插行(「有索引无内容」不可与「被删」区分)", () => {
    mkWork("wk_z", { status: "done", title: "唯一一件活" });
    clock = T0 + DAY;
    const broken: ToolRunContext = ctxFor("ag_business_manager", {
      workspace: {
        // writeAtomic 永远失败 —— 模拟盘满 / 权限等写盘故障
        writeAtomic: () => ({ ok: false, problem: "EACCES: 模拟写盘失败" }),
      } as unknown as ToolRunContext["workspace"],
    });
    markCloseConsent(db, PID, T0);
    const tool = dispatch("project_close", { outcome: "done" }, broken);
    if (tool instanceof Promise) throw new Error("同步工具");
    if (!tool.ok) throw new Error(`close 失败:${tool.message}`);
    expect(getProjectRow(db, PID)?.status).toBe("done"); // 收口不回滚
    expect(listArtifacts(db, PID, { kind: "note" })).toHaveLength(0); // 一行都不插
    expect(tool.text).toContain("复盘工件未写入");
    expect(tool.text).toContain("EACCES");
    expect(getWork(db, "wk_z")?.status).toBe("done"); // 现场未被误伤
  });
});
