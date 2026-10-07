/**
 * 工作区在**宿主**上的接线(设计 `docs/DESIGN-WORKSPACE.md` §2 / §3.1 / §3.4)
 *
 * ── 这个文件钉住三件事(每一件都能被「改回去」弄红)────────────────
 *
 *   ① **立项就建仓**:`project_open` 之后目录、`.git`、`.gitignore`、`README.md`
 *      真的在盘上,首次提交的 author 是平台;而**接待会话不建仓**(立项之前没有项目)。
 *   ② **派发工作项建 `work/<workId>/`,绝对路径进任务提示词**;回合边界做
 *      housekeeping 提交(author = 角色中文名),并把 `commit_sha` 回填进索引。
 *   ③ **提交失败必须可见**:项目根建不出来时,落一条 `kind='system'` 的平台通知
 *      (项目页「组织运行态」);同一个问题**只播报一次**(每回合重试但不重复刷屏),
 *      而那一回合本身照常完成 —— 工作区坏了不该把组织也弄停。
 *
 * 只碰 `mkdtemp` 出来的临时目录(`dataDir` 与它下面的 `ws/`),真 git 真跑。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WebSocket } from "ws";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type Database from "better-sqlite3";
import { createPlatformHost, type PlatformHost } from "../../src/platform/host/serve.js";
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import { getArtifact, insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { listProviders } from "../../src/platform/infra/providers.js";
import type { ServerEvent } from "../../shared/types/platform.js";

// ── 夹具:一个只记录「拿到什么提示词 / 什么 cwd」的假会话 ──────────

interface Turn {
  readonly projectId: string | null;
  readonly workId: string | null;
  readonly prompt: string;
  readonly cwd: string;
}

interface Harness {
  readonly turns: Turn[];
  /** 非 null 时,接待会话的那一回合真的调一次 `project_open`(走 customTools) */
  openProject: { name: string; client: string; goal: string } | null;
}

const PROJECT_ID_RE = /项目 ID:`([^`]+)`/;
const WORK_ID_RE = /^# 工作项 (\S+)/m;

function makeCreateSession(h: Harness): CreateSessionFn {
  return async (opts) => {
    const listeners = new Set<(ev: AgentSessionEvent) => void>();
    const emit = (ev: AgentSessionEvent): void => {
      for (const l of [...listeners]) l(ev);
    };
    const session = {
      subscribe(fn: (ev: AgentSessionEvent) => void) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      async prompt(payload?: unknown) {
        const text = typeof payload === "string" ? payload : "";
        const projectId = text.match(PROJECT_ID_RE)?.[1] ?? null;
        const workId = text.match(WORK_ID_RE)?.[1] ?? null;
        h.turns.push({ projectId, workId, prompt: text, cwd: opts.cwd ?? "" });
        // 接待会话里真的调一次 `project_open` —— 必须把工具事件也发出来:
        // `runTurn` 的 `openedProjectIds` 读的是 `tool_execution_end` 的现场,
        // 不是 `execute()` 的返回值(d1-d4 的夹具注释里记过这个坑)。
        if (h.openProject !== null && projectId === null) {
          const open = (opts.customTools ?? []).find((t) => t.name === "project_open");
          if (open !== undefined) {
            emit({
              type: "tool_execution_start", toolCallId: "tc_open",
              toolName: "project_open", args: {},
            } as unknown as AgentSessionEvent);
            const result = await open.execute("tc_open", { ...h.openProject });
            emit({
              type: "tool_execution_end", toolCallId: "tc_open", toolName: "project_open",
              result, isError: false,
            } as unknown as AgentSessionEvent);
          }
        }
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      async abort() {
        emit({ type: "agent_settled" } as AgentSessionEvent);
      },
      dispose() {
        /* 无需清理 */
      },
    } as unknown as AgentSession;
    return { session };
  };
}

/** 一条**不连网络的**假 WS 客户端 —— 只需要 `on` / `send` 两个方法。 */
function attachFakeClient(hub: PlatformHost["hub"]): {
  send: (cmd: unknown) => void;
  events: ServerEvent[];
} {
  const handlers = new Map<string, (arg: unknown) => void>();
  const events: ServerEvent[] = [];
  const ws = {
    on: (ev: string, fn: (arg: unknown) => void) => {
      handlers.set(ev, fn);
    },
    send: (s: string) => {
      events.push(JSON.parse(s) as ServerEvent);
    },
  } as unknown as WebSocket;
  hub.addClient(ws);
  return {
    send: (cmd) => handlers.get("message")?.(JSON.stringify(cmd)),
    events,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(10);
  }
  return cond();
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

let dataDir = "";
let workRoot = "";
let host: PlatformHost | undefined;
let h: Harness;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  dataDir = mkdtempSync(join(tmpdir(), "ss-ws-host-"));
  workRoot = join(dataDir, "ws");
  mkdirSync(workRoot, { recursive: true });
  // 宿主必须解析得出一个模型才能建会话(`getOrCreateSession` 的 `currentModel`)。
  const p = listProviders()[0];
  const model = p?.models[0];
  if (p === undefined || model === undefined) {
    throw new Error("内建 provider catalog 是空的 —— 夹具造不出「已配置 provider」的现场");
  }
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({
      providers: [{
        id: "prov_test", label: "test", provider: p.id, modelId: model.id,
        apiKey: "test-key-not-used", thinkingLevel: "off",
      }],
      activeProviderId: "prov_test",
      cwd: workRoot,
      personaName: "测试",
    }),
    { mode: 0o600 },
  );
  h = { turns: [], openProject: null };
});

afterEach(() => {
  host?.close();
  host = undefined;
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function startHost(): Promise<PlatformHost> {
  host = createPlatformHost({
    dataDir,
    host: "127.0.0.1",
    port: 0,
    version: "test",
    cwd: workRoot,
    // 兜底定时器挪到一小时之后:这些断言只依赖**显式动作**(发消息 / 手动排空)。
    dispatchIntervalMs: 3_600_000,
    maxCascadeRounds: 1,
    createSession: makeCreateSession(h),
  });
  return host;
}

/** 一个能马上开工的项目:默认组织 + 一条派给研究工(`wk`)的工作项。 */
function seedProject(db: Database.Database, projectId: string, workId: string | null): void {
  ensureOrg(db, 1);
  insertProject(db, {
    id: projectId, name: projectId, client: "甲方", goal: "g", status: "active", createdAt: 1,
  });
  ensureProjectOrg(db, projectId, 1);
  if (workId !== null) {
    insertWork(db, {
      id: workId, projectId, parentWorkId: null, title: workId, goal: "把活干完",
      status: "open", assigneeAgentId: "wk", createdAt: 1, updatedAt: 1,
    });
  }
}

/**
 * 直接 `insertProject` 的项目**没有经过 `project_open`**,所以没有仓。
 *
 * 这一组里凡是要断言「角色 author 的提交」的用例,都先显式把仓建出来 ——
 * 那正是 `project_open` 会做的事(测试 ① 覆盖了那条真路径),而在这里手动建
 * 只是为了让夹具**确定**:否则 `ensureProjectRepo` 会在回合边界懒建仓,把
 * 已经躺在项目根里的工件一起收进平台那次首次提交里,author 就变成平台了。
 */
function initRepoFor(projectRoot: string): void {
  const r = createGitWorkspace().initRepo({
    root: projectRoot,
    gitignore: ".env\nsecrets/\n",
    readme: "# 夹具项目\n",
  });
  if (!r.ok) throw new Error(`夹具建仓失败:${r.problem}`);
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ── ① 立项就建仓 ────────────────────────────────────────────────

describe("① project_open ⇒ 目录 + 仓 + 首次提交", () => {
  it("业务经理立项之后,项目根、.git、.gitignore、README 真的在盘上(author = 平台)", async () => {
    const started = await startHost();
    const db = started.booted.deps.db;
    const client = attachFakeClient(started.hub);
    h.openProject = { name: "量化系统", client: "甲方", goal: "把回测跑起来" };

    client.send({ type: "send", projectId: null, content: "我想做一个量化系统" });

    expect(await until(() => h.turns.length >= 1)).toBe(true);
    const row = await until(() =>
      (db.prepare(`SELECT id FROM projects LIMIT 1`).get() as { id: string } | undefined) !== undefined);
    expect(row, "立项必须真的落库(否则下面的断言是空谈)").toBe(true);
    const pid = (db.prepare(`SELECT id FROM projects LIMIT 1`).get() as { id: string }).id;
    const root = join(resolve(workRoot), "projects", pid);

    expect(await until(() => existsSync(join(root, ".git")))).toBe(true);
    expect(statSync(root).isDirectory()).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("secrets/");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".platform-tmp/");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("# 量化系统"); // 项目名
    expect(readme).toContain("把回测跑起来"); // 目标
    expect(git(root, "log", "-1", "--format=%an <%ae>")).toBe("三生平台 <platform@sansheng.local>");
    expect(git(root, "log", "-1", "--format=%s")).toContain("初始化项目工作区");
    expect(git(root, "ls-files").split("\n").sort()).toEqual([".gitignore", "README.md"]);
    // 立项在**广播之前**就建好了仓:前端收到 `project_opened` 立刻拉工作区时,
    // 目录已经存在(否则读面会如实回 `unavailable`,而用户看到的是「没有工作区」)。
    expect(client.events.some((e) => e.type === "project_opened")).toBe(true);
  });
});

// ── ② 工作项:work/<id>/ + 提示词 + 回合边界提交 + 回填 ──────────

describe("② 派发工作项 ⇒ 工作目录 + 任务提示词 + 回合边界提交", () => {
  it("work/<workId>/ 建出来、绝对路径进提示词;回合边界提交并回填 commit_sha", async () => {
    const started = await startHost();
    const db = started.booted.deps.db;
    attachFakeClient(started.hub);
    seedProject(db, "pA", "wkA");
    const projectRoot = join(resolve(workRoot), "projects", "pA");

    // 一条已经落了索引的工件 —— 用来钉住「提交 + 回填 commit_sha」这条线。
    const body = "# 调研结论\n\n回测可行。\n";
    mkdirSync(join(projectRoot, "artifacts"), { recursive: true });
    initRepoFor(projectRoot); // 仓先建好(等价于已经过 project_open):见 initRepoFor 的注释
    writeFileSync(join(projectRoot, "artifacts", "art_x.md"), body, "utf8");
    insertArtifact(db, {
      id: "art_x", projectId: "pA", conversationId: null, kind: "evidence",
      status: "open", authorAgentId: "wk", title: "调研结论",
      bodyPath: "artifacts/art_x.md", bodySha256: sha256(body),
      bodyBytes: Buffer.byteLength(body, "utf8"),
      metadataJson: null, createdAt: 1, updatedAt: 1,
    });

    await started.dispatchTimer.runNow();

    // 任务提示词里必须有**绝对路径**(设计 §2:这条通道此前是空的)
    expect(h.turns.length).toBeGreaterThanOrEqual(1);
    const workTurn = h.turns.find((t) => t.workId === "wkA");
    expect(workTurn, "这条工作项必须真的被派出去").toBeDefined();
    const workDir = join(projectRoot, "work", "wkA");
    expect(workTurn?.prompt).toContain(workDir);
    expect(workTurn?.prompt).toContain("不要自己编目录名");
    expect(workTurn?.cwd).toBe(projectRoot); // 会话 cwd = 项目根(无条件按项目)
    expect(statSync(workDir).isDirectory()).toBe(true);

    // 回合边界提交:author = 角色中文名(`wk` → 研究员),工件正文进了版本库
    const head = git(projectRoot, "rev-parse", "HEAD");
    expect(git(projectRoot, "log", "-1", "--format=%an")).toBe("研究员");
    expect(git(projectRoot, "show", "--name-only", "--format=", "HEAD").split("\n"))
      .toContain("artifacts/art_x.md");
    // 索引回填:commit_sha 指向那一次提交(设计 §3.4 第 4 步)
    expect(getArtifact(db, "art_x")?.commitSha).toBe(head);
    // 提交之后工作树是干净的(否则「提交了」与「没提交」就是同一个样子)
    expect(git(projectRoot, "status", "--porcelain")).toBe("");
  });

  it("索引与盘不一致时**按盘上的事实收敛**,并把新提交记进 commit_sha", async () => {
    const started = await startHost();
    const db = started.booted.deps.db;
    attachFakeClient(started.hub);
    seedProject(db, "pA", "wkA");
    const projectRoot = join(resolve(workRoot), "projects", "pA");
    mkdirSync(join(projectRoot, "artifacts"), { recursive: true });
    initRepoFor(projectRoot); // 仓先建好:让「收敛 + 提交 + 回填」这条线是这一回合的事
    // 盘上的内容与索引记的**不一致**(模拟人手工改过 / 上一次写盘没落库)
    const onDisk = "# 人工改过的正文\n";
    writeFileSync(join(projectRoot, "artifacts", "art_y.md"), onDisk, "utf8");
    insertArtifact(db, {
      id: "art_y", projectId: "pA", conversationId: null, kind: "evidence",
      status: "open", authorAgentId: "wk", title: "旧正文",
      bodyPath: "artifacts/art_y.md", bodySha256: sha256("# 旧正文\n"),
      bodyBytes: Buffer.byteLength("# 旧正文\n", "utf8"),
      metadataJson: null, createdAt: 1, updatedAt: 1,
    });

    await started.dispatchTimer.runNow();

    const row = getArtifact(db, "art_y");
    expect(row?.bodySha256).toBe(sha256(onDisk)); // 索引收敛到事实
    expect(row?.bodyBytes).toBe(Buffer.byteLength(onDisk, "utf8"));
    expect(row?.commitSha).toBe(git(projectRoot, "rev-parse", "HEAD"));
  });
});

// ── ③ 提交失败必须可见,而且不重复播报 ───────────────────────────

describe("③ 工作区坏掉 ⇒ 可见的失败(不是静默)", () => {
  it("仓腐坏(有 .git 目录但不是仓库)⇒ 一条 system 平台通知;同一条只播一次,回合照常完成", async () => {
    const started = await startHost();
    const db = started.booted.deps.db;
    const client = attachFakeClient(started.hub);
    seedProject(db, "pA", null);
    const projectRoot = join(resolve(workRoot), "projects", "pA");
    // 把 `.git` 做成一个**空目录**:`ensureProjectRepo` 看到它就不再建仓,而
    // `git rev-parse --show-toplevel` 在这个根上会失败 ⇒ 提交失败。
    // 这一类(路径腐坏 / 仓坏掉 / 权限)是提交失败的现实形态,而且**会话照常建得出来**
    // —— 于是它必须由 housekeeping 那条路自己报出来,不能指望别处。
    mkdirSync(join(projectRoot, ".git"), { recursive: true });

    /** 只取**工作区**那几条通知:`maxCascadeRounds: 1` 也会正常产生「组织停止推进」。 */
    const notices = (): string[] =>
      (db.prepare(`SELECT content FROM session_messages WHERE kind = 'system'`).all() as
        Array<{ content: string }>)
        .map((r) => r.content)
        .filter((c) => c.startsWith("⚠️ 工作区"));

    client.send({ type: "send", projectId: "pA", content: "在吗" });
    expect(await until(() => h.turns.some((t) => t.prompt.includes("在吗")))).toBe(true);
    expect(await until(() => notices().length === 1)).toBe(true);

    const msg = notices()[0]!;
    // 项目页「组织运行态」按正文首行前缀分类;`⚠️ 工作区` 不在两类白名单里时
    // 归「平台通知」一档,**正文原样显示**(所以这条消息不会因为前端没加表而消失)。
    expect(msg.startsWith("⚠️ 工作区提交失败")).toBe(true);
    expect(msg).toContain(projectRoot); // 绝对路径:用户能照着去盘上核对
    expect(msg).toContain("没有进版本库");

    // 第二条消息:问题一模一样 ⇒ **不再播报**(每回合一条会把「组织运行态」淹掉)
    client.send({ type: "send", projectId: "pA", content: "还在吗" });
    expect(await until(() => h.turns.some((t) => t.prompt.includes("还在吗")))).toBe(true);
    await sleep(50); // 别抢在同步的 housekeeping 之前
    expect(notices()).toHaveLength(1);
  });

  it("负样本:工作区**正常**时,一条工作区通知都不该有", async () => {
    const started = await startHost();
    const db = started.booted.deps.db;
    const client = attachFakeClient(started.hub);
    seedProject(db, "pA", null);

    client.send({ type: "send", projectId: "pA", content: "在吗" });
    expect(await until(() => h.turns.some((t) => t.prompt.includes("在吗")))).toBe(true);
    await sleep(50);
    // ⚠️ 只筛**工作区**通知:这条链路上还有别的合法生产者(`announceDrain` 在
    // `maxCascadeRounds: 1` 下会正常报「组织停止推进」),把它们算进来是假红。
    const workspaceNotices = (db.prepare(`SELECT content FROM session_messages WHERE kind = 'system'`)
      .all() as Array<{ content: string }>)
      .map((r) => r.content)
      .filter((c) => c.startsWith("⚠️ 工作区"));
    expect(workspaceNotices).toEqual([]);
    expect(existsSync(join(resolve(workRoot), "projects", "pA", ".git"))).toBe(true);
  });
});

// ── ④ `POST /api/projects` 也要建工作区(真机死项目的回归)──────────

describe("④ 经 HTTP 立项 ⇒ 同样建工作区", () => {
  it("POST /api/projects 之后:目录 + .git + 两个文件 + 首次提交,workspace 路由是 ok", async () => {
    const started = await startHost();

    // ⚠️ 这条用例的由来(T7 真机冒烟):建仓此前只挂在 `project_open` **工具**那条路
    // 上,于是经这个 API 建出来的项目没有目录也没有仓 —— `GET …/workspace` 一直回
    // `runtime: "unavailable"`(ENOENT),而屏幕上看起来只是「这个项目还没有文件」。
    // 它只有真机跑才看得出来,所以必须在这里钉一条回归。
    const res = await started.app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "HTTP 立项", client: "甲方", goal: "工作区要建出来" }),
    });
    expect(res.status).toBe(201); // 立项成功 = 201(实测;写 200 会当场红)
    const body = (await res.json()) as {
      project: { id: string };
      workspaceBootstrapped?: boolean;
    };
    const pid = body.project.id;
    const root = join(resolve(workRoot), "projects", pid);

    // 响应里就有「建没建成」这个事实(不许把「调了个 void 函数」当成「建好了」)
    expect(body.workspaceBootstrapped).toBe(true);
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain("secrets/");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("# HTTP 立项");
    expect(readme).toContain("工作区要建出来");
    expect(git(root, "log", "-1", "--format=%an <%ae>")).toBe("三生平台 <platform@sansheng.local>");
    expect(git(root, "log", "-1", "--format=%s")).toContain("初始化项目工作区");
    expect(git(root, "ls-files").split("\n").sort()).toEqual([".gitignore", "README.md"]);

    // ⭐ 判据:读面从 `unavailable` 变成 `ok`(真机现场就是它一直 unavailable)
    const ws = await started.app.request(`/api/projects/${pid}/workspace`);
    const view = (await ws.json()) as { workspace: { runtime: string; root: string; problem: string | null } };
    expect(view.workspace.runtime).toBe("ok");
    expect(view.workspace.problem).toBeNull();
    expect(view.workspace.root).toBe(root);
  });
});
