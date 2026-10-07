/**
 * 代码服务交付物的**现读**边 · `GET /api/artifacts/:id/commits`(migration 026)
 *
 * ── 它盯的是「三种状态不许混成两种」───────────────────────────────
 *
 * 这个端点的响应有三种截然不同的情形,而它们在屏幕上**长得一样**:
 *
 *   · `runtime: "ok"` + 一串提交   → 正常;
 *   · `runtime: "ok"` + 空数组     → 「这个仓库一个提交都没有」
 *     (写入时校验过 HEAD 存在,所以这条在真机上不可达 —— 但它是一个**不同的**答案);
 *   · `runtime: "unavailable"`     → **读不到**(仓库被移走 / 没接端口 / git 不可用)。
 *
 * 把第三种渲染成第二种 = 「把一次读失败说成这个仓库是空的」。这与
 * `ProjectLiveView.runtime` 是同一条纪律(读不到不是空闲),所以这里逐条钉住。
 *
 * ⚠️ 另外两条判据:
 *   ① 工件**不是** `code_service` 时返回 400 并说明 —— 不是回一个空列表
 *      (空列表会被读成「这个工件没有提交」,而它根本不是一个仓库);
 *   ② 提交是**现读**的:同一条工件,仓库里多提交一次,下一次请求就看得到。
 *      这一条才证明它不是交付时存下的快照(快照看起来与新鲜的一模一样)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import { createGitCodeService } from "../../src/platform/codeservice/git.js";
import type { RepoCommitsView } from "@shared/types/platform.js";

const P1 = "p-cs";
const NOW = 1_700_000_000_000;

let db: Database.Database;
let root: string;
let seq = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=tester", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  ).trim();
}

/** 在临时工作根里建一个真仓库,提交 `n` 次。 */
function makeRepo(name: string, n: number): { path: string; head: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
  git(dir, "init", "-b", "main");
  let head = "";
  for (let i = 1; i <= n; i += 1) {
    writeFileSync(join(dir, `f${i}.txt`), `${i}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-m", `第 ${i} 次提交`);
    head = git(dir, "rev-parse", "HEAD");
  }
  return { path: dir, head };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sansheng-cs-http-"));
  db = openPlatformMemoryDb();
  seq = 0;
  insertProject(db, { id: P1, name: "代码服务", client: "甲", goal: "g", status: "active", createdAt: 1 });
  insertAgent(db, { id: "cw", role: "coding_worker", specialization: "engineering", displayName: "工程师", createdAt: 1 });
  addMember(db, P1, "cw", 1);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function writeDeliverable(opts: {
  repoPath: string | null;
  head?: string | null;
  branch?: string | null;
  type?: string | null;
}): string {
  seq += 1;
  const id = `art_cs_${seq}`;
  const md =
    opts.type === null
      ? null
      : JSON.stringify({
          repoPath: opts.repoPath,
          branch: opts.branch ?? "main",
          headCommit: opts.head ?? null,
          service: "svc",
          port: 8080,
        });
  insertArtifact(db, {
    id,
    projectId: P1,
    conversationId: null,
    kind: "deliverable",
    status: "open",
    authorAgentId: "cw",
    title: "代码服务",
    body: "## 怎么跑",
    metadataJson: md,
    createdAt: NOW,
    updatedAt: NOW,
    // 三元表达式的类型就是 `DeliverableType`,不需要断言(项目纪律:收窄写 guard,不糊断言)
    deliverableType: opts.type === null ? "html_report" : "code_service",
  });
  return id;
}

function app(withPort = true, workspaceRoot = root): ReturnType<typeof createPlatformApp> {
  const deps: HttpDeps = {
    db,
    dataDir: "/tmp/code-service-http-test",
    cwd: workspaceRoot,
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    ...(withPort ? { codeService: createGitCodeService({ workspaceRoot }) } : {}),
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/code-service-http-test", factoryDir: "/tmp/code-service-http-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
  };
  return createPlatformApp(deps);
}

async function get(path: string, withPort = true): Promise<{ status: number; body: RepoCommitsView | unknown }> {
  const res = await app(withPort).request(path);
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text) as unknown; } catch { body = null; }
  return { status: res.status, body };
}

describe("代码服务 · 提交读面(现读,不是快照)", () => {
  it("正样本:列出最近提交,最新的在前", async () => {
    const repo = makeRepo("billing", 3);
    const id = writeDeliverable({ repoPath: repo.path, head: repo.head });
    const r = await get(`/api/artifacts/${id}/commits`);
    expect(r.status).toBe(200);
    const v = r.body as RepoCommitsView;
    expect(v.runtime).toBe("ok");
    expect(v.commits).toHaveLength(3);
    expect(v.commits![0]!.subject).toBe("第 3 次提交");
    expect(v.commits![2]!.subject).toBe("第 1 次提交");
    // 交付物记下的 HEAD(那一刻的事实)与分支
    expect(v.head).toBe(repo.head);
    expect(v.branch).toBe("main");
    // 短 sha 是 7 位,且是全 sha 的前缀
    expect(v.commits![0]!.shortSha).toHaveLength(7);
    expect(v.commits![0]!.sha.startsWith(v.commits![0]!.shortSha)).toBe(true);
  });

  it("**现读**:仓库里再提交一次,下一次请求就看得到(所以它不是快照)", async () => {
    const repo = makeRepo("billing", 1);
    const id = writeDeliverable({ repoPath: repo.path, head: repo.head });
    const first = (await get(`/api/artifacts/${id}/commits`)).body as RepoCommitsView;
    expect(first.commits).toHaveLength(1);

    writeFileSync(join(repo.path, "f2.txt"), "2\n");
    git(repo.path, "add", "-A");
    git(repo.path, "commit", "-m", "交付之后又改了一次");

    const second = (await get(`/api/artifacts/${id}/commits`)).body as RepoCommitsView;
    expect(second.commits, "还是 1 条 = 它读的是快照,不是盘上的仓库").toHaveLength(2);
    // 而 `head` 仍然是**交付时**记下的那一个(两件事,不许混)
    expect(second.head).toBe(repo.head);
    expect(second.head).not.toBe(git(repo.path, "rev-parse", "HEAD"));
  });

  it("`limit` 有上界(100),坏值取默认 20", async () => {
    const repo = makeRepo("many", 25);
    const id = writeDeliverable({ repoPath: repo.path, head: repo.head });
    const dflt = (await get(`/api/artifacts/${id}/commits`)).body as RepoCommitsView;
    expect(dflt.commits).toHaveLength(20);
    const small = (await get(`/api/artifacts/${id}/commits?limit=3`)).body as RepoCommitsView;
    expect(small.commits).toHaveLength(3);
    // 坏值(0 / 负数 / 非数字)取默认,不是「无上界」(与 usage 的 days 同一条规矩)
    for (const bad of ["0", "-5", "abc"]) {
      const r = (await get(`/api/artifacts/${id}/commits?limit=${bad}`)).body as RepoCommitsView;
      expect(r.commits, `limit=${bad} 不该变成无上界`).toHaveLength(20);
    }
  });

  it("**读不到**与「没有提交」必须分开:`runtime: unavailable` + problem", async () => {
    // ① 仓库被移走
    const repo = makeRepo("gone", 2);
    const id = writeDeliverable({ repoPath: repo.path, head: repo.head });
    rmSync(repo.path, { recursive: true, force: true });
    const gone = (await get(`/api/artifacts/${id}/commits`)).body as RepoCommitsView;
    expect(gone.runtime).toBe("unavailable");
    expect(gone.commits, "读不到**不许**渲染成空列表").toBeNull();
    expect(gone.problem).toBeTruthy();

    // ② 没接核对面(HTTP 侧拿不到磁盘)
    const repo2 = makeRepo("noport", 1);
    const id2 = writeDeliverable({ repoPath: repo2.path, head: repo2.head });
    const noPort = (await get(`/api/artifacts/${id2}/commits`, false)).body as RepoCommitsView;
    expect(noPort.runtime).toBe("unavailable");
    expect(noPort.commits).toBeNull();
    expect(noPort.problem).toMatch(/核对面/);

    // ③ 坐标里没有 repoPath
    const id3 = writeDeliverable({ repoPath: null });
    const noPath = (await get(`/api/artifacts/${id3}/commits`)).body as RepoCommitsView;
    expect(noPath.runtime).toBe("unavailable");
    expect(noPath.problem).toMatch(/repoPath/);
  });

  it("负样本:工件不存在 → 404;不是代码服务 → 400 并说明", async () => {
    const miss = await get("/api/artifacts/不存在/commits");
    expect(miss.status).toBe(404);

    const html = writeDeliverable({ repoPath: null, type: null });
    const wrong = await get(`/api/artifacts/${html}/commits`);
    expect(wrong.status, "不是代码服务时回 200 + 空列表 = 把「这不是仓库」说成「没有提交」").toBe(400);
  });
});
