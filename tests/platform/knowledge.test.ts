/**
 * 知识语料(knowledge)· 测试
 *
 * 设计 `docs/DESIGN-KNOWLEDGE.md`。这个文件钉住四件事,每一件都能被"改回去"弄红:
 *
 *   ① **偏移是判据**:块必须能按 `offset`/`length` 从来源正文切回原样 ——
 *      切块时任何"顺手 trim / 折叠空白"都会让引用读出错位的正文,而错位的正文
 *      **看起来是正常内容**(不是空),这是最坏的一种错。
 *   ② **中文检索真的能搜到**(设计 §4 那张表):FTS5 裸表与 trigram 对 2 字中文查询
 *      都是 0 命中,只有 bigram 索引列能中 —— 所以这里有**正负样本**。
 *   ③ **幂等**:同一份来源重扫两次,块数与 id 都不变(排空器会重试、宿主会重启)。
 *   ④ **读故障不许变成语料丢失**:工件正文读不到时**保留旧块**并如实报 `unreadable`;
 *      而 `knowledge_read` 的"读不到"必须是 `unavailable`,**不是**一段空正文。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { ARTIFACT_STATUSES, insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertSession, appendSessionMessage } from "../../src/platform/storage/repo/sessions.js";
import { countKnowledgeChunks, searchKnowledgeChunks } from "../../src/platform/storage/repo/knowledge.js";
import { CHUNK_MAX, chunkText, htmlToText } from "../../src/platform/knowledge/chunk.js";
import { buildMatchQuery, excerpt } from "../../src/platform/knowledge/query.js";
import { materializeChunk } from "../../src/platform/knowledge/sources.js";
import { reindexProjectKnowledge } from "../../src/platform/knowledge/reindex.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { ALL_TOOLS } from "../../src/platform/harness/capability.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";

let db: Database.Database;
let workRoot: string;
let seq = 0;
let clock = 1_700_000_000_000;
let project: Project;
const agent: Agent = { id: "rw", role: "research_worker", specialization: null, displayName: "研究工" };

beforeEach(() => {
  db = openPlatformMemoryDb();
  workRoot = mkdtempSync(join(tmpdir(), "ss-knowledge-"));
  seq = 0;
  clock = 1_700_000_000_000;
  insertAgent(db, { id: "rw", role: "research_worker", specialization: null, displayName: "研究工", createdAt: clock });
  insertProject(db, { id: "p1", name: "甲方的量化系统", client: "甲", goal: "g", status: "active", createdAt: clock });
  addMember(db, "p1", "rw", clock);
  project = loadProjectForAuthz(db, "p1")!;
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

const newId = (prefix: string): string => `${prefix}_${++seq}`;

/** 建一条会话消息 —— 语料的第二个来源。 */
function addMessage(id: string, content: string, kind: "user" | "assistant" = "user"): void {
  const sessionId = `s_${id}`;
  insertSession(db, { id: sessionId, projectId: "p1", createdAt: clock });
  appendSessionMessage(db, {
    id, sessionId, agentId: kind === "user" ? null : "rw", kind, content,
    createdAt: clock, originSource: null, triggerKind: null,
  });
}

/** 在临时工作根里写一份工件正文,并落一行工件索引(先文件、后行 —— 与平台同序)。 */
function addArtifact(id: string, body: string, title = "催收外呼方案"): string {
  const bodyPath = `artifacts/${id}.md`;
  const abs = join(workRoot, "projects", "p1", bodyPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null, kind: "note", status: ARTIFACT_STATUSES[0]!,
    authorAgentId: "rw", title, bodyPath,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    bodyBytes: Buffer.byteLength(body), metadataJson: null, createdAt: clock, updatedAt: clock,
  });
  return bodyPath;
}

function reindex(): ReturnType<typeof reindexProjectKnowledge> {
  return reindexProjectKnowledge(
    { db, now: () => clock, newId, workspace: createGitWorkspace(), workspaceRoot: workRoot },
    "p1",
  );
}

/** 语料里现存的块 id(幂等判据用)。 */
function chunkIds(): string[] {
  const rows = db
    .prepare(`SELECT id FROM knowledge_chunks WHERE project_id = 'p1' ORDER BY source_kind, source_id, seq`)
    .all() as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

function ctx(over: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    db, agent, project, now: () => clock, newId,
    workspace: createGitWorkspace(), workspaceRoot: workRoot,
    ...over,
  };
}
async function call(tool: string, args: Record<string, unknown> = {}, c = ctx()): Promise<ToolResult> {
  const r = dispatch(tool, args, c);
  return r instanceof Promise ? r : r;
}
function okText(r: ToolResult): string {
  if (!r.ok) throw new Error(`期望成功,失败[${r.code}] ${r.message}`);
  return r.text;
}
function errOf(r: ToolResult): Extract<ToolResult, { ok: false }> {
  if (r.ok) throw new Error(`期望失败,成功:${r.text}`);
  return r;
}

// ── 切块 ─────────────────────────────────────────────────────────

describe("切块:偏移是判据(不许改写原文)", () => {
  it("把块按 offset/length 切回去,去掉空白后 === 原文去掉空白", () => {
    const text = [
      "第一段:甲方是做催收业务的。",
      "",
      "第二段:技术方案聚焦架构与集成。",
      "",
      "第三段:交付物是一份 HTML 报告。",
    ].join("\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(0);
    // 逐块自检:文本与区间必须自洽(这是引用能读对的前提)
    for (const [i, c] of chunks.entries()) {
      expect(c.seq).toBe(i);
      expect(c.text).toBe(text.slice(c.offset, c.offset + c.length));
      expect(c.length).toBeGreaterThan(0);
    }
    const strip = (s: string): string => s.replace(/\s+/g, "");
    expect(strip(chunks.map((c) => c.text).join(""))).toBe(strip(text));
  });

  it("超长段落被切开,每块不超硬上限(它是提示词预算)", () => {
    const long = "催收".repeat(3000); // 6000 字,没有空行也没有句末标点 ⇒ 只能硬切
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_MAX);
    expect(chunks.map((c) => c.text).join("")).toBe(long);
  });

  it("空文本 / 纯空白 ⇒ 没有块(负样本:别造出空块)", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n \t ")).toEqual([]);
  });

  it("HTML 正文:标签与脚本被摘掉,正文留下", () => {
    const html = "<html><head><style>p{color:red}</style></head><body><h1>催收外呼方案</h1>"
      + "<p>甲方聚焦技术架构。</p><script>alert('xss')</script></body></html>";
    const text = htmlToText(html);
    expect(text).toContain("催收外呼方案");
    expect(text).toContain("甲方聚焦技术架构");
    // 负样本:脚本内容与样式绝不能进语料(它会进模型上下文)
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });
});

// ── 检索(设计 §4 的正负样本)──────────────────────────────────────

describe("检索式:查询侧与索引侧必须同一套切法", () => {
  it("切不出词就回 null,不退化成一个假检索", () => {
    expect(buildMatchQuery("")).toBeNull();
    expect(buildMatchQuery("!!!")).toBeNull();
    expect(buildMatchQuery("a")).toBeNull();
    expect(buildMatchQuery("催收")).toBe('"催收"');
    expect(buildMatchQuery("docker 部署")).toBe('"docker" OR "部署"');
  });

  it("摘录只用于展示(折叠空白 + 截断),不改来源", () => {
    expect(excerpt("  甲方   做催收  ")).toBe("甲方 做催收");
    const long = "字".repeat(300);
    expect(excerpt(long, 10)).toBe(`${"字".repeat(10)}…`);
  });
});

describe("检索:中文 2 字查询命中(设计 §4 那张表)", () => {
  beforeEach(() => {
    addMessage("m1", "甲方是做催收业务的,电话催收外呼方向。");
    reindex();
  });

  it("正样本:2 字中文查询命中 bigram 索引列", () => {
    for (const q of ["催收", "收业", "外呼"]) {
      const match = buildMatchQuery(q)!;
      const hits = searchKnowledgeChunks(db, match);
      expect(hits.length, `查询「${q}」应命中`).toBeGreaterThan(0);
      expect(hits[0]!.chunk.sourceId).toBe("m1");
    }
  });

  it("负样本:无关查询 0 命中(FTS5 裸表与 trigram 会在这里给出同样的 0,所以上一条才是判据)", () => {
    expect(searchKnowledgeChunks(db, buildMatchQuery("量化交易")!).length).toBe(0);
  });
});

// ── 索引器 ───────────────────────────────────────────────────────

describe("索引器:幂等 / 变化 / 对账", () => {
  it("重扫两次:块数与 id 都不变(幂等)", () => {
    addMessage("m1", "甲方是做催收业务的。");
    const first = reindex();
    const ids1 = chunkIds();
    expect(first.messagesIndexed).toBe(1);
    expect(ids1.length).toBeGreaterThan(0);
    reindex();
    expect(chunkIds()).toEqual(ids1);
  });

  it("正文改了:块被替换(不是叠加),旧文本搜不到", () => {
    addMessage("m1", "甲方是做催收业务的。");
    reindex();
    db.prepare(`UPDATE session_messages SET content = ? WHERE id = 'm1'`).run("甲方改做量化交易了。");
    reindex();
    expect(searchKnowledgeChunks(db, buildMatchQuery("量化交易")!).length).toBeGreaterThan(0);
    expect(searchKnowledgeChunks(db, buildMatchQuery("催收")!).length).toBe(0);
  });

  it("来源删了:语料被清除(prune 有数,不静默留幽灵块)", () => {
    addMessage("m1", "甲方是做催收业务的。");
    reindex();
    expect(countKnowledgeChunks(db)).toBeGreaterThan(0);
    db.prepare(`DELETE FROM session_messages WHERE id = 'm1'`).run();
    const r = reindex();
    expect(r.pruned).toBeGreaterThan(0);
    expect(countKnowledgeChunks(db)).toBe(0);
  });

  it("`system` 消息不进语料(它是平台通知,不是语料)", () => {
    const sessionId = "s_sys";
    insertSession(db, { id: sessionId, projectId: "p1", createdAt: clock });
    appendSessionMessage(db, {
      id: "sys1", sessionId, agentId: null, kind: "system",
      content: "⚠️ 工作区提交失败:磁盘只读", createdAt: clock, originSource: null, triggerKind: null,
    });
    const r = reindex();
    expect(r.messagesIndexed).toBe(0);
    expect(countKnowledgeChunks(db)).toBe(0);
  });

  it("工件从盘上建块,检索能命中并带上工件出处", () => {
    addArtifact("a1", "# 催收外呼方案\n\n甲方聚焦技术架构与集成。\n\n## 预算\n\n按坐席规模计算。");
    const r = reindex();
    expect(r.artifactsIndexed).toBe(1);
    const hits = searchKnowledgeChunks(db, buildMatchQuery("坐席")!);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.chunk.sourceKind).toBe("artifact");
    expect(hits[0]!.chunk.artifactId).toBe("a1");
  });

  it("工件正文读不到时**保留已有块**,并如实报 unreadable(读故障 ≠ 语料丢失)", () => {
    const bodyPath = addArtifact("a1", "# 催收外呼方案\n\n甲方聚焦技术架构与集成。");
    reindex();
    const before = countKnowledgeChunks(db);
    expect(before).toBeGreaterThan(0);

    rmSync(join(workRoot, "projects", "p1", bodyPath));
    const r = reindex();
    expect(r.unreadable.map((u) => u.sourceId)).toContain("a1");
    expect(countKnowledgeChunks(db), "读不到不许把已有语料删掉").toBe(before);
  });
});

// ── 引用三态 ─────────────────────────────────────────────────────

describe("引用:materializeChunk 的三态(不是 ok 就都不是空正文)", () => {
  it("ok:切片与索引记的哈希一致", () => {
    addMessage("m1", "甲方是做催收业务的。");
    reindex();
    const [hit] = searchKnowledgeChunks(db, buildMatchQuery("催收")!);
    const m = materializeChunk(db, null, hit!.chunk);
    expect(m.state).toBe("ok");
    expect(m.slice).toBe("甲方是做催收业务的。");
    expect(m.problem).toBeNull();
  });

  it("drifted:正文被人工改过 ⇒ 状态如实标出,仍然给切片", () => {
    addMessage("m1", "甲方是做催收业务的。");
    reindex();
    const [hit] = searchKnowledgeChunks(db, buildMatchQuery("催收")!);
    db.prepare(`UPDATE session_messages SET content = ? WHERE id = 'm1'`).run("甲方改做量化交易了,别的没变。");
    const m = materializeChunk(db, null, hit!.chunk);
    expect(m.state).toBe("drifted");
    expect(m.problem).not.toBeNull();
    expect(m.slice.length).toBeGreaterThan(0);
  });

  it("unavailable:读不到 ⇒ 空切片 + problem(**不是** ok 的空正文)", () => {
    addMessage("m1", "甲方是做催收业务的。");
    reindex();
    const [hit] = searchKnowledgeChunks(db, buildMatchQuery("催收")!);
    db.prepare(`DELETE FROM session_messages WHERE id = 'm1'`).run();
    const m = materializeChunk(db, null, hit!.chunk);
    expect(m.state).toBe("unavailable");
    expect(m.slice).toBe("");
    expect(m.problem).not.toBeNull();
  });
});

// ── 工具读口 ─────────────────────────────────────────────────────

describe("工具:knowledge_search / knowledge_read", () => {
  beforeEach(() => {
    addMessage("m1", "甲方是做催收业务的,电话催收外呼方向。");
    addArtifact("a1", "# 催收外呼方案\n\n甲方聚焦技术架构与集成,预算按坐席规模算。");
    reindex();
  });

  it("检索返回片段 + 来源坐标 + chunkId(五角色都持这个能力)", async () => {
    const text = okText(await call("knowledge_search", { query: "催收" }));
    expect(text).toContain("chunkId=chk_");
    expect(text).toMatch(/\[(工件|消息)\]/);
    expect(text).toContain("项目 p1");
  });

  it("没有命中时如实说「没有匹配」,不是静默空", async () => {
    const text = okText(await call("knowledge_search", { query: "完全不相关的词" }));
    expect(text).toContain("没有匹配");
  });

  it("查询太短 ⇒ invalid_args(给出可执行的下一步)", async () => {
    const e = errOf(await call("knowledge_search", { query: "!" }));
    expect(e.code).toBe("invalid_args");
    expect(e.message).toContain("太短");
  });

  it("knowledge_read 按 chunkId 取回那一段正文", async () => {
    const search = okText(await call("knowledge_search", { query: "坐席" }));
    const chunkId = /chunkId=(chk_\w+)/.exec(search)?.[1];
    expect(chunkId).toBeDefined();
    const text = okText(await call("knowledge_read", { chunkId: chunkId! }));
    expect(text).toContain("状态:ok");
    expect(text).toContain("坐席");
  });

  it("未知 chunkId ⇒ not_found(别让模型以为语料是空的)", async () => {
    const e = errOf(await call("knowledge_read", { chunkId: "chk_nope" }));
    expect(e.code).toBe("not_found");
  });

  it("接待会话(没有项目)里被挡 —— fail-closed,不进 INTAKE_CAPABILITIES", async () => {
    const e = errOf(await call("knowledge_search", { query: "催收" }, ctx({ project: null })));
    expect(e.code).toBe("denied");
  });

  it("闭集里**没有**知识语料的写侧工具(平台是唯一写者)", () => {
    const knowledgeTools = ALL_TOOLS.filter((t) => t.startsWith("knowledge_"));
    expect(knowledgeTools).toEqual(["knowledge_read", "knowledge_search"]);
  });

  // ── 分级(migration 030)────────────────────────────────────────
  //
  // 夹具里 `m1` 是**甲方原话**(user ⇒ primary)、`a1` 是 `kind=note` 的工件
  // (⇒ material),所以这一组正负样本天然成对。

  it("knowledge_search:每条带分级,并用一句人话说清 material 是什么", async () => {
    const text = okText(await call("knowledge_search", { query: "催收" }));
    expect(text).toContain("[primary]");
    expect(text).toContain("[material]");
    // 排序:定稿在前(同一条检索里两组都在)
    expect(text.indexOf("[primary]")).toBeLessThan(text.indexOf("[material]"));
    // 那一句人话必须在这里 —— 模型看不到这段说明就只能猜"material 是不是坏的"
    expect(text).toContain("未加工的现场材料");
    expect(text).toContain("不是平台结论");
    // 负样本:平台**没有**能力判断内容从哪来,文案里不许出现这种断言
    expect(text).not.toContain("外部网页");
    expect(text).not.toContain("污染");
    expect(text).not.toContain("tainted");
  });

  it("knowledge_read:带上这一条的分级(与 search 同一个判据)", async () => {
    const search = okText(await call("knowledge_search", { query: "坐席" }));
    const chunkId = /chunkId=(chk_\w+)/.exec(search)?.[1];
    expect(chunkId).toBeDefined();
    const text = okText(await call("knowledge_read", { chunkId: chunkId! }));
    // 「坐席」只出现在 a1(note ⇒ material)里
    expect(text).toContain("分级:material");
    expect(text).toContain("不是平台结论");
  });

  it("分级未算的行(chunkId 对应的 tier 为 NULL)如实说「未算」,不冒充任一级", async () => {
    db.prepare(`UPDATE knowledge_chunks SET tier = NULL`).run();
    const search = okText(await call("knowledge_search", { query: "催收" }));
    expect(search).toContain("[分级未算]");
    const chunkId = /chunkId=(chk_\w+)/.exec(search)?.[1];
    const text = okText(await call("knowledge_read", { chunkId: chunkId! }));
    expect(text).toContain("分级:未算");
    expect(text).toContain("既不是 primary 也不是 material");
  });
});
