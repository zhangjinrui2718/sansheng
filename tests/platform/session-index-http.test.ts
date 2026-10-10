/**
 * `GET /api/sessions` —— 左栏二级目录的唯一数据源。
 *
 * ── 它守的不是「能返回 200」,是四条会让界面说错话的判据 ──────────
 *
 *   ① **不含接待会话**。`listSessions(db, null)` 返回的正是接待那条
 *     (`project_id IS NULL`),而左栏里接待有**自己的一行**(「接待 · 谈新项目」)。
 *     混进索引 ⇒ 它在界面上出现**两次**,而两次点进去是不同的对话。
 *     负样本钉住这一点:接待会话**确实存在于库里**,不是"恰好没建"才过的。
 *     ⚠️ 变异自检的结论:这道守卫是**两层**(`repo/sessions.ts` 的
 *     `listAllSessions` SQL 过滤 + `transport/http.ts` 端点里的
 *     `if (s.projectId === null) continue;`)。**只拆 SQL 那层,本测试仍全绿**
 *     —— 被端点的第二层遮住了。所以这里守的是**可观测契约**,不是某一行;
 *     两层都要拆才会红(已实测)。
 *
 *   ② **纯读面,不 `ensureSession`**。`GET /api/projects/:id/sessions` 会
 *     `ensureSession`(那是它的语义:前端靠它保证"至少有一条可看的线")。
 *     本端点**不能**那样 —— 一个刚立项、还没说过一句话的项目,左栏里就该显示
 *     0 条线;被读一次就凭空多出一条主对话,等于「一次读操作改写了事实」。
 *
 *   ③ **组内次序在服务端定**:主对话在前,其余按最近活跃度。前端不重排 ——
 *     两处读面对同一条线给出不同位置,用户看着像"列表自己动了"。
 *
 *   ④ **与单项目端点共用同一份行→摘要映射**(实测等价,不是各写一遍)。
 *     `title` 的兜底(交付会话 → 它交付的那份工件标题)必须两边一致;写成两处,
 *     它们会在工件改名 / 少写一个字段时当场漂开,而左栏与对话页显示不同的
 *     线程名,看着像"有两个同名的东西"。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
// ⚠️ `artifacts.author_agent_id` 是 NOT NULL 且外键指向 `agents(id)` —— 交付物必须有作者。
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { appendSessionMessage, insertSession } from "../../src/platform/storage/repo/sessions.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { SessionIndexEntry } from "@shared/types/platform.js";

const P1 = "p-index-1";
const P2 = "p-index-2";
const NOW = 1_760_000_000_000;

let db: Database.Database;
let workRoot = "";
let seq = 0;
let bm = "";

/** 027 起正文住文件:索引里的三列必须与盘上那份一致,测试里就真写一份。 */
function writeArtifactBody(id: string, body: string): { path: string; sha: string; bytes: number } {
  const path = join(workRoot, "artifacts", `${id}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return { path, sha: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) };
}

function makeDeps(): HttpDeps {
  return {
    db,
    dataDir: "/tmp/session-index-http-test",
    cwd: workRoot,
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => NOW,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    workspace: createGitWorkspace(),
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/session-index-http-test", factoryDir: "/tmp/session-index-http-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
  };
}

const app = (): ReturnType<typeof createPlatformApp> => createPlatformApp(makeDeps());

async function index(): Promise<SessionIndexEntry[]> {
  const res = await app().request("/api/sessions");
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: SessionIndexEntry[] }).sessions;
}

async function ofProject(projectId: string): Promise<SessionIndexEntry[]> {
  const res = await app().request(`/api/projects/${projectId}/sessions`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: SessionIndexEntry[] }).sessions;
}

/** 一条用户消息(封套合法:`origin_source='turn'` ⟺ `trigger_kind` 有值)。 */
function say(sessionId: string, at: number): void {
  appendSessionMessage(db, {
    id: `m_${sessionId}_${at}`,
    sessionId,
    agentId: null,
    kind: "user",
    content: "你好",
    createdAt: at,
    originSource: "turn",
    triggerKind: "user",
  });
}

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  workRoot = mkdtempSync(join(tmpdir(), "session-index-"));
  insertProject(db, {
    id: P1, name: "项目一", client: "甲方",
    goal: "把左栏做成两级", status: "active", createdAt: NOW,
  });
  insertProject(db, {
    id: P2, name: "项目二", client: "甲方",
    goal: "另一件事", status: "active", createdAt: NOW,
  });
  // ⚠️ 两个播种函数返回的都是**显示串**(`"bm(入项目)"`),不是 id。拿它们当外键值会得到
// 一条 FOREIGN KEY 失败,而报错与真因隔着三层(它看起来像「工件表的约束写错了」)。
// 所以作者 id 从 `project_assignments` 里取 —— 不硬编码角色名(AGENTS.md:角色只有一处真相),
// 走的也是平台自己的播种路径。
  ensureOrg(db, NOW);
  ensureProjectOrg(db, P1, NOW);
  const row = db
    .prepare(`SELECT agent_id FROM project_assignments WHERE project_id = ? ORDER BY agent_id`)
    .get(P1) as { agent_id: string } | undefined;
  bm = row?.agent_id ?? "";
});
afterEach(() => db.close());

describe("① 索引覆盖每个项目的线,并带归属", () => {
  it("两个项目的线都在,且每条都带自己的 `projectId`", async () => {
    insertSession(db, { id: "s1_main", projectId: P1, createdAt: NOW });
    insertSession(db, { id: "s1_thread", projectId: P1, createdAt: NOW + 1, kind: "thread", title: "另一面" });
    insertSession(db, { id: "s2_main", projectId: P2, createdAt: NOW });

    const all = await index();
    expect(all.map((s) => s.id).sort()).toEqual(["s1_main", "s1_thread", "s2_main"]);
    for (const s of all) {
      // ⚠️ `projectId` 恒非空 —— 前端就是靠它分组的;空值会让那条线**无处可归**,
      // 表现为「线列出来了但点不动」。
      expect(s.projectId, `${s.id} 必须带归属项目`).not.toBeNull();
      expect(s.projectId.length).toBeGreaterThan(0);
    }
    // 正样本:确实按归属分成了两组(不是碰巧只有一个项目有条线)
    expect(new Set(all.map((s) => s.projectId))).toEqual(new Set([P1, P2]));
  });

  it("**不含接待会话**,而它确实存在于库里", async () => {
    // 负样本钉住 ①:先证明接待会话真的建出来了 —— 否则「没返回它」可能只是
    // 因为「它压根不在库里」,那这条断言就是**假通过**。
    insertSession(db, { id: "s_intake", projectId: null, createdAt: NOW });
    insertSession(db, { id: "s1_main", projectId: P1, createdAt: NOW });
    const rows = db
      .prepare(`SELECT COUNT(*) c FROM project_sessions WHERE project_id IS NULL`)
      .get() as { c: number };
    expect(rows.c, "负样本:接待会话必须真的在库里").toBe(1);

    const all = await index();
    expect(all.map((s) => s.id)).not.toContain("s_intake");
    expect(all.map((s) => s.id)).toContain("s1_main");
  });
});

describe("② 纯读面:读一个没有会话的项目不会凭空造出主对话", () => {
  it("从没有会话的项目读一次,仍然是 0 条(对照:单项目端点会建一条)", async () => {
    insertSession(db, { id: "s1_main", projectId: P1, createdAt: NOW });
    // P2 一条会话都没有 —— 刚立项、还没说过话,这就是它的真实状态。

    expect((await index()).filter((s) => s.projectId === P2)).toHaveLength(0);

    // ⚠️ 对照组(正样本):**单项目**端点的 `ensureSession` 确实会建出主对话。
    // 少了这一条,② 就会退化成「两个端点都不建」—— 那也是错的(那条端点**该**建),
    // 而 ② 的判据是「本端点不该建」,不是「谁都不建」。
    const viaProject = await ofProject(P2);
    expect(viaProject.map((s) => s.id)).toHaveLength(1);
    expect(viaProject[0]!.kind).toBe("main");
  });
});

describe("③ 组内次序:主对话在前,其余按最近活跃度", () => {
  it("主对话即使最不活跃也在最前", async () => {
    insertSession(db, { id: "s_stale_main", projectId: P1, createdAt: NOW });
    insertSession(db, { id: "s_hot", projectId: P1, createdAt: NOW + 1, kind: "thread", title: "热" });
    insertSession(db, { id: "s_cold", projectId: P1, createdAt: NOW + 2, kind: "thread", title: "冷" });
    say("s_stale_main", NOW);
    say("s_hot", NOW + 9_000);
    say("s_cold", NOW + 1_000);

    const rows = (await index()).filter((s) => s.projectId === P1);
    expect(rows.map((s) => s.id)).toEqual(["s_stale_main", "s_hot", "s_cold"]);
  });

  it("次序与单项目端点**逐条相同**", async () => {
    insertSession(db, { id: "s1_main", projectId: P1, createdAt: NOW });
    insertSession(db, { id: "t_a", projectId: P1, createdAt: NOW + 1, kind: "thread", title: "A" });
    insertSession(db, { id: "t_b", projectId: P1, createdAt: NOW + 2, kind: "thread", title: "B" });
    say("t_a", NOW + 5_000);
    say("t_b", NOW + 7_000);

    expect((await index()).map((s) => s.id)).toEqual((await ofProject(P1)).map((s) => s.id));
  });
});

describe("④ 与单项目端点共用同一份映射(实测等价)", () => {
  it("交付会话的标题在两处都兜底到**它交付的那份工件**", async () => {
    const body = "报告正文";
    const file = writeArtifactBody("a-deliv", body);
    insertArtifact(db, {
      id: "a-deliv", projectId: P1, conversationId: null, kind: "deliverable",
      status: "accepted", authorAgentId: bm,
      title: "架构方案 v2",
      bodyPath: file.path, bodySha256: file.sha, bodyBytes: file.bytes,
      metadataJson: null, createdAt: NOW, updatedAt: NOW,
    });
    insertSession(db, { id: "s1_main", projectId: P1, createdAt: NOW });
    insertSession(db, {
      id: "s_deliv", projectId: P1, createdAt: NOW + 1,
      channel: "client", deliverableArtifactId: "a-deliv",
    });

    // ⚠️ 库里这条线**没有 title**(`null`)—— 兜底必须发生,否则左栏与对话页
    // 会显示两个不同的名字(一个是 null 显示成「对话」,一个是工件标题)。
    const raw = db.prepare(`SELECT title FROM project_sessions WHERE id = ?`).get("s_deliv") as
      | { title: string | null }
      | undefined;
    expect(raw?.title, "正样本:这条线的库里标题确实是 null").toBeNull();

    const viaIndex = (await index()).find((s) => s.id === "s_deliv");
    const viaProject = (await ofProject(P1)).find((s) => s.id === "s_deliv");
    expect(viaIndex?.title).toBe("架构方案 v2");
    expect(viaProject?.title).toBe(viaIndex?.title);
  });

  it("甲方没起名的线程在两处都显示成同一个 `null`(前端兜底「对话」)", async () => {
    insertSession(db, { id: "s1_main", projectId: P1, createdAt: NOW });
    insertSession(db, { id: "t_unnamed", projectId: P1, createdAt: NOW + 1, kind: "thread" });

    const viaIndex = (await index()).find((s) => s.id === "t_unnamed");
    const viaProject = (await ofProject(P1)).find((s) => s.id === "t_unnamed");
    expect(viaIndex?.title).toBeNull();
    expect(viaProject?.title).toBe(viaIndex?.title);
  });
});