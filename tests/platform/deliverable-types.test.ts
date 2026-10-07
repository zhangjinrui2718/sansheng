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
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitCodeService } from "../../src/platform/codeservice/git.js";
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

// ── 代码服务:一个**真的**工作根与一批真的 git 仓库 ────────────────
//
// 这一组测试刻意**不桩掉磁盘与 git**:`code_service` 的全部价值就是
// 「平台真的去核对过」,桩掉它等于把被测对象换成测试自己写的东西。
let root: string | null = null;
function workspace(): string {
  if (root === null) throw new Error("工作根还没建");
  return root;
}

/** 在临时工作根里建一个真 git 仓库,返回 {path, head}。 */
function makeRepo(name: string, opts: { dockerfile?: boolean; commit?: boolean } = {}): {
  path: string; head: string;
} {
  const dir = join(workspace(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  if (opts.dockerfile !== false) {
    writeFileSync(
      join(dir, "Dockerfile"),
      "FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD [\"node\",\"index.js\"]\n",
    );
  }
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a],
      { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    ).trim();
  git("init", "-b", "main");
  if (opts.commit !== false) {
    git("add", "-A");
    git("commit", "-m", `交付 ${name}`);
  }
  const head = opts.commit === false ? "" : git("rev-parse", "HEAD");
  return { path: dir, head };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sansheng-codesvc-"));
  db = openPlatformMemoryDb();
  seq = 0;
  projectId = `pj${++seq}`;
  insertProject(db, {
    id: projectId, name: "交付物类型", client: "甲方", goal: "g", status: "active", createdAt: T0,
  });
  pm = `ag${++seq}`;
  worker = `ag${++seq}`;
  insertAgent(db, { id: pm, role: "project_manager", specialization: null, displayName: "PM", createdAt: T0 });
  insertAgent(db, { id: worker, role: "research_worker", specialization: "engineering", displayName: "研究员", createdAt: T0 });
  addMember(db, projectId, pm, T0);
  addMember(db, projectId, worker, T0);
});
afterEach(() => {
  db.close();
  if (root !== null) rmSync(root, { recursive: true, force: true });
  root = null;
});

function ctxFor(agentId: string, withCodeService = true): ToolRunContext {
  const role = agentId === pm ? "project_manager" : "research_worker";
  return {
    db,
    agent: { id: agentId, role, displayName: agentId } as ToolRunContext["agent"],
    project: loadProjectForAuthz(db, projectId)!,
    now: () => clock,
    newId: (p: string) => `${p}${++seq}`,
    // 核对面:**真实现 + 一个临时工作根**。`code_service` 的判据全在磁盘上,
    // 用假实现测等于把被测对象换成测试自己写的桩。
    ...(withCodeService
      ? { codeService: createGitCodeService({ workspaceRoot: workspace() }) }
      : {}),
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

  it("**现行** CHECK(026 重建后)与闭集逐项相等 —— schema 认、代码不认会让整个项目的读面全挂", () => {
    // ⚠️ 判据是**现行 schema**,不是 025 那个文件。026 重建过 `artifacts`
    // (SQLite 改不了已有 CHECK),所以 025 里那份 `('html_report')` 已经
    // **不是**生效的那一个 —— 照它断言会在加了 `code_service` 之后假绿。
    // 两份都看:025 是历史、026 是现行。
    const sql026 = readFileSync(
      join(import.meta.dirname, "../../migrations/026_worker_split_and_code_service.sql"), "utf8",
    );
    const m = sql026.match(/deliverable_type IN \(([^)]*)\)/);
    expect(m, "026 里找不到 deliverable_type 的 CHECK").not.toBeNull();
    const inCheck = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(inCheck).toEqual([...DELIVERABLE_TYPES].sort());
    // 真 schema 上再问一次(前两份都是「文件形态」,这一条是「实际生效」)
    const ddl = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'",
    ).get() as { sql: string }).sql;
    const live = ddl.match(/deliverable_type IN \(([^)]*)\)/);
    expect(live, "真 schema 里找不到 deliverable_type 的 CHECK").not.toBeNull();
    expect([...live![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort())
      .toEqual([...DELIVERABLE_TYPES].sort());
  });

  it("闭集里每个值都必须**有真的写入口** —— 没有写入口的不许进闭集", () => {
    // 2026-10-07 时这条是一句「`git_repo` 还是红的」;2026-10-08 加了
    // `code_service` 之后,判据要说得更准:**不是「谁更该有名字」,是「有没有写入口」**。
    //   · `code_service` 有 —— 写入那一刻平台去盘上核对仓库(见下面那组测试);
    //   · 「仓库上的某几个提交」「镜像」「部署实例」还没有 —— 所以它们不在闭集里。
    // 7-E 的病是「代码里声明了一个平台造不出来的东西」:一个没有写入口的值进闭集,
    // 模型就会照着这个声明去 board_write,然后拿到一条「还没实现」的错误。
    expect(DELIVERABLE_TYPES).toContain("code_service");
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

  it("加一种类型是**纯加法**:列存在、存量 NULL 仍然合法", () => {
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
// ── ④ `code_service`:写入口带**现场核对**(migration 026)─────────────

describe("代码服务 · 写入口带现场核对", () => {
  /** 一个默认合法的交付参数(测试里逐项替换成坏值看它拒不拒)。 */
  function claim(repo: { path: string; head: string }, over: Record<string, unknown> = {}) {
    return {
      kind: "deliverable",
      deliverableType: "code_service",
      title: "计费服务",
      body: "## 计费服务\n\n`docker build -t billing .` → `docker run -p 8080:8080 billing`",
      metadata: {
        repoPath: repo.path, branch: "main", headCommit: repo.head,
        service: "billing", port: 8080, ...over,
      },
    };
  }

  it("正样本:真仓库 + 坐标对得上 → 写进去,且坐标被**平台读到的事实**覆盖", () => {
    const repo = makeRepo("billing");
    // 模型只给**短 sha** —— 平台要把它归一成全 sha,而不是照抄
    const r = call(pm, claim(repo, { headCommit: repo.head.slice(0, 8) }));
    expect(r.ok, !r.ok ? r.message : "").toBe(true);
    const rows = listArtifacts(db, projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0].deliverableType).toBe("code_service");
    const md = JSON.parse(rows[0].metadataJson ?? "{}") as Record<string, unknown>;
    expect(md["headCommit"]).toBe(repo.head); // 全 sha,不是模型给的短 sha
    expect(md["branch"]).toBe("main");
    expect(md["service"]).toBe("billing");
    expect(md["port"]).toBe(8080);
    expect(md["dockerfile"]).toBe("Dockerfile");
    expect(md["commitCount"]).toBe(1);
    expect(typeof md["verifiedAt"]).toBe("number");
    expect(md["files"]).toContain("Dockerfile");
    // 模型自己给的额外键**原样保留**(平台只覆盖它能核实的那几个)
    expect(md["repoName"]).toBe("billing");
  });

  it("负样本:headCommit 与真实 HEAD 不一致 → 拒收,并**告诉它真实 sha**", () => {
    const repo = makeRepo("billing");
    const r = call(pm, claim(repo, { headCommit: "0".repeat(40) }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("invalid_args");
      expect(r.message).toContain(repo.head); // 可执行的处置:把这个值填回去
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:仓库目录不存在 → 拒收(声明不能代替磁盘上的东西)", () => {
    const r = call(pm, claim({ path: join(workspace(), "并不存在"), head: "a".repeat(40) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/找不到路径/);
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:不是一个 git 仓库 → 拒收", () => {
    const dir = join(workspace(), "plain");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    const r = call(pm, claim({ path: dir, head: "a".repeat(40) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/git/);
  });

  it("负样本:没有 Dockerfile → 拒收(「可以独立部署到 docker」的机械判据)", () => {
    const repo = makeRepo("nodocker", { dockerfile: false });
    const r = call(pm, claim(repo));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Dockerfile/);
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:仓库还没有提交 → 拒收(clone 下来是空目录,无法部署)", () => {
    const repo = makeRepo("empty", { commit: false });
    const r = call(pm, claim({ path: repo.path, head: "a".repeat(40) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/提交/);
  });

  it("负样本:分支不存在 → 拒收,并把现有分支列出来", () => {
    const repo = makeRepo("billing");
    const r = call(pm, claim(repo, { branch: "release" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/release/);
      expect(r.message).toMatch(/main/); // 回灌现有分支 = 可执行的处置
    }
  });

  it("负样本:路径在工作根**之外** → 拒收(realpath 之后比,符号链接也拦得住)", () => {
    const outside = mkdtempSync(join(tmpdir(), "sansheng-outside-"));
    try {
      const r = call(pm, claim({ path: outside, head: "a".repeat(40) }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/工作根/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("负样本:metadata 缺坐标 → 拒收,**点名**缺哪几项", () => {
    const repo = makeRepo("billing");
    const args = claim(repo);
    const md = { ...(args.metadata as Record<string, unknown>) };
    delete md["port"];
    const r = call(pm, { ...args, metadata: md });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("port");
      expect(r.alternatives).toContain("repoPath");
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:port 不是合法端口 → 拒收", () => {
    const repo = makeRepo("billing");
    for (const bad of [0, -1, 70000, 8080.5, "8080"]) {
      const r = call(pm, claim(repo, { port: bad }));
      expect(r.ok, `port=${String(bad)} 竟然通过了`).toBe(false);
    }
  });

  it("负样本:正文是一份 HTML 文档 → 拒收(读面按 markdown 渲染它)", () => {
    const repo = makeRepo("billing");
    const args = claim(repo);
    const r = call(pm, { ...args, body: "<!doctype html><html><body>hi</body></html>" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/markdown|html_report/);
  });

  it("负样本:**没接核对面**时拒收(装配错误),而不是静默放行", () => {
    const repo = makeRepo("billing");
    const r = dispatch("board_write", claim(repo), ctxFor(pm, false));
    if (r instanceof Promise) throw new Error("board_write 必须是同步工具");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("internal");
      expect(r.message).toMatch(/装配错误/);
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("正样本:工具输出**如实回灌核实到的坐标**(模型看不到就无法确认下一轮)", () => {
    const repo = makeRepo("billing");
    const r = call(pm, claim(repo));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain(repo.head); // 全 sha,不是它给的短 sha
      expect(r.text).toContain("分支 main");
      expect(r.text).toContain("核实过");
    }
  });

  it("正样本:读面(`toArtifactView`)把坐标解析成契约形状;非代码服务恒为 null", () => {
    const repo = makeRepo("billing");
    expect(call(pm, claim(repo)).ok).toBe(true);
    const cs = getArtifact(db, listArtifacts(db, projectId)[0]!.id)!;
    const view = toArtifactView(db, cs, () => "PM");
    expect(view.codeService).not.toBeNull();
    expect(view.codeService!.headCommit).toBe(repo.head);
    expect(view.codeService!.service).toBe("billing");
    expect(view.codeService!.port).toBe(8080);
    expect(view.codeService!.files).toContain("Dockerfile");
    // 负样本:一份 HTML 报告**没有**坐标(不是空对象 —— 那是另一种信息)
    const htmlId = writeArtifact();
    expect(toArtifactView(db, getArtifact(db, htmlId)!, () => "PM").codeService).toBeNull();
  });

  it("读面防御:metadata 缺项 / 坏 JSON → 该字段是 null,而不是崩或编默认值", () => {
    // 老行 / 手改的行里可能出现这些。读面**读不到就说读不到** ——
    // 编一个默认端口会让人照着一条错的命令去部署。
    const id = writeArtifact({ deliverableType: "code_service", metadataJson: '{"service":"x"}' });
    const v = toArtifactView(db, getArtifact(db, id)!, () => "PM");
    expect(v.codeService!.service).toBe("x");
    expect(v.codeService!.port).toBeNull();
    expect(v.codeService!.branch).toBeNull();
    const bad = writeArtifact({ deliverableType: "code_service", metadataJson: "{不是 JSON" });
    expect(toArtifactView(db, getArtifact(db, bad)!, () => "PM").codeService!.service).toBeNull();
  });

  it("正样本:两个执行角色都能写 `deliverable`(写权不是一个角色的特权)", () => {
    const repo = makeRepo("billing");
    // coding_worker 是本条交付物的**本来作者**;这里用同一套 ctx 换角色验证写权门
    const ctx = ctxFor(worker);
    const coding = { ...ctx, agent: { ...ctx.agent, role: "coding_worker" as const } };
    const r = dispatch("board_write", claim(repo), coding);
    if (r instanceof Promise) throw new Error("board_write 必须是同步工具");
    expect(r.ok, !r.ok ? r.message : "").toBe(true);
  });
});
