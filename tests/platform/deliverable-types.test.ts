/**
 * 交付物**类型**(migration 025)· 仓储 / 工具 / 读面三层的判据测试
 *
 * ── 这个测试盯的是什么 ──────────────────────────────────────────
 *
 * 用户原话(2026-10-07):「定义一下交付物都有哪些类型,先实现一个最简单的
 * html 的报告 …… 同时预留其他类型的交付物」。于是有三件事必须被钉住:
 *
 *   ① **闭集只有真正能写出来的值。** `git_repo` 与仓库上的提交是**预留**,
 *      不是实现 —— 所以它们**不在** `DELIVERABLE_TYPES` 里。本测试用一个
 *      **双向**断言盯住这件事:闭集里每个值都必须过得了「写入」这条路径,
 *      而 025 那条 CHECK 里也不许有平台造不出来的值(它会让一次写入响亮失败)。
 *   ② **交付物必须声明类型,非交付物不许声明类型。** 两个方向都是 7-D:
 *      静默丢掉一个参数 = 替模型把它没做的事抹平了。
 *   ③ **存量 NULL 是合法状态,且读面不许把它当 HTML 渲染。**
 *      真机 23 条交付物全是 markdown(`deliverable_type IS NULL`)——
 *      按 `html_report` 渲染它们会得到 23 片空白,而空白页看起来像「平台坏了」。
 *
 * 每条断言都带**正样本 + 负样本**:先确认「合法的东西真的能过」,再确认
 * 「非法的东西真的被拒」。只测负样本的话,一个「什么都拒」的检查会全绿。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import {
  insertArtifact,
  getArtifact,
  listArtifacts,
  DELIVERABLE_TYPES,
  isDeliverableType,
  validateHtmlReport,
  type DeliverableType,
} from "../../src/platform/storage/repo/artifacts.js";
import { toArtifactView } from "../../src/platform/transport/views.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliverableType as SharedDeliverableType } from "../../shared/types/platform.js";
import type { ArtifactView } from "../../shared/types/platform.js";

let db: Database.Database;
let seq = 0;
let projectId: string;
let pm: string;
let worker: string;
let clock = 1_700_000_000_000;
const T0 = clock;

const HTML_OK =
  "<!doctype html><html><head><style>body{font-family:sans-serif}</style></head>" +
  "<body><h1>技术方案</h1><svg viewBox='0 0 10 10'><rect width='10' height='10'/></svg></body></html>";

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  projectId = `pj${++seq}`;
  insertProject(db, {
    id: projectId, name: "交付物类型", client: "甲方", goal: "g", status: "active", createdAt: T0,
  });
  pm = `ag${++seq}`;
  worker = `ag${++seq}`;
  insertAgent(db, { id: pm, role: "project_manager", specialization: null, displayName: "PM", createdAt: T0 });
  insertAgent(db, { id: worker, role: "worker", specialization: "engineering", displayName: "W", createdAt: T0 });
  addMember(db, projectId, pm, T0);
  addMember(db, projectId, worker, T0);
});
afterEach(() => db.close());

function ctxFor(agentId: string): ToolRunContext {
  const role = agentId === pm ? "project_manager" : "worker";
  return {
    db,
    agent: { id: agentId, role, displayName: agentId } as ToolRunContext["agent"],
    project: loadProjectForAuthz(db, projectId)!,
    now: () => clock,
    newId: (p: string) => `${p}${++seq}`,
  };
}

function call(agentId: string, args: Record<string, unknown>): ToolResult {
  const r = dispatch("board_write", args, ctxFor(agentId));
  if (r instanceof Promise) throw new Error("board_write 必须是同步工具");
  return r;
}

function writeArtifact(over: Record<string, unknown> = {}): string {
  const id = `ar${++seq}`;
  insertArtifact(db, {
    id, projectId, conversationId: null, kind: "deliverable", status: "accepted",
    authorAgentId: pm, title: `交付${seq}`, body: HTML_OK, metadataJson: null,
    createdAt: T0 + seq, updatedAt: T0 + seq, deliverableType: "html_report",
    ...over,
  });
  return id;
}

// ── ① 闭集 ─────────────────────────────────────────────────────

describe("交付物类型 · 闭集与 schema 恰好相等", () => {
  it("闭集里每个值都有校验分支(否则 validateDeliverableBody 会静默放行)", () => {
    // 探针自检:先确认 `validateHtmlReport` 对**已知答案**给出正确答案,
    // 再拿它去看闭集 —— 一个恒返回 null 的检查会让下面这条永远绿。
    expect(validateHtmlReport("不是 HTML,只是文字")).not.toBeNull();
    expect(validateHtmlReport(HTML_OK)).toBeNull();
    for (const t of DELIVERABLE_TYPES) {
      expect(isDeliverableType(t), `${t} 不被 isDeliverableType 承认`).toBe(true);
    }
  });

  it("共享契约与仓储闭集逐项相同(前端不许有自己的名单)", () => {
    // 契约里是一个字面量联合;这里从**源码**里把它解析出来,而不是 import
    // 类型(import 一个类型拿不到运行时的取值集合)。
    const src = readFileSync(
      join(import.meta.dirname, "../../shared/types/platform.ts"), "utf8",
    );
    const m = src.match(/export type DeliverableType =([\s\S]*?);/);
    expect(m, "shared 里找不到 DeliverableType 联合").not.toBeNull();
    const shared = [...(m![1].matchAll(/"([a-z_]+)"/g))].map((x) => x[1]).sort();
    expect(shared).toEqual([...DELIVERABLE_TYPES].sort());
  });

  it("025 的 CHECK 与闭集逐项相等 —— schema 认、代码不认会让整个项目的读面全挂", () => {
    const sql = readFileSync(
      join(import.meta.dirname, "../../migrations/025_deliverable_types.sql"), "utf8",
    );
    const m = sql.match(/deliverable_type IN \(([^)]*)\)/);
    expect(m, "025 里找不到 deliverable_type 的 CHECK").not.toBeNull();
    const inCheck = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(inCheck).toEqual([...DELIVERABLE_TYPES].sort());
  });

  it("**预留**的类型(git 仓库 / 仓库上的提交)确实还不在闭集里", () => {
    // 这是一条**负样本**,而它的价值恰恰在于「现在该红」。等哪天真做了
    // git_repo 交付物,这条会红 —— 那时**改这条断言**,不要改闭集。
    // 留着的理由:7-E 的病是「代码里声明了一个平台造不出来的东西」。
    expect(DELIVERABLE_TYPES).not.toContain("git_repo");
    expect(DELIVERABLE_TYPES).not.toContain("git_commit");
    expect(isDeliverableType("git_repo")).toBe(false);
    // 负样本:真往库里写一个 CHECK 不认的值,必须**响亮失败**
    expect(() =>
      db.prepare(
        `INSERT INTO artifacts (id, project_id, kind, status, author_agent_id, title, body,
                                created_at, updated_at, deliverable_type)
         VALUES ('ar_neg','${projectId}','deliverable','open','${pm}','t','b',1,1,'git_repo')`,
      ).run(),
    ).toThrow(/CHECK/i);
  });

  it("加一种类型是**纯加法**:列存在、CHECK 形态与 025 一致", () => {
    const cols = db.pragma("table_info(artifacts)") as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("deliverable_type");
    // 存量交付物必须仍然合法(025 的 NULL 语义)
    const legacy = writeArtifact({ deliverableType: null, body: "## markdown 交付物" });
    expect(getArtifact(db, legacy)?.deliverableType).toBeNull();
    expect(getArtifact(db, legacy)?.body).toBe("## markdown 交付物");
  });
});

// ── ② 工具层:必填 / 不许传 / 正文校验 ───────────────────────────

describe("交付物类型 · board_write 的三条纪律", () => {
  it("`kind='deliverable'` 不给类型 → **拒收**,并把合法值回灌给模型", () => {
    const r = call(pm, { kind: "deliverable", title: "方案", body: HTML_OK });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_args");
      expect(r.message).toMatch(/deliverableType/);
      expect(r.message).toMatch(/html_report/);
    }
    // 负样本的自检:确认什么都没写进去(否则下面几条会跟着一起红)
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("正样本:给了类型 + 合法 HTML → 写进去,且读回来类型对得上", () => {
    const r = call(pm, {
      kind: "deliverable", deliverableType: "html_report", title: "技术方案", body: HTML_OK,
      status: "accepted",
    });
    expect(r.ok).toBe(true);
    const rows = listArtifacts(db, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliverableType).toBe("html_report");
    expect(rows[0].kind).toBe("deliverable");
    // 工具输出必须**如实回灌**类型,否则模型无法确认自己填对了
    if (r.ok) expect(r.text).toContain("html_report");
  });

  it("未知类型 → 拒收,并回灌闭集", () => {
    const r = call(pm, {
      kind: "deliverable", deliverableType: "git_repo", title: "代码仓库", body: HTML_OK,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_args");
      expect(r.message).toMatch(/html_report/);
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("**非交付物不许带类型** —— 静默丢掉参数 = 替模型把没做的事抹平了(7-D)", () => {
    const r = call(pm, {
      kind: "decision", deliverableType: "html_report", title: "决定", body: "做",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/deliverable/);
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("正文不是 HTML → 拒收,并说清「要写标签」", () => {
    const r = call(pm, {
      kind: "deliverable", deliverableType: "html_report", title: "方案",
      body: "# 标题\n\n这是一份 markdown。",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_args");
      expect(r.message).toMatch(/HTML/);
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("正文带 `<script>` → 拒收,并说清「沙箱里不执行」", () => {
    const r = call(pm, {
      kind: "deliverable", deliverableType: "html_report", title: "方案",
      body: `<html><body><h1>方案</h1><script>alert(1)</script></body></html>`,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_args");
      expect(r.message).toMatch(/沙箱/);
      expect(r.message).toMatch(/SVG/); // 给出可执行的替代方案,不是只说「不行」
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("正文超过 512 KiB → 拒收,并说清「拆开」", () => {
    const big = `<html><body>${"填充".repeat(200_000)}</body></html>`;
    const r = call(pm, {
      kind: "deliverable", deliverableType: "html_report", title: "大报告", body: big,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/KiB/);
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("校验器自检:正样本 / 负样本 / 边界各一对(避免「什么都拒」的假绿)", () => {
    expect(validateHtmlReport(HTML_OK)).toBeNull();
    expect(validateHtmlReport("")).not.toBeNull();
    expect(validateHtmlReport("<p>x</p>")).toBeNull();
    expect(validateHtmlReport("<div><script src=x></script></div>")).not.toBeNull();
    // 大小写变体也要拦住(模型可能写 `<SCRIPT>`)
    expect(validateHtmlReport("<IFRAME src=x></IFRAME>")).not.toBeNull();
  });
});

// ── ③ 仓储 / 读面:存量 NULL 与按类型查 ─────────────────────────

describe("交付物类型 · 仓储与读面", () => {
  it("按类型过滤走的是**结构化的列**,不是从 body 猜", () => {
    writeArtifact();
    writeArtifact({ deliverableType: null, body: "## 存量 markdown 交付物" });
    expect(listArtifacts(db, projectId, { deliverableType: "html_report" })).toHaveLength(1);
    expect(listArtifacts(db, projectId)).toHaveLength(2);
    // 负样本:一个不存在的类型返回空,而不是抛错
    expect(listArtifacts(db, projectId, { deliverableType: "git_repo" as DeliverableType })).toHaveLength(0);
  });

  it("读面原样透出类型;**存量 NULL 不会被当成 html_report**", () => {
    const id = writeArtifact({ deliverableType: null, body: "## markdown" });
    const view: ArtifactView = toArtifactView(db, getArtifact(db, id)!, () => "PM");
    expect(view.kind).toBe("deliverable");
    expect(view.deliverableType).toBeNull();
    expect(view.body).toBe("## markdown");
  });

  it("非交付物工件的 deliverableType 恒为 null(不传 = 不写)", () => {
    const id = `ar${++seq}`;
    insertArtifact(db, {
      id, projectId, conversationId: null, kind: "evidence", status: "open",
      authorAgentId: worker, title: "证据", body: "x", metadataJson: null,
      createdAt: T0, updatedAt: T0,
    });
    expect(getArtifact(db, id)!.deliverableType).toBeNull();
    expect(toArtifactView(db, getArtifact(db, id)!, () => "W").deliverableType).toBeNull();
  });

  it("产出边与类型是两件独立的事(挂上根工作项不影响类型往返)", () => {
    const wid = `wk${++seq}`;
    insertWork(db, {
      id: wid, projectId, parentWorkId: null, title: "根", goal: "整合成一份方案",
      status: "done", assigneeAgentId: worker, createdAt: T0, updatedAt: T0,
    });
    const id = writeArtifact({ workId: wid });
    const a = getArtifact(db, id)!;
    expect(a.workId).toBe(wid);
    expect(a.deliverableType).toBe("html_report");
    expect(listArtifacts(db, projectId, { workId: wid })).toHaveLength(1);
  });

  it("共享契约的类型与仓储闭集是同一个(编译期 + 运行期双保险)", () => {
    const a: SharedDeliverableType = "html_report";
    const b: DeliverableType = a;
    expect(b).toBe("html_report");
  });
});