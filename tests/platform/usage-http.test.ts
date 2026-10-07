/**
 * T4 · 用量 HTTP 端点(`GET /api/projects/:id/usage` · `GET /api/intake/usage`)
 *
 * ── 这个文件守的三件事 ──────────────────────────────────────────
 *
 *   ① **窗口 / `limit` 的边界是接口契约的一部分**:坏值取默认、`days` 有上界、
 *      `limit` **只截 `byDay`**。这些不能靠「看代码觉得对」—— 一个 `days=0`
 *      被当成「无上界」的实现会让响应随着历史无限长大,而页面看起来一切正常。
 *   ② **项目隔离**:`/projects/p1/usage` 交出来的数字里**不含** p2 的任何一行。
 *      负样本是「合计 ≠ p1+p2」—— 只断言「p1 的数对得上」抓不到串项目那种错
 *      (两边都是合法数字)。
 *   ③ **接待会话那笔账读得到**(`projectId: null` 是一条**真的**上下文,
 *      不是「没有上下文」)—— 它是产品里第一个花钱的回合。
 *
 * 视图层的两个字段(`agentName` / `role`)也在这里核对:它们是
 * `transport/views.ts` 的职责,而**坏数据(agents 表里没有的 agent_id)必须响亮**
 * 而不是静默回一个像名字的 id。
 *
 * ── T4 追加:三条**读不到 ≠ 空**的读面(2026-10-08)──────────────────
 *
 * `GET /api/artifacts/:id/content` / `GET /api/projects/:id/workspace` /
 * `GET /api/artifacts/:id/commits` 换过形状之后,各自的失败态都必须与「空」
 * 分开。它们与用量无关,但共用同一个装配(memory db + `HttpDeps`,没有宿主)——
 * 而这三条恰恰是**只有装配层能测**的部分:端口(workspace / codeService)由测试
 * 注入,三态是路由自己的判据。放在这里,不新开第二个 app 夹具。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertTurnUsage } from "../../src/platform/storage/repo/usage.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import { createGitWorkspace, PLATFORM_AUTHOR } from "../../src/platform/workspace/git.js";
import type { WorkspacePort } from "../../src/platform/workspace/port.js";
import type { CodeServicePort, RepoCommit } from "../../src/platform/codeservice/port.js";
import { projectWorkspaceRoot } from "../../src/platform/workspace/root.js";
import type {
  ArtifactContentView, ArtifactView, ProjectUsageResponse, RepoCommitsView, WorkspaceView,
} from "@shared/types/platform.js";

const P1 = "p-u1";
const P2 = "p-u2";
const NOW = new Date(2026, 4, 20, 15, 30, 0, 0).getTime();
const DAY = 86_400_000;

let db: Database.Database;
let seq = 0;
/** 每个读面用例自己的临时工作根(`projectWorkspaceRoot` 的父目录)。 */
let workRoot = "";
let ws: WorkspacePort;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  for (const [id, name] of [[P1, "项目一"], [P2, "项目二"]] as const) {
    insertProject(db, { id, name, client: "甲", goal: "g", status: "active", createdAt: 1 });
  }
  insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: 1 });
  insertAgent(db, { id: "pm", role: "project_manager", specialization: null, displayName: "项目经理", createdAt: 1 });
  insertAgent(db, { id: "wk", role: "research_worker", specialization: "engineering", displayName: "研究员", createdAt: 1 });
  addMember(db, P1, "pm", 1);
  addMember(db, P1, "wk", 1);
  addMember(db, P2, "wk", 1);
});
afterEach(() => db.close());

/** 本地 `dayOffset` 天前、`hour` 点。 */
function at(dayOffset: number, hour = 12): number {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - dayOffset * DAY + hour * 3_600_000;
}

function put(over: {
  projectId?: string | null;
  agentId?: string;
  createdAt: number;
  input?: number;
  output?: number;
  cacheRead?: number;
}): string {
  seq += 1;
  const id = `tu_${seq}`;
  insertTurnUsage(db, {
    id,
    projectId: over.projectId === undefined ? P1 : over.projectId,
    sessionId: null,
    agentId: over.agentId ?? "wk",
    workId: null,
    model: null,
    inputTokens: over.input ?? 0,
    outputTokens: over.output ?? 0,
    cacheRead: over.cacheRead ?? 0,
    createdAt: over.createdAt,
  });
  return id;
}

function makeDeps(over: Partial<HttpDeps> = {}): HttpDeps {
  return {
    db,
    dataDir: "/tmp/usage-http-test",
    cwd: "/tmp",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/usage-http-test", factoryDir: "/tmp/usage-http-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
    ...over,
  };
}

function app(over: Partial<HttpDeps> = {}): ReturnType<typeof createPlatformApp> {
  return createPlatformApp(makeDeps(over));
}

async function get(
  path: string,
  over: Partial<HttpDeps> = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await app(over).request(path);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null; // Hono 的兜底 500 是纯文本("Internal Server Error"),不是 JSON
  }
  return { status: res.status, body, text };
}
async function usage(path: string): Promise<ProjectUsageResponse["usage"]> {
  const r = await get(path);
  expect(r.status, `${path} 应当是 200`).toBe(200);
  return (r.body as ProjectUsageResponse).usage;
}

// ════════════════════════════════════════════════════════════════

describe("GET /api/projects/:id/usage · 正样本", () => {
  it("合计 / 今日 / 按角色 / 按天 四件事都答得出来", async () => {
    put({ agentId: "wk", createdAt: at(0, 9), input: 100, output: 10, cacheRead: 5 });
    put({ agentId: "pm", createdAt: at(0, 10), input: 200, output: 20, cacheRead: 7 });
    put({ agentId: "wk", createdAt: at(3, 9), input: 7, output: 1, cacheRead: 0 });

    const u = await usage(`/api/projects/${P1}/usage?days=7&limit=7`);
    expect(u.projectId).toBe(P1);
    expect(u.window.days).toBe(7);
    expect(u.totals).toEqual({ input: 307, output: 31, cacheRead: 12, turns: 3 });
    expect(u.allTime).toEqual(u.totals); // 窗口外的账一笔都没有 ⇒ 两者相等
    expect(u.today).toEqual({ input: 300, output: 30, cacheRead: 12, turns: 2 });
    expect(u.byAgent.map((b) => [b.agentId, b.agentName, b.role, b.input])).toEqual([
      ["pm", "项目经理", "project_manager", 200],
      ["wk", "研究员", "research_worker", 107],
    ]);
    expect(u.byDay.map((d) => [d.day, d.input])).toHaveLength(2);
    expect(u.byDayTruncated).toBe(false);
    expect(u.updatedAt).toBe(at(0, 10));
  });

  it("项目一分钱没花 ⇒ 全零 + `updatedAt: null`,**不是** 404", async () => {
    const u = await usage(`/api/projects/${P2}/usage`);
    expect(u.totals).toEqual({ input: 0, output: 0, cacheRead: 0, turns: 0 });
    expect(u.byAgent).toEqual([]);
    expect(u.byDay).toEqual([]);
    expect(u.updatedAt).toBeNull();
  });

  it("项目不存在 ⇒ 404 `not_found`(与「没花过钱」是两件事)", async () => {
    const r = await get(`/api/projects/p_不存在/usage`);
    expect(r.status).toBe(404);
    expect((r.body as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("★ `allTime` **不受窗口影响**:窗口外的账不在 totals 里,但在 allTime 里", async () => {
    put({ agentId: "wk", createdAt: at(0, 9), input: 10 });
    put({ agentId: "wk", createdAt: at(200, 9), input: 999 });
    const u = await usage(`/api/projects/${P1}/usage?days=7`);
    expect(u.totals.input).toBe(10);
    expect(u.allTime.input).toBe(1009);
  });
});

describe("GET /api/projects/:id/usage · 边界(坏值取默认 / 有上界)", () => {
  it("`days` 默认 7、上界 365;`0` / 垃圾值 / 超大值都不许变成「无上界」", async () => {
    expect((await usage(`/api/projects/${P1}/usage`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=abc`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=0`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=-3`)).window.days).toBe(7);
    expect((await usage(`/api/projects/${P1}/usage?days=999999`)).window.days).toBe(365);
    expect((await usage(`/api/projects/${P1}/usage?days=1`)).window.days).toBe(1);
  });

  it("★ `limit` 只截 `byDay`:合计一个数都不变,且 `byDayTruncated` 如实报出", async () => {
    for (let d = 0; d < 5; d++) put({ agentId: "wk", createdAt: at(d, 9), input: d + 1 });
    const full = await usage(`/api/projects/${P1}/usage?days=7&limit=7`);
    const short = await usage(`/api/projects/${P1}/usage?days=7&limit=2`);
    expect(full.byDay).toHaveLength(5);
    expect(short.byDay).toHaveLength(2);
    expect(short.totals).toEqual(full.totals); // ← 截的是展示,不是账
    expect(short.allTime).toEqual(full.allTime);
    expect(short.byAgent).toEqual(full.byAgent);
    expect(short.byDayTruncated).toBe(true);
    expect(full.byDayTruncated).toBe(false);
    // 留下来的必须是**最近**两天(升序交回:昨天=2,今天=1)
    expect(short.byDay.map((d) => d.input)).toEqual([2, 1]);
  });

  it("`limit` 也给默认(缺省 = `days`),垃圾值不会截成 0 天", async () => {
    put({ agentId: "wk", createdAt: at(0, 9), input: 1 });
    for (const q of ["", "?limit=", "?limit=abc", "?limit=0", "?limit=-5"]) {
      const u = await usage(`/api/projects/${P1}/usage${q}`);
      expect(u.byDay, `「${q}」不该把 byDay 截空`).toHaveLength(1);
      expect(u.totals.turns).toBe(1);
    }
  });
});

describe("GET /api/projects/:id/usage · ★ 项目隔离", () => {
  it("p1 的数字里**不含** p2 的任何一行(负样本:合计 ≠ p1+p2)", async () => {
    put({ projectId: P1, agentId: "wk", createdAt: at(0, 9), input: 111, output: 11, cacheRead: 1 });
    put({ projectId: P2, agentId: "wk", createdAt: at(0, 9), input: 222, output: 22, cacheRead: 2 });
    put({ projectId: null, agentId: "bm", createdAt: at(0, 9), input: 444, output: 44, cacheRead: 4 });

    const a = await usage(`/api/projects/${P1}/usage`);
    const b = await usage(`/api/projects/${P2}/usage`);
    expect(a.totals).toEqual({ input: 111, output: 11, cacheRead: 1, turns: 1 });
    expect(b.totals).toEqual({ input: 222, output: 22, cacheRead: 2, turns: 1 });
    // 负样本:串项目(或把接待会话算进来)会让合计变成 777 —— 这里必须不是
    expect(a.totals.input).not.toBe(111 + 222);
    expect(a.totals.input).not.toBe(111 + 222 + 444);
    expect(a.allTime.input).toBe(111);
    expect(a.byAgent.map((x) => x.agentId)).toEqual(["wk"]);
  });
});

describe("GET /api/intake/usage · 接待会话那笔账", () => {
  it("★ `project_id IS NULL` 的那行读得到,`projectId` 为 null(**不是** 404)", async () => {
    put({ projectId: null, agentId: "bm", createdAt: at(0, 9), input: 10063, output: 133, cacheRead: 128 });
    const u = await usage(`/api/intake/usage`);
    expect(u.projectId).toBeNull();
    expect(u.totals).toEqual({ input: 10063, output: 133, cacheRead: 128, turns: 1 });
    expect(u.byAgent[0]).toMatchObject({ agentId: "bm", role: "business_manager" });
  });

  it("没有接待会话时返回全零(与 `/intake/messages` 同一条理由:首屏不该是一次错误)", async () => {
    const u = await usage(`/api/intake/usage`);
    expect(u.projectId).toBeNull();
    expect(u.totals.turns).toBe(0);
    expect(u.updatedAt).toBeNull();
  });

  it("接待会话的账**不会**出现在任何项目下(反向隔离)", async () => {
    put({ projectId: null, agentId: "bm", createdAt: at(0, 9), input: 555 });
    const u = await usage(`/api/projects/${P1}/usage`);
    expect(u.totals.turns).toBe(0);
    expect(u.allTime.turns).toBe(0);
  });
});

describe("用量视图的解析纪律 · 坏数据必须响亮", () => {
  it("★ agents 表里没有的 agent_id ⇒ 500(不静默回一个像名字的 id)", async () => {
    // Hono 会把未捕获的错误写到 console.error —— **把它当现场读**,而不是让它
    // 当噪音:错误文本里必须指出是哪个 agent_id(否则排查只能靠猜)。
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // 外键本该拦住它 —— 这里显式关掉外键,模拟「有人绕过外键写进来的坏数据」
      db.pragma("foreign_keys = OFF");
      put({ agentId: "ag_幽灵", createdAt: at(0, 9), input: 1 });
      db.pragma("foreign_keys = ON");

      const r = await get(`/api/projects/${P1}/usage`);
      expect(r.status, "账上出现了一个不存在的人 —— 这必须响亮,不能静默").toBe(500);
      const logged = spy.mock.calls.map((c) => String(c.join(" "))).join("\n");
      expect(logged).toContain("ag_幽灵");

      // 而**同一个项目**的合法数据单独读也没问题(证明上面红的是那一条坏行,不是接口坏了)
      db.prepare(`DELETE FROM turn_usage WHERE agent_id = ?`).run("ag_幽灵");
      expect((await get(`/api/projects/${P1}/usage`)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

// ════════════════════════════════════════════════════════════════
// T4 · 工件正文读面(`GET /api/artifacts/:id/content`)
//
// 这个端点的全部价值在于**三态分得开**:工件不存在是 404,读不到是
// `runtime: "unavailable"` + `problem`,读到才是 ok。回一个空正文把中间那态
// 吞掉,「平台读不到你的文件」在屏幕上就变成了「这份工件本来就没有正文」。
// ════════════════════════════════════════════════════════════════

/** 一行工件 + 盘上那份文件。`onDisk: false` 造「索引说有、盘上没有」。 */
function seedBody(opts: {
  id?: string;
  projectId?: string;
  bodyPath?: string;
  content?: string;
  indexedSha?: string;
  onDisk?: boolean;
  commitSha?: string | null;
}): { id: string; content: string; bodyPath: string } {
  const id = opts.id ?? "art_c1";
  const projectId = opts.projectId ?? P1;
  const bodyPath = opts.bodyPath ?? "artifacts/art_c1-证据.md";
  const content = opts.content ?? "# 证据\n";
  if (opts.onDisk !== false) {
    const abs = join(projectWorkspaceRoot(workRoot, projectId), bodyPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  insertArtifact(db, {
    id,
    projectId,
    conversationId: null,
    kind: "evidence",
    status: "open",
    authorAgentId: "wk",
    title: "一条证据",
    bodyPath,
    bodySha256: opts.indexedSha ?? ws.sha256(content),
    bodyBytes: Buffer.byteLength(content, "utf8"),
    metadataJson: null,
    createdAt: 1000,
    updatedAt: 1000,
    commitSha: opts.commitSha ?? null,
  });
  return { id, content, bodyPath };
}

describe("GET /api/artifacts/:id/content · 三态(读不到不是空正文)", () => {
  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), "ss-content-"));
    ws = createGitWorkspace();
  });
  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it("读到 ⇒ ok + 正文 + 真实 bytes / sha256;`path` 是落点、`at` 为 null", async () => {
    const seeded = seedBody({});
    const r = await get(`/api/artifacts/${seeded.id}/content`, { cwd: workRoot, workspace: ws });
    expect(r.status).toBe(200);
    const body = r.body as ArtifactContentView;
    expect(body.runtime).toBe("ok");
    expect(body.problem).toBeNull();
    expect(body.content).toBe(seeded.content);
    expect(body.path).toBe(seeded.bodyPath);
    expect(body.at).toBeNull();
    expect(body.bytes).toBe(Buffer.byteLength(seeded.content, "utf8"));
    expect(body.sha256).toBe(ws.sha256(seeded.content));
  });

  it("★ 工件不存在 ⇒ 404;而「文件不在盘上」⇒ **不是 404**(读不到 ≠ 没有)", async () => {
    const missing = await get(`/api/artifacts/art_没有这件/content`, { cwd: workRoot, workspace: ws });
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string } }).error.code).toBe("not_found");

    const seeded = seedBody({ onDisk: false });
    const r = await get(`/api/artifacts/${seeded.id}/content`, { cwd: workRoot, workspace: ws });
    expect(r.status, "工件是存在的 —— 读不到文件不该变成 404").toBe(200);
    const body = r.body as ArtifactContentView;
    expect(body.runtime).toBe("unavailable");
    expect(body.problem, "读不到必须写明原因与下一步").toContain(seeded.bodyPath);
    expect(body.content).toBe("");
    // 负样本:把它渲染成「内容为空」的样子 = 把一次读失败说成「本来就没有正文」。
    // 判据是 runtime,不是那三个空值 —— 所以这里同时断言 runtime 不是 ok。
    expect(body.runtime).not.toBe("ok");
  });

  it("没接工作区端口 ⇒ unavailable + 说明(**不是** 404、不是空正文)", async () => {
    const seeded = seedBody({});
    const r = await get(`/api/artifacts/${seeded.id}/content`, { cwd: workRoot });
    expect(r.status).toBe(200);
    const body = r.body as ArtifactContentView;
    expect(body.runtime).toBe("unavailable");
    expect(body.problem).toContain("工作区端口");
  });

  it("★ 人工改过文件 ⇒ `sha256` 是**盘上那份**的哈希,不是索引里的快照", async () => {
    const seeded = seedBody({ content: "第一版\n" });
    const edited = "人工改过的第二版\n";
    writeFileSync(
      join(projectWorkspaceRoot(workRoot, P1), seeded.bodyPath),
      edited,
      "utf8",
    );
    const r = await get(`/api/artifacts/${seeded.id}/content`, { cwd: workRoot, workspace: ws });
    const body = r.body as ArtifactContentView;
    expect(body.runtime).toBe("ok");
    expect(body.content).toBe(edited);
    expect(body.sha256).toBe(ws.sha256(edited));
    // 负样本:回索引快照会让这次人工修改彻底隐形(§3.4 的下一次提交才会发现)。
    expect(body.sha256).not.toBe(ws.sha256(seeded.content));
    expect(body.bytes).toBe(Buffer.byteLength(edited, "utf8"));
  });

  it("★ `?at=<sha>` 读历史版本:文件被删掉之后那一版仍然读得出来", async () => {
    const root = projectWorkspaceRoot(workRoot, P1);
    const init = ws.initRepo({ root, gitignore: ".env\n", readme: "# 项目\n" });
    expect(init.ok).toBe(true);
    const seeded = seedBody({ content: "被删除的那一版\n" });
    const commit = ws.commit({ root, author: PLATFORM_AUTHOR, message: "引入正文" });
    expect(commit.ok, "提交失败就没有历史版本可测").toBe(true);
    const sha = commit.ok ? commit.value.sha : null;
    expect(sha).not.toBeNull();

    // 把文件删掉:HEAD 读不到,但索引记了 sha ⇒ 那一版仍应按 sha 读得出来
    rmSync(join(root, seeded.bodyPath));
    const head = await get(`/api/artifacts/${seeded.id}/content`, { cwd: workRoot, workspace: ws });
    expect((head.body as ArtifactContentView).runtime).toBe("unavailable");

    const hist = await get(`/api/artifacts/${seeded.id}/content?at=${sha}`, { cwd: workRoot, workspace: ws });
    const hb = hist.body as ArtifactContentView;
    expect(hb.runtime).toBe("ok");
    expect(hb.content).toBe(seeded.content);
    expect(hb.at).toBe(sha);

    // 负样本:不可达的 sha ⇒ unavailable(**不是**空正文、不是 404)
    const bad = await get(`/api/artifacts/${seeded.id}/content?at=${"0".repeat(40)}`, {
      cwd: workRoot,
      workspace: ws,
    });
    expect(bad.status).toBe(200);
    const bb = bad.body as ArtifactContentView;
    expect(bb.runtime).toBe("unavailable");
    expect(bb.problem).toBeTruthy();
    expect(bb.content).toBe("");
  });
});

// ════════════════════════════════════════════════════════════════
// T4 · 工作区对账(`GET /api/projects/:id/workspace`)
//
// `missing` 必须是**逐条 stat** 出来的(`scanWorkspace` 的判据),`index` 只剩
// `{ paths }`(分期兜底 not_migrated 已作废)。这里守两句话:
//   「索引里有、盘上没有」要**逐条带工件身份**;
//   「盘读不到」**不许**吞掉索引那一份事实(库不是空的)。
// ════════════════════════════════════════════════════════════════

describe("GET /api/projects/:id/workspace · 盘与索引两端可见", () => {
  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), "ss-ws-http-"));
    ws = createGitWorkspace();
  });
  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it("索引侧直接查 `body_path`:`index.paths` 是条数,`missing` 逐条带工件身份", async () => {
    const root = projectWorkspaceRoot(workRoot, P1);
    mkdirSync(join(root, "artifacts"), { recursive: true });
    writeFileSync(join(root, "artifacts", "在盘上.md"), "内容", "utf8");
    writeFileSync(join(root, "孤儿.txt"), "盘上有、索引里没有", "utf8");

    seedBody({ id: "art_here", bodyPath: "artifacts/在盘上.md", content: "内容" });
    seedBody({ id: "art_gone", bodyPath: "artifacts/走丢了.md", onDisk: false });

    const r = await get(`/api/projects/${P1}/workspace`, { cwd: workRoot });
    expect(r.status).toBe(200);
    const view = (r.body as { workspace: WorkspaceView }).workspace;
    expect(view.runtime).toBe("ok");
    expect(view.index.paths).toBe(2);
    expect(view.entries.find((e) => e.path === "artifacts/在盘上.md")?.indexed).toBe(true);
    expect(view.entries.find((e) => e.path === "孤儿.txt")?.indexed).toBe(false);
    expect(view.counts.orphanFile).toBeGreaterThanOrEqual(1);
    expect(view.truncated).toBe(false);
    expect(view.missing.map((m) => [m.path, m.artifactId, m.title])).toEqual([
      ["artifacts/走丢了.md", "art_gone", "一条证据"],
    ]);
  });

  it("★ 根不存在 ⇒ unavailable + problem,而**索引那一份照旧报出**(读不到盘 ≠ 库是空的)", async () => {
    seedBody({ id: "art_c1", onDisk: false });
    const r = await get(`/api/projects/${P1}/workspace`, { cwd: workRoot });
    const view = (r.body as { workspace: WorkspaceView }).workspace;
    expect(view.runtime).toBe("unavailable");
    expect(view.problem, "读不到必须写明绝对路径与原因").toBeTruthy();
    expect(view.entries).toEqual([]);
    // `scan.ts`:读不到就不做对账 —— 不许把「读不到」说成「盘上都没有了」
    expect(view.missing).toEqual([]);
    // 但索引事实不受影响:对账的**分母**照旧
    expect(view.index.paths).toBe(1);
  });

  it("项目不存在 ⇒ 404(与「这个项目还没有目录」是两件事)", async () => {
    const r = await get(`/api/projects/p_不存在/workspace`, { cwd: workRoot });
    expect(r.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════
// T4 · 交付物版本读面(`GET /api/artifacts/:id/commits`)
//
// 四个状态分界:**读不到盘**(unavailable)与**提交被抹掉**(unreachable)处置相反,
// 而两者都不许渲染成「没有提交」。第三种「坐标缺项」也必须说出来。
// 核对面是注入的,所以这里不需要真仓库 —— 被测的是路由的判断顺序。
// ════════════════════════════════════════════════════════════════

const CS_REPO = "/tmp/仓";
const CS_META = {
  repoPath: CS_REPO,
  repoName: "仓",
  servicePath: "services/billing",
  branch: "main",
  headCommit: "1".repeat(40),
  headSubject: "交付计费服务",
  deliverableCommit: "2".repeat(40),
  deliverableSubject: "给计费服务加退款接口",
  commitCount: 3,
  dockerfile: "services/billing/Dockerfile",
  service: "billing",
  port: 8080,
  files: ["Dockerfile", "index.js"],
  ignoredFiles: [],
};
const CS_COMMIT: RepoCommit = {
  sha: "1".repeat(40),
  shortSha: "1111111",
  subject: "交付计费服务",
  committedAt: 1_700_000_000_000,
  author: "编码工",
};

/** 一行工件(不碰盘:commits 读的是 `metadata_json`)。 */
function seedRow(
  id: string,
  over: { deliverableType?: "code_service" | null; metadata?: unknown; kind?: "deliverable" | "evidence" } = {},
): void {
  const isCs = over.deliverableType === "code_service";
  insertArtifact(db, {
    id,
    projectId: P1,
    conversationId: null,
    kind: over.kind ?? (isCs ? "deliverable" : "evidence"),
    status: "open",
    authorAgentId: "wk",
    title: `工件 ${id}`,
    bodyPath: `artifacts/${id}.md`,
    bodySha256: "0".repeat(64),
    bodyBytes: 0,
    metadataJson: over.metadata === undefined ? null : JSON.stringify(over.metadata),
    createdAt: 1,
    updatedAt: 1,
    deliverableType: over.deliverableType ?? null,
  });
}

function fakeCs(over: Partial<CodeServicePort> = {}): CodeServicePort {
  return {
    inspect: () => ({ ok: false, reason: "commits 读面不用核对面" }),
    recentCommits: () => [CS_COMMIT],
    isReachable: () => true,
    ...over,
  };
}

describe("GET /api/artifacts/:id/commits · 读不到 / 提交不可达 / ok", () => {
  it("正样本:按 **`servicePath`** 问盘(`recentCommits` 收到的是新签名)", async () => {
    seedRow("art_cs", { deliverableType: "code_service", metadata: CS_META });
    const seen: Array<{ repoPath: string; servicePath: string; limit: number }> = [];
    const r = await get(`/api/artifacts/art_cs/commits?limit=5`, {
      codeService: fakeCs({
        recentCommits: (input) => {
          seen.push(input);
          return [CS_COMMIT];
        },
      }),
    });
    expect(r.status).toBe(200);
    const body = r.body as RepoCommitsView;
    expect(body.runtime).toBe("ok");
    expect(body.commits).toHaveLength(1);
    expect(body.head).toBe(CS_META.headCommit);
    expect(body.branch).toBe("main");
    // 不过滤 servicePath 会把平台写工件的提交混进「这个服务改了什么」
    expect(seen).toEqual([{ repoPath: CS_REPO, servicePath: "services/billing", limit: 5 }]);
  });

  it("★ `deliverableCommit` 不可达 ⇒ `runtime: \"unreachable\"` + problem,`commits` 为 null(**不是空列表**)", async () => {
    seedRow("art_cs", { deliverableType: "code_service", metadata: CS_META });
    const r = await get(`/api/artifacts/art_cs/commits`, {
      codeService: fakeCs({ isReachable: () => false }),
    });
    const body = r.body as RepoCommitsView;
    expect(body.runtime).toBe("unreachable");
    expect(body.commits).toBeNull();
    expect(body.problem).toContain(CS_META.deliverableCommit);
  });

  it("★ 顺序判据:盘**读不到**时即使可达性也回 false,必须报 `unavailable`(不是 unreachable)", async () => {
    seedRow("art_cs", { deliverableType: "code_service", metadata: CS_META });
    const r = await get(`/api/artifacts/art_cs/commits`, {
      codeService: fakeCs({ recentCommits: () => null, isReachable: () => false }),
    });
    const body = r.body as RepoCommitsView;
    // 仓库整个被移走时 isReachable 也回 false —— 两句话里更误导的是「提交被抹掉了」
    expect(body.runtime).toBe("unavailable");
    expect(body.commits).toBeNull();
    expect(body.problem).toBeTruthy();
  });

  it("坐标缺 `servicePath` ⇒ unavailable + 说明(不按整仓读,也不回空列表)", async () => {
    seedRow("art_nopath", {
      deliverableType: "code_service",
      metadata: { ...CS_META, servicePath: undefined },
    });
    const r = await get(`/api/artifacts/art_nopath/commits`, { codeService: fakeCs() });
    const body = r.body as RepoCommitsView;
    expect(body.runtime).toBe("unavailable");
    expect(body.commits).toBeNull();
    expect(body.problem).toContain("servicePath");
  });

  it("没接核对面 ⇒ unavailable(与「没有提交」分开)", async () => {
    seedRow("art_cs", { deliverableType: "code_service", metadata: CS_META });
    const r = await get(`/api/artifacts/art_cs/commits`);
    const body = r.body as RepoCommitsView;
    expect(body.runtime).toBe("unavailable");
    expect(body.commits).toBeNull();
    expect(body.problem).toContain("核对面");
  });

  it("负样本:工件不存在 ⇒ 404;不是 `code_service` ⇒ 400 并说明", async () => {
    const r404 = await get(`/api/artifacts/art_没有/commits`, { codeService: fakeCs() });
    expect(r404.status).toBe(404);
    seedRow("art_ev", { kind: "evidence" });
    const r400 = await get(`/api/artifacts/art_ev/commits`, { codeService: fakeCs() });
    expect(r400.status).toBe(400);
    expect((r400.body as { error: { message: string } }).error.message).toContain("code_service");
  });
});

// ════════════════════════════════════════════════════════════════
// T4 · 工件视图的新形状(`views.ts` 的 `toArtifactView`)
// ════════════════════════════════════════════════════════════════

describe("GET /api/artifacts/:id · 正文落点与六项坐标", () => {
  it("正文只给**落点三列**(`body` 已不存在),坐标缺项是 null、`ignoredFiles` 缺项是 []", async () => {
    seedRow("art_full", { deliverableType: "code_service", metadata: CS_META });
    const full = (await get(`/api/artifacts/art_full`)).body as { artifact: ArtifactView };
    expect(full.artifact.bodyPath).toBe("artifacts/art_full.md");
    expect(full.artifact.bodyBytes).toBe(0);
    expect(full.artifact.commitSha).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(full.artifact, "body")).toBe(false);
    expect(full.artifact.codeService?.servicePath).toBe("services/billing");
    expect(full.artifact.codeService?.deliverableCommit).toBe(CS_META.deliverableCommit);
    expect(full.artifact.codeService?.deliverableSubject).toBe(CS_META.deliverableSubject);
    expect(full.artifact.codeService?.ignoredFiles).toEqual([]);

    // 老行 / 手改的行:六项里缺的给 null(不猜、不编默认值)
    seedRow("art_thin", {
      deliverableType: "code_service",
      metadata: { repoPath: CS_REPO, branch: "main", headCommit: "1".repeat(40), service: "b", port: 80 },
    });
    const thin = (await get(`/api/artifacts/art_thin`)).body as { artifact: ArtifactView };
    expect(thin.artifact.codeService?.servicePath).toBeNull();
    expect(thin.artifact.codeService?.deliverableCommit).toBeNull();
    expect(thin.artifact.codeService?.deliverableSubject).toBeNull();
    expect(thin.artifact.codeService?.ignoredFiles).toEqual([]);
    // 负样本:缺项**不是**「有坐标但全是空字符串」
    expect(thin.artifact.codeService?.servicePath).not.toBe("");
  });

  it("`ignoredFiles` 非空时原样透出(**交付物会缺这些**)—— 空数组与它有区别", async () => {
    seedRow("art_ignored", {
      deliverableType: "code_service",
      metadata: { ...CS_META, ignoredFiles: [".env", "node_modules/"] },
    });
    const r = await get(`/api/artifacts/art_ignored`);
    const art = (r.body as { artifact: ArtifactView }).artifact;
    expect(art.codeService?.ignoredFiles).toEqual([".env", "node_modules/"]);
    // 负样本:非字符串项被丢掉,而不是变成 "undefined"
    seedRow("art_ignored2", {
      deliverableType: "code_service",
      metadata: { ...CS_META, ignoredFiles: [".env", 7, null] },
    });
    const r2 = await get(`/api/artifacts/art_ignored2`);
    expect((r2.body as { artifact: ArtifactView }).artifact.codeService?.ignoredFiles).toEqual([".env"]);
  });
});
