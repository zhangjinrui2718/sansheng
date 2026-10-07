/**
 * 知识语料的读面(`GET /api/knowledge` · `GET /api/knowledge/chunks`)
 *
 * 这两个端点服务的是**记忆页的「知识语料」段**,而用户在那一段要回答的问题是:
 * **「这个机制有没有在正常运行」**(量级 / 时效 / 落后多少 / 哪里没进去)。
 * 所以这里守的是那几条判据本身,不是"接口能返回 200":
 *
 *   ① **行与 FTS 索引必须一致**(`chunks === ftsRows`)—— 不等就是索引坏了;
 *   ② **`pending` 与 `lagMs` 必须真的会动**:写一条新来源、**不重建索引**,
 *      概览要能当场说出「1 条没进语料」与「落后了 N 毫秒」——
 *      一个永远回 0 的计数器在屏幕上与"一切正常"长得一模一样;
 *   ③ **读不到 ≠ 空**:表不在 ⇒ `runtime: "unavailable"` + `problem`;
 *      正文读不到 ⇒ 该块 `state: "unavailable"` 且 `text` 为空、`problem` 非空;
 *   ④ **`q` 与浏览是两条不同的路**:不传 `q` 是按时浏览,传了才检索,
 *      而切不出检索词的 `q` **拒收**(别让一次"没切出词"看起来像"库里没有")。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertSession, appendSessionMessage } from "../../src/platform/storage/repo/sessions.js";
import { reindexProjectKnowledge } from "../../src/platform/knowledge/reindex.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { KnowledgeChunkView, KnowledgeOverviewView } from "@shared/types/platform.js";

const P1 = "p-k1";
const P2 = "p-k2";
const NOW = 1_760_000_000_000;

let db: Database.Database;
let workRoot = "";
let seq = 0;

beforeEach(() => {
  db = openPlatformMemoryDb();
  workRoot = mkdtempSync(join(tmpdir(), "ss-know-http-"));
  seq = 0;
  // 工件的 author 有外键指 agents —— 夹具必须先建这个人
  insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: NOW });
  insertProject(db, { id: P1, name: "催收语音机器人", client: "甲", goal: "g", status: "active", createdAt: NOW });
  insertProject(db, { id: P2, name: "另一个项目", client: "乙", goal: "g", status: "active", createdAt: NOW });
  insertSession(db, { id: "s1", projectId: P1, createdAt: NOW });
  insertSession(db, { id: "s2", projectId: P2, createdAt: NOW });
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

/** 在临时工作根里写一份工件正文,并落一行索引(先文件、后行)。 */
function addArtifact(projectId: string, id: string, body: string, title = "催收外呼方案"): string {
  const bodyPath = `artifacts/${id}.md`;
  const abs = join(workRoot, "projects", projectId, bodyPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  insertArtifact(db, {
    id, projectId, conversationId: null, kind: "note", status: "open",
    authorAgentId: "bm", title, bodyPath,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    bodyBytes: Buffer.byteLength(body), metadataJson: null, createdAt: NOW, updatedAt: NOW,
  });
  return bodyPath;
}

function addMessage(id: string, sessionId: string, content: string): void {
  appendSessionMessage(db, {
    id, sessionId, agentId: null, kind: "user", content,
    createdAt: NOW, originSource: null, triggerKind: null,
  });
}

function reindexAll(): void {
  for (const pid of [P1, P2]) {
    reindexProjectKnowledge(
      { db, now: () => NOW, newId: (p) => `${p}_${(seq += 1)}`, workspace: createGitWorkspace(), workspaceRoot: workRoot },
      pid,
    );
  }
}

function makeDeps(): HttpDeps {
  return {
    db,
    dataDir: "/tmp/knowledge-http-test",
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
    harnessDirs: { dataDir: "/tmp/knowledge-http-test", factoryDir: "/tmp/knowledge-http-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
  };
}

const app = (): ReturnType<typeof createPlatformApp> => createPlatformApp(makeDeps());

async function getOverview(): Promise<KnowledgeOverviewView> {
  const res = await app().request("/api/knowledge");
  expect(res.status).toBe(200);
  return (await res.json()) as KnowledgeOverviewView;
}

async function getChunks(query: string): Promise<KnowledgeChunkView[]> {
  const res = await app().request(`/api/knowledge/chunks${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { chunks: KnowledgeChunkView[] }).chunks;
}

describe("概览:机制有没有在正常运行(判据是几个会动的数字)", () => {
  it("索引之后:行与 FTS 一致、没有待索引来源、时效跟得上", async () => {
    addArtifact(P1, "a1", "# 催收外呼方案\n\n甲方聚焦技术架构与集成。");
    addMessage("m1", "s1", "甲方是做催收业务的。");
    reindexAll();

    const v = await getOverview();
    expect(v.runtime).toBe("ok");
    expect(v.problem).toBeNull();
    expect(v.chunks).toBeGreaterThan(0);
    // ① 行与 FTS 索引必须一致 —— 这条不等就是索引坏了
    expect(v.ftsRows).toBe(v.chunks);
    expect(v.sourcesIndexed.artifacts).toBe(1);
    expect(v.sourcesIndexed.messages).toBe(1);
    // ② 账要平:没有来源漏在语料外
    expect(v.pending.artifacts).toBe(0);
    expect(v.pending.messages).toBe(0);
    expect(v.lastIndexedAt).not.toBeNull();
    expect(v.lagMs).toBe(0);
    // ③ 按项目分行 —— 没来源的项目也出现(它就是"机制没跑到"的样子)
    expect(v.projects.map((p) => p.projectId).sort()).toEqual([P1, P2].sort());
    const p1 = v.projects.find((p) => p.projectId === P1)!;
    expect(p1.chunks).toBeGreaterThan(0);
    expect(p1.name).toBe("催收语音机器人");
    expect(v.projects.find((p) => p.projectId === P2)!.chunks).toBe(0);
  });

  it("**新来源没进语料时概览必须当场说出来**(负样本:写一条不重建索引)", async () => {
    addMessage("m1", "s1", "甲方是做催收业务的。");
    reindexAll();
    const before = await getOverview();
    expect(before.pending.messages).toBe(0);

    addMessage("m2", "s1", "后来又补了一条:外呼走阿里云。");
    const after = await getOverview();

    expect(after.pending.messages, "1 条新消息没进语料,pending 必须动").toBe(1);
    expect(after.pending.preview.map((p) => p.sourceId)).toContain("m2");
    // label 是给人看的(消息开头),不是 id —— preview 的意义就在这里
    expect(after.pending.preview.find((p) => p.sourceId === "m2")?.label).toContain("后来又补了一条");

    reindexAll();
    const settled = await getOverview();
    expect(settled.pending.messages).toBe(0);
    expect(settled.chunks).toBeGreaterThan(after.chunks);
  });

  it("工件正文读不到时:块**不消失**,而 pending 不会因此撒谎", async () => {
    const bodyPath = addArtifact(P1, "a1", "# 催收外呼方案\n\n甲方聚焦技术架构与集成。");
    reindexAll();
    const before = await getOverview();
    rmSync(join(workRoot, "projects", P1, bodyPath));

    const after = await getOverview();
    // 块还在(读故障 ≠ 语料丢失),所以 pending 仍是 0:它已经"进过语料"了。
    // 「读不到」这件事由明细那一侧当场说(state: unavailable),而不是靠计数猜。
    expect(after.chunks).toBe(before.chunks);
    expect(after.pending.artifacts).toBe(0);
    const chunks = await getChunks("?projectId=" + P1);
    expect(chunks.some((c) => c.state === "unavailable" && c.problem !== null)).toBe(true);
  });

  it("表不在 ⇒ `runtime: \"unavailable\"` + problem(**不是** 0 条语料的 ok)", async () => {
    db.exec(`DROP TABLE knowledge_chunks`);
    const v = await getOverview();
    expect(v.runtime).toBe("unavailable");
    expect(v.problem).not.toBeNull();
    expect(v.problem).toContain("读不到");
    expect(v.chunks).toBe(0);
  });
});

describe("明细:检索 / 浏览 / 出处 / 三态", () => {
  beforeEach(() => {
    addArtifact(P1, "a1", "# 催收外呼方案\n\n甲方聚焦技术架构与集成,预算按坐席规模算。");
    addMessage("m1", "s1", "甲方是做催收业务的,电话催收外呼方向。");
    addArtifact(P2, "b1", "# 另一个项目的文档\n\n讲的是完全不同的事情。");
    reindexAll();
  });

  it("传 q 走检索:命中且带得出处与正文切片(明细要看得到字)", async () => {
    const chunks = await getChunks("?q=" + encodeURIComponent("催收"));
    expect(chunks.length).toBeGreaterThan(0);
    const c = chunks[0]!;
    expect(c.projectId).toBe(P1);
    expect(c.projectName).toBe("催收语音机器人");
    expect(c.state).toBe("ok");
    expect(c.problem).toBeNull();
    expect(c.excerpt).toContain("催收");
    expect(c.text.length).toBeGreaterThan(0);
    expect(c.offset).toBeGreaterThanOrEqual(0);
    expect(c.length).toBeGreaterThan(0);
  });

  it("**不传 q = 按时间浏览**(与检索是两条路,不是「空查询」)", async () => {
    const chunks = await getChunks("");
    expect(chunks.length).toBeGreaterThan(0);
    // 时间倒序:updatedAt 不升
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i - 1]!.updatedAt).toBeGreaterThanOrEqual(chunks[i]!.updatedAt);
    }
  });

  it("projectId 过滤:另一个项目的块**不在**结果里(负样本)", async () => {
    const onlyP1 = await getChunks("?projectId=" + P1);
    expect(onlyP1.length).toBeGreaterThan(0);
    expect(onlyP1.every((c) => c.projectId === P1)).toBe(true);
    expect(onlyP1.some((c) => c.artifactId === "b1")).toBe(false);

    const onlyP2 = await getChunks("?projectId=" + P2);
    expect(onlyP2.every((c) => c.projectId === P2)).toBe(true);
    expect(onlyP2.length).toBeGreaterThan(0);
  });

  it("检索 + 项目过滤同时生效", async () => {
    const chunks = await getChunks(`?q=${encodeURIComponent("催收")}&projectId=${P2}`);
    expect(chunks).toEqual([]);
  });

  it("切不出检索词的 q ⇒ 400 invalid_args(别让「没切出词」看起来像「库里没有」)", async () => {
    const res = await app().request("/api/knowledge/chunks?q=" + encodeURIComponent("!"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_args");
    expect(body.error.message).toContain("太短");
  });

  it("正文被改过 ⇒ `state: \"drifted\"` + problem,仍然给切片(如实,不装作正常)", async () => {
    const target = (await getChunks(`?q=${encodeURIComponent("坐席")}`))[0]!;
    const artifact = target.artifactId!;
    writeFileSync(
      join(workRoot, "projects", P1, `artifacts/${artifact}.md`),
      "# 催收外呼方案\n\n内容被人工改掉了,而且改得很不一样。",
      "utf8",
    );
    const after = (await getChunks(`?projectId=${P1}&limit=100`)).find((c) => c.id === target.id)!;
    expect(after.state).toBe("drifted");
    expect(after.problem).not.toBeNull();
    expect(after.text.length).toBeGreaterThan(0);
  });

  it("limit 有上界(100),坏值取默认 20", async () => {
    const capped = await getChunks("?limit=9999");
    expect(capped.length).toBeLessThanOrEqual(100);
    const bad = await getChunks("?limit=abc");
    expect(bad.length).toBeLessThanOrEqual(20);
    expect(bad.length).toBeGreaterThan(0);
  });
});
