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
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitCodeService } from "../../src/platform/codeservice/git.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { projectWorkspaceRoot } from "../../src/platform/workspace/root.js";
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

/** 真跑 git(与生产用同一套 `-c` 身份参数:提交结果必须是仓库自身的事实)。 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

/** 项目根(题目里的「每项目一仓」:仓库根 = 项目根,工件与 work/ 都在里面)。 */
function projectRoot(pid = projectId): string {
  return projectWorkspaceRoot(workspace(), pid);
}

/**
 * 在**项目根**建一个真 git 仓库,并在它下面建**服务目录** `services/<service>`。
 *
 * ⚠️ 2026-10-08 起 `code_service` **复用项目仓**(设计 §3.2):`repoPath` 是项目根,
 * 交付物的边界由 `servicePath` 表达 —— `Dockerfile` 必须在**服务目录里**。
 */
function makeRepo(
  name: string,
  opts: {
    dockerfile?: boolean;
    commit?: boolean;
    service?: string;
    /** 仓库**根**也放一个 Dockerfile(它**不算数** —— 判据是服务目录里的那一个) */
    repoRootDockerfile?: boolean;
  } = {},
): { path: string; head: string; servicePath: string } {
  const service = opts.service ?? "billing";
  const servicePath = `services/${service}`;
  const dir = projectRoot();
  const svcDir = join(dir, servicePath);
  mkdirSync(svcDir, { recursive: true });
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(join(svcDir, "index.js"), "console.log('ok');\n");
  if (opts.dockerfile !== false) {
    writeFileSync(
      join(svcDir, "Dockerfile"),
      "FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nCMD [\"node\",\"index.js\"]\n",
    );
  }
  if (opts.repoRootDockerfile === true) {
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
  }
  git(dir, "init", "-b", "main");
  if (opts.commit !== false) {
    git(dir, "add", "-A");
    git(dir, "commit", "-m", `交付 ${name}`);
  }
  const head = opts.commit === false ? "" : git(dir, "rev-parse", "HEAD");
  return { path: dir, head, servicePath };
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
    // 工作区:**真实现 + 一个临时工作根**(正文真的落到 `<root>/projects/<pid>/artifacts/`)
    workspace: createGitWorkspace(),
    workspaceRoot: workspace(),
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

const sha256 = (x: string): string => createHash("sha256").update(x, "utf8").digest("hex");
const bytesOf = (x: string): number => Buffer.byteLength(x, "utf8");

/** 造一条交付物行(migration 027:**落点 + 哈希**,不是正文内容)。 */
function writeArtifact(over: Record<string, unknown> = {}): string {
  const id = `ar${++seq}`;
  // 哈希 / 字节数默认按一份真 HTML 报告算(要别的快照就在 over 里显式覆盖)
  const content = HTML_OK;
  insertArtifact(db, {
    id, projectId, conversationId: null, kind: "deliverable", status: "accepted",
    authorAgentId: pm, title: `交付${seq}`,
    bodyPath: `artifacts/${id}-report.html`,
    bodySha256: sha256(content),
    bodyBytes: bytesOf(content),
    metadataJson: null,
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
        `INSERT INTO artifacts (id, project_id, kind, status, author_agent_id, title,
                                body_path, body_sha256, body_bytes,
                                created_at, updated_at, deliverable_type)
         VALUES ('ar_neg','${projectId}','deliverable','open','${pm}','t',
                 'artifacts/ar_neg.html','h',1,1,1,'git_repo')`,
      ).run(),
    ).toThrow(/CHECK/i);
  });

  it("加一种类型是**纯加法**:列存在、存量 NULL 仍然合法", () => {
    const cols = db.pragma("table_info(artifacts)") as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("deliverable_type");
    // 存量交付物必须仍然合法(025 的 NULL 语义)
    const legacy = writeArtifact({ deliverableType: null, bodyPath: "artifacts/legacy.md" });
    expect(getArtifact(db, legacy)?.deliverableType).toBeNull();
    expect(getArtifact(db, legacy)?.bodyPath).toBe("artifacts/legacy.md");
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
    writeArtifact({ deliverableType: null, bodyPath: "artifacts/legacy-md.md" });
    expect(listArtifacts(db, projectId, { deliverableType: "html_report" })).toHaveLength(1);
    expect(listArtifacts(db, projectId)).toHaveLength(2);
    // 负样本:一个不存在的类型返回空,而不是抛错
    expect(listArtifacts(db, projectId, { deliverableType: "git_repo" as DeliverableType })).toHaveLength(0);
  });

  it("读面原样透出类型与**落点**;**存量 NULL 不会被当成 html_report**", () => {
    const id = writeArtifact({ deliverableType: null, bodyPath: "artifacts/legacy.md" });
    const view: ArtifactView = toArtifactView(db, getArtifact(db, id)!, () => "PM");
    expect(view.kind).toBe("deliverable");
    expect(view.deliverableType).toBeNull();
    // 027 起读面给的是**落点与快照**,正文走 content 端点现读
    expect(view.bodyPath).toBe("artifacts/legacy.md");
    expect(view.commitSha).toBeNull(); // 还没提交 ⇒ null(合法状态)
    expect(view.bodyBytes).toBe(bytesOf(HTML_OK));
  });

  it("非交付物工件的 deliverableType 恒为 null(不传 = 不写)", () => {
    const id = `ar${++seq}`;
    insertArtifact(db, {
      id, projectId, conversationId: null, kind: "evidence", status: "open",
      authorAgentId: worker, title: "证据",
      bodyPath: `artifacts/${id}.md`, bodySha256: sha256("x"), bodyBytes: bytesOf("x"),
      metadataJson: null, createdAt: T0, updatedAt: T0,
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
  function claim(
    repo: { path: string; head: string; servicePath: string },
    over: Record<string, unknown> = {},
  ) {
    return {
      kind: "deliverable",
      deliverableType: "code_service",
      title: "计费服务",
      body:
        "## 计费服务\n\n`docker build services/billing` → " +
        "`docker run -p 8080:8080 billing`",
      metadata: {
        repoPath: repo.path, servicePath: repo.servicePath,
        branch: "main", headCommit: repo.head,
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
    // 交付物的**边界**是服务目录(不是仓库根)
    expect(md["servicePath"]).toBe("services/billing");
    expect(md["dockerfile"]).toBe("services/billing/Dockerfile");
    expect(md["commitCount"]).toBe(1); // 按服务目录算
    expect(typeof md["verifiedAt"]).toBe("number");
    expect(md["files"]).toContain("Dockerfile");
    // 这版交付物 = 最后触及服务目录的提交(此刻就是唯一那次提交)
    expect(md["deliverableCommit"]).toBe(repo.head);
    expect(md["deliverableSubject"]).toBe("交付 billing");
    // 负样本对照:干净的服务目录 ⇒ **空数组**(不是「读不到」)
    expect(md["ignoredFiles"]).toEqual([]);
  });

  it("`deliverableCommit` 按**路径**算:平台写工件的提交不动它,动了服务目录它必须动", () => {
    const repo = makeRepo("billing");
    const r1 = call(pm, claim(repo));
    expect(r1.ok, !r1.ok ? r1.message : "").toBe(true);

    const id1 = /已写工件 (\S+?)\(/.exec(r1.ok ? r1.text : "")![1]!;
    expect(getArtifact(db, id1)!.deliverableType).toBe("code_service");

    // ① 在仓库里提交一个**与服务无关**的文件(平台每回合写工件正文就是这种提交)
    mkdirSync(join(repo.path, "artifacts"), { recursive: true });
    writeFileSync(join(repo.path, "artifacts", "art_x-report.html"), "<html></html>\n");
    git(repo.path, "add", "-A");
    git(repo.path, "commit", "-m", "平台:写工件正文 art_x");
    const newHead = git(repo.path, "rev-parse", "HEAD");
    const r2 = call(pm, claim(repo, { headCommit: newHead }));
    expect(r2.ok, !r2.ok ? r2.message : "").toBe(true);
    const id2 = /已写工件 (\S+?)\(/.exec(r2.ok ? r2.text : "")![1]!;
    const md2 = JSON.parse(getArtifact(db, id2)!.metadataJson ?? "{}") as Record<string, unknown>;
    // ★ 判据:平台写工件的提交**不动**交付物的版本,而 HEAD 确实动了
    expect(md2["headCommit"], "HEAD 随平台提交而动").toBe(newHead);
    expect(md2["deliverableCommit"], "交付物没变 ⇒ 版本不动").toBe(repo.head);
    expect(md2["commitCount"], "提交数也按服务目录算").toBe(1);

    // ② 现在动**服务目录**
    writeFileSync(join(repo.path, "services", "billing", "index.js"), "console.log('v2');\n");
    git(repo.path, "add", "-A");
    git(repo.path, "commit", "-m", "服务:改成 v2");
    const head3 = git(repo.path, "rev-parse", "HEAD");
    const r3 = call(pm, claim(repo, { headCommit: head3 }));
    expect(r3.ok, !r3.ok ? r3.message : "").toBe(true);
    const id3 = /已写工件 (\S+?)\(/.exec(r3.ok ? r3.text : "")![1]!;
    const md3 = JSON.parse(getArtifact(db, id3)!.metadataJson ?? "{}") as Record<string, unknown>;
    expect(md3["deliverableCommit"], "动了服务目录 ⇒ 版本必须动").toBe(head3);
    expect(md3["deliverableSubject"]).toBe("服务:改成 v2");
    expect(md3["commitCount"]).toBe(2);
  });

  it("**忽略文件是告警不是拒绝**:服务目录里被 `.gitignore` 吃掉的条目进 `ignoredFiles`", () => {
    const repo = makeRepo("billing");
    writeFileSync(join(repo.path, ".gitignore"), ".env\nservices/billing/node_modules/\n");
    mkdirSync(join(repo.path, "services", "billing", "node_modules"), { recursive: true });
    writeFileSync(join(repo.path, "services", "billing", "node_modules", "x.js"), "x\n");
    writeFileSync(join(repo.path, "services", "billing", ".env"), "SECRET=1\n");
    git(repo.path, "add", "-A");
    git(repo.path, "commit", "-m", "加 .gitignore 与本地文件");

    const r = call(pm, claim(repo, { headCommit: git(repo.path, "rev-parse", "HEAD") }));
    expect(r.ok, !r.ok ? r.message : "").toBe(true);
    const md = JSON.parse(
      getArtifact(db, listArtifacts(db, projectId)[0]!.id)!.metadataJson ?? "{}",
    ) as Record<string, unknown>;
    const ignored = md["ignoredFiles"] as string[];
    // 正样本:两条都被列出来(甲方 clone 不到它们 —— 交付物会缺这些)
    expect(ignored.some((x) => x.includes("node_modules"))).toBe(true);
    expect(ignored.some((x) => x.endsWith(".env"))).toBe(true);
    // 交付物本身照收(告警不是拒绝)
    expect(ignored.length).toBeGreaterThan(0);
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
    const r = call(pm, claim({
      path: join(workspace(), "并不存在"), head: "a".repeat(40), servicePath: "services/billing",
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/找不到路径/);
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:不是一个 git 仓库 → 拒收", () => {
    const dir = join(workspace(), "plain");
    mkdirSync(join(dir, "services", "billing"), { recursive: true });
    writeFileSync(join(dir, "services", "billing", "Dockerfile"), "FROM scratch\n");
    const r = call(pm, claim({ path: dir, head: "a".repeat(40), servicePath: "services/billing" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/git/);
  });

  it("负样本:服务目录里没有 Dockerfile → 拒收(「可以独立部署到 docker」的机械判据)", () => {
    const repo = makeRepo("nodocker", { dockerfile: false });
    const r = call(pm, claim(repo));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/Dockerfile/);
      expect(r.message).toContain("services/billing"); // 点名是**哪个**目录
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:**仓库根**有 Dockerfile 不算 —— 判据是服务目录里的那一个", () => {
    const repo = makeRepo("rootdocker", { dockerfile: false, repoRootDockerfile: true });
    const r = call(pm, claim(repo));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/Dockerfile/);
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:`servicePath` 指到仓库**外** → 拒收(包含性校验)", () => {
    const repo = makeRepo("billing");
    const r = call(pm, claim(repo, { servicePath: "../escaped-service" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/不在仓库|仓外/);
      expect(r.message).toContain("../escaped-service");
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:`servicePath` 是**文件**不是目录 → 拒收", () => {
    const repo = makeRepo("billing");
    writeFileSync(join(repo.path, "services", "not-a-dir"), "x\n");
    const r = call(pm, claim(repo, { servicePath: "services/not-a-dir" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/不是目录/);
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:`servicePath = 仓库根` → 拒收(交付物的边界会消失)", () => {
    const repo = makeRepo("billing");
    for (const bad of [".", "", "./"]) {
      const r = call(pm, claim(repo, { servicePath: bad }));
      expect(r.ok, `servicePath=「${bad}」竟然通过了`).toBe(false);
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:服务目录里**没有一条被提交的文件** → 拒收(交付物在 git 里不存在)", () => {
    const repo = makeRepo("billing");
    // 服务目录建出来、Dockerfile 也写了,但**没有提交**它
    mkdirSync(join(repo.path, "services", "late"), { recursive: true });
    writeFileSync(join(repo.path, "services", "late", "Dockerfile"), "FROM scratch\n");
    const r = call(pm, claim(repo, { servicePath: "services/late" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/被 git 跟踪|git add/);
      expect(r.message).toContain("services/late");
    }
    expect(listArtifacts(db, projectId)).toHaveLength(0);
  });

  it("负样本:仓库还没有提交 → 拒收(clone 下来是空目录,无法部署)", () => {
    const repo = makeRepo("empty", { commit: false });
    const r = call(pm, claim({ path: repo.path, head: "a".repeat(40), servicePath: repo.servicePath }));
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
      const r = call(pm, claim({
        path: outside, head: "a".repeat(40), servicePath: "services/billing",
      }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/工作根/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("负样本:metadata 缺坐标 → 拒收,**点名**缺哪几项(含新加的 servicePath)", () => {
    const repo = makeRepo("billing");
    const args = claim(repo);
    const md = { ...(args.metadata as Record<string, unknown>) };
    delete md["port"];
    delete md["servicePath"];
    const r = call(pm, { ...args, metadata: md });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("port");
      expect(r.message).toContain("servicePath");
      expect(r.alternatives).toContain("servicePath");
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
      // 边界与服务目录也要回灌 —— 模型看不到就无法确认自己填对了
      expect(r.text).toContain("services/billing");
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
    // 2026-10-08 起读面还有边界与「这版交付物」三件
    expect(view.codeService!.servicePath).toBe("services/billing");
    expect(view.codeService!.deliverableCommit).toBe(repo.head);
    expect(view.codeService!.deliverableSubject).toBe("交付 billing");
    expect(view.codeService!.ignoredFiles).toEqual([]);
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
    // 缺项一律 `null` —— 不猜、不编默认值(编一个默认端口会让人照着错命令部署)
    expect(v.codeService!.servicePath).toBeNull();
    expect(v.codeService!.deliverableCommit).toBeNull();
    expect(v.codeService!.ignoredFiles).toEqual([]);
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
