/**
 * 知识语料**分级(tier)** · 测试(migration 030)
 *
 * 这一层要钉住四件事,每一件都能被"改回去 / 改成看起来对的样子"弄红:
 *
 *   ① **判据只读结构化列**:工件按 `artifacts.kind` 分、消息按 `session_messages.kind` 分,
 *      而 `deliverable` **不许**被判成 `material`(正样本 + 负样本成对);
 *   ② **未知 kind fail-closed 到 `material`**:平台不认识的来源降权(而不是冒充结论);
 *   ③ **重扫自愈**:手工把 tier 置 NULL(模拟 030 之前的存量行)→ 重扫 → 修回来,
 *      而**块 id 不变** —— 幂等判据是 `sha256` **和** `tier`,后者变了只 UPDATE,不重建;
 *   ④ **排序:同等相关度时 primary 在前**,且这条断言**有牙** ——
 *      构造里 bm25 自己会把 material 排在前面(先断言这一点,再断言最终顺序)。
 *
 * ⚠️ 本文件**不**断言任何"识别外部网页内容"的行为:平台没有这个能力,语料只有
 * 「工件正文 / user|assistant 消息」两类来源,工具结果根本不进语料。
 * 分级判的是「来源是定稿还是原始材料」,写成"已标记污染"就是在编造
 * (见 `migrations/030_knowledge_tier.sql` 文件头)。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { ARTIFACT_STATUSES, insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertSession, appendSessionMessage } from "../../src/platform/storage/repo/sessions.js";
import {
  KNOWLEDGE_TIERS,
  artifactTier,
  chunkSha,
  getKnowledgeChunk,
  isKnowledgeTier,
  messageTier,
  replaceSourceChunks,
  searchKnowledgeChunks,
  type KnowledgeTier,
} from "../../src/platform/storage/repo/knowledge.js";
import { ARTIFACT_KINDS, type ArtifactKind } from "../../src/platform/identity/role.js";
import { reindexProjectKnowledge } from "../../src/platform/knowledge/reindex.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import { buildMatchQuery } from "../../src/platform/knowledge/query.js";
import { indexTerms } from "../../src/shared/text.js";

let db: Database.Database;
let workRoot: string;
let seq = 0;
const clock = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  workRoot = mkdtempSync(join(tmpdir(), "ss-knowledge-tier-"));
  seq = 0;
  insertAgent(db, { id: "rw", role: "research_worker", specialization: null, displayName: "研究工", createdAt: clock });
  insertProject(db, { id: "p1", name: "甲方的量化系统", client: "甲", goal: "g", status: "active", createdAt: clock });
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

const newId = (prefix: string): string => `${prefix}_${++seq}`;

/** 在临时工作根里写一份工件正文 + 落一行工件索引(先文件、后行 —— 与平台同序)。 */
function addArtifact(id: string, kind: ArtifactKind, body: string): void {
  const bodyPath = `artifacts/${id}.md`;
  const abs = join(workRoot, "projects", "p1", bodyPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  insertArtifact(db, {
    id, projectId: "p1", conversationId: null, kind, status: ARTIFACT_STATUSES[0]!,
    authorAgentId: "rw", title: `工件 ${id}`, bodyPath,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    bodyBytes: Buffer.byteLength(body), metadataJson: null, createdAt: clock, updatedAt: clock,
  });
}

function addMessage(id: string, content: string, kind: "user" | "assistant"): void {
  const sessionId = `s_${id}`;
  insertSession(db, { id: sessionId, projectId: "p1", createdAt: clock });
  appendSessionMessage(db, {
    id, sessionId, agentId: kind === "user" ? null : "rw", kind, content,
    createdAt: clock, originSource: null, triggerKind: null,
  });
}

function reindex(): ReturnType<typeof reindexProjectKnowledge> {
  return reindexProjectKnowledge(
    { db, now: () => clock, newId, workspace: createGitWorkspace(), workspaceRoot: workRoot },
    "p1",
  );
}

/** 库里每条块的 `id → tier`(自愈的"块 id 不变"判据用)。 */
function chunkTiers(): Array<{ id: string; tier: string | null }> {
  return db
    .prepare(`SELECT id, tier FROM knowledge_chunks WHERE project_id = 'p1' ORDER BY id`)
    .all() as Array<{ id: string; tier: string | null }>;
}

function tierOfSource(sourceId: string): Array<string | null> {
  const rows = db
    .prepare(`SELECT tier FROM knowledge_chunks WHERE source_id = ? ORDER BY seq`)
    .all(sourceId) as Array<{ tier: string | null }>;
  return rows.map((r) => r.tier);
}

// ── 闭集与判据(纯函数,不碰库)────────────────────────────────────

describe("分级闭集:取值域在 TS 里,不在 CHECK 里(先例 022)", () => {
  it("闭集恰好是两个取值,且 isKnowledgeTier 认得出边界外的东西", () => {
    expect([...KNOWLEDGE_TIERS]).toEqual(["primary", "material"]);
    expect(isKnowledgeTier("primary")).toBe(true);
    expect(isKnowledgeTier("material")).toBe(true);
    // 负样本:近义但不存在的东西不许被当成取值
    for (const bad of ["", "Primary", "PRIMARY", "material ", "tainted", "web", null, undefined, 0]) {
      expect(isKnowledgeTier(bad), `${String(bad)} 不是分级取值`).toBe(false);
    }
  });

  it("工件 kind → tier:七个定稿、四个材料(逐一对照,不是抽样)", () => {
    const primary = ["deliverable", "decision", "client_question", "meeting_note", "change_record", "project_brief", "work_brief"];
    const material = ["evidence", "hypothesis", "note", "review_finding"];
    for (const k of primary) expect(artifactTier(k), `${k} 是定稿`).toBe("primary");
    for (const k of material) expect(artifactTier(k), `${k} 是原始材料`).toBe("material");
    // 覆盖检查:今天 `ARTIFACT_KINDS` 里每一个都被显式分过类。
    // (默认分支仍在、仍然是 material —— 这条断言只是逼"新加一个 kind"必须是有意识的决定)
    expect([...primary, ...material].sort()).toEqual([...ARTIFACT_KINDS].sort());
  });

  it("负样本:deliverable 不许被判成 material;evidence 不许被判成 primary", () => {
    expect(artifactTier("deliverable")).not.toBe("material");
    expect(artifactTier("evidence")).not.toBe("primary");
  });

  it("未知 kind ⇒ material(fail-closed:可疑的降权,不许冒充结论)", () => {
    for (const bad of ["", "web_page", "external_snapshot", "unknown"]) {
      expect(artifactTier(bad), `未知 kind「${bad}」应降权`).toBe("material");
    }
  });

  it("消息 kind:甲方原话 = primary,角色自己的工作叙述 = material", () => {
    expect(messageTier("user")).toBe("primary");
    expect(messageTier("assistant")).toBe("material");
    // 负样本 + fail-closed:索引器的选择子之外的 kind 若哪天放进来,一律降权
    expect(messageTier("system")).toBe("material");
    expect(messageTier("tool")).toBe("material");
    expect(messageTier("")).toBe("material");
  });
});

// ── 索引器把 tier 真的写进行里(端到端)──────────────────────────

describe("索引器:每条来源都带上 tier(判据只读结构化列)", () => {
  it("evidence 工件 → material;deliverable → primary", () => {
    addArtifact("a_ev", "evidence", "# 抓来的原始素材\n\n这只是一段没有加工过的现场记录。");
    addArtifact("a_dl", "deliverable", "# 交付物\n\n这是定稿的结论。");
    reindex();
    expect(tierOfSource("a_ev")).toEqual(["material"]);
    expect(tierOfSource("a_dl")).toEqual(["primary"]);
  });

  it("user 消息 → primary;assistant 消息 → material", () => {
    addMessage("m_user", "甲方是做催收业务的。", "user");
    addMessage("m_asst", "我先把查到的资料整理一下。", "assistant");
    reindex();
    expect(tierOfSource("m_user")).toEqual(["primary"]);
    expect(tierOfSource("m_asst")).toEqual(["material"]);
  });

  it("负样本:deliverable 的块不是 material(整行读出来核对,不靠映射函数)", () => {
    addArtifact("a_dl", "deliverable", "# 交付物\n\n这是定稿的结论。");
    reindex();
    const rows = chunkTiers();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.tier, `块 ${r.id} 不该是 material`).not.toBe("material");
    expect(rows.every((r) => r.tier === "primary")).toBe(true);
  });

  it("重扫两次:tier 一模一样,块与 id 都不变(幂等没有因为多了一列而破)", () => {
    addMessage("m_user", "甲方是做催收业务的。", "user");
    addArtifact("a_ev", "evidence", "# 现场素材\n\n原始记录一份。");
    reindex();
    const before = chunkTiers();
    reindex();
    expect(chunkTiers()).toEqual(before);
  });
});

// ── 自愈:存量行的 tier 是 NULL,靠重扫修 ──────────────────────────

describe("自愈:tier 置 NULL → 重扫修回来(不回填,也不重建块)", () => {
  it("正文没变、tier 是 NULL 的行会被重扫补上,且**块 id 不变**", () => {
    addMessage("m_user", "甲方是做催收业务的。", "user");
    reindex();
    const before = chunkTiers();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((r) => r.tier === "primary")).toBe(true);

    // 模拟 030 之前索引的存量行:正文一个字没动,只是当时没算过 tier
    db.prepare(`UPDATE knowledge_chunks SET tier = NULL WHERE source_id = 'm_user'`).run();
    expect(tierOfSource("m_user")).toEqual(before.map(() => null));

    reindex();

    expect(tierOfSource("m_user")).toEqual(before.map(() => "primary"));
    // 负样本:补 tier **不许**走 DELETE + INSERT 重建块(那会换掉所有 chunkId,
    // 模型手里刚拿到的 chunkId 会当场失效)
    expect(chunkTiers()).toEqual(before);
  });

  it("只改 tier 也算 UPDATE:幂等判据是 `sha256` **和** `tier`(直接测写口)", () => {
    const text = "甲方是做催收业务的。";
    const spec = {
      sourceKind: "message" as const, sourceId: "m_x", projectId: "p1", messageId: "m_x",
      chunks: [{ seq: 0, offset: 0, length: text.length, text }],
      newId, now: clock, segOf: indexTerms,
    };
    // ① 第一次:插一行,tier 缺省 = null(= 没算过)
    expect(replaceSourceChunks(db, spec)).toEqual({ inserted: 1, updated: 0, unchanged: 0, deleted: 0 });
    const id1 = chunkTiers()[0]!.id;
    expect(tierOfSource("m_x")).toEqual([null]);

    // ② 正文没变、只是有了 tier ⇒ 必须 UPDATE(只看 sha256 的实现会在这里报 unchanged,自愈就废了)
    expect(replaceSourceChunks(db, { ...spec, tier: "primary" }))
      .toEqual({ inserted: 0, updated: 1, unchanged: 0, deleted: 0 });
    expect(tierOfSource("m_x")).toEqual(["primary"]);
    expect(chunkTiers()[0]!.id, "改 tier 不许换 chunkId").toBe(id1);

    // ③ 两条判据都相同 ⇒ 才是 unchanged
    expect(replaceSourceChunks(db, { ...spec, tier: "primary" }))
      .toEqual({ inserted: 0, updated: 0, unchanged: 1, deleted: 0 });

    // ④ 负样本:反过来把 tier 改掉也要 UPDATE(不是只朝一个方向"自愈")
    expect(replaceSourceChunks(db, { ...spec, tier: "material" }))
      .toEqual({ inserted: 0, updated: 1, unchanged: 0, deleted: 0 });
    expect(tierOfSource("m_x")).toEqual(["material"]);
    expect(chunkTiers()[0]!.id).toBe(id1);
    // 文本哈希这一半没有因为多了一列而失效
    expect(db.prepare(`SELECT sha256 FROM knowledge_chunks WHERE id = ?`).get(id1))
      .toEqual({ sha256: chunkSha(text) });
  });

  it("类别变了(evidence → deliverable)重扫后 tier 跟着走,块 id 仍不变", () => {
    addArtifact("a1", "evidence", "# 一份素材\n\n先记下来。");
    reindex();
    const idsBefore = chunkTiers().map((r) => r.id);
    const tiersBefore = chunkTiers().map((r) => r.tier);
    expect(tiersBefore.length).toBeGreaterThan(0);
    expect(tiersBefore.every((t) => t === "material")).toBe(true);
    db.prepare(`UPDATE artifacts SET kind = 'deliverable' WHERE id = 'a1'`).run();
    reindex();
    expect(tierOfSource("a1")).toEqual(["primary"]);
    expect(chunkTiers().map((r) => r.id), "改 tier 不许换 chunkId").toEqual(idsBefore);
  });
});

// ── 排序:两级(tier 优先,组内保持 bm25)─────────────────────────

describe("检索排序:tier 优先,同 tier 内保持原来的 rank 顺序", () => {
  /**
   * 构造一份**材料侧比定稿侧更相关**的语料:
   * `assistant` 消息很短、反复出现检索词(bm25 更好),`user` 消息很长、只提一次。
   * 另外补几条无关消息,让 FTS5 的文档数够大 —— bm25 的 idf 在"词出现在
   * 一半以上文档"时会翻符号,那样构造出来的分数不能用来证明排序有牙。
   */
  function seedRankReversal(): void {
    addMessage("m_material", "催收催收催收催收催收", "assistant");
    addMessage(
      "m_primary",
      "甲方是做催收业务的,合同范围包括坐席管理、质检流程、报表统计、系统对接与培训交付等若干事项,细节按附件执行。",
      "user",
    );
    addMessage("f1", "另一个话题:仓储与物流排期。", "user");
    addMessage("f2", "另一个话题:门店盘点流程。", "user");
    addMessage("f3", "另一个话题:供应商准入清单。", "user");
    addMessage("f4", "另一个话题:售后工单分级。", "user");
    reindex();
  }

  it("bm25 自己会把 material 排在前面 —— 先钉住这个前提,再断言最终顺序", () => {
    seedRankReversal();
    const hits = searchKnowledgeChunks(db, buildMatchQuery("催收")!, { limit: 10 });
    expect(hits.length).toBeGreaterThanOrEqual(2);

    // 前提(这条失败说明"构造没有牙",不是实现错了):按纯 rank 排,material 在前
    const byRank = [...hits].sort((a, b) => a.score - b.score);
    expect(byRank[0]!.chunk.tier).toBe("material");

    // 判据:两级排序之后 primary 在前
    expect(hits[0]!.chunk.tier).toBe("primary");
    const tiers = hits.map((h) => h.chunk.tier);
    expect(tiers.indexOf("primary")).toBeLessThan(tiers.indexOf("material"));
  });

  it("limit 的语义没变:仍是「取前 N 条」,只是这 N 条的顺序变了", () => {
    seedRankReversal();
    const one = searchKnowledgeChunks(db, buildMatchQuery("催收")!, { limit: 1 });
    expect(one.length).toBe(1);
    expect(one[0]!.chunk.tier).toBe("primary");
    // 组内原来的顺序仍然保留(两条 material / 定稿之间的相对次序不由 tier 决定)
    const all = searchKnowledgeChunks(db, buildMatchQuery("催收")!, { limit: 10 });
    const materialScores = all.filter((h) => h.chunk.tier === "material").map((h) => h.score);
    expect([...materialScores].sort((a, b) => a - b)).toEqual(materialScores);
  });

  it("顺序相反的一组:primary 本来就排第一时,断言照样成立(证明判据不是靠构造倒过来的)", () => {
    // 这次让 primary 更相关:甲方原话短而密,材料长而稀疏
    addMessage("m_primary", "催收催收催收催收催收", "user");
    addMessage(
      "m_material",
      "我查到一份材料,里面提到催收,其余内容与本次问题无关,只是把长度堆起来而已。",
      "assistant",
    );
    addMessage("f1", "另一个话题:仓储与物流排期。", "user");
    addMessage("f2", "另一个话题:门店盘点流程。", "user");
    addMessage("f3", "另一个话题:供应商准入清单。", "user");
    addMessage("f4", "另一个话题:售后工单分级。", "user");
    reindex();
    const hits = searchKnowledgeChunks(db, buildMatchQuery("催收")!, { limit: 10 });
    expect(hits[0]!.chunk.tier).toBe("primary");
    expect(hits[0]!.chunk.sourceId).toBe("m_primary");
  });

  it("tier 为 NULL 的老块不享 primary 的优先,但也**照样能被检索到**(降权不是过滤)", () => {
    seedRankReversal();
    db.prepare(`UPDATE knowledge_chunks SET tier = NULL WHERE source_id = 'm_material'`).run();
    const hits = searchKnowledgeChunks(db, buildMatchQuery("催收")!, { limit: 10 });
    // 它还在结果里 —— 排序变了,召回面没变
    expect(hits.map((h) => h.chunk.sourceId)).toContain("m_material");
    expect(hits[0]!.chunk.tier).toBe("primary");
    expect(hits.find((h) => h.chunk.sourceId === "m_material")!.chunk.tier).toBeNull();
  });

  it("检索返回的行真的带 tier(不是只在工具文案里出现)", () => {
    seedRankReversal();
    const hits = searchKnowledgeChunks(db, buildMatchQuery("催收")!, { limit: 10 });
    const tiers = hits.map((h) => h.chunk.tier);
    for (const t of tiers) {
      expect(t === null || t === "primary" || t === "material").toBe(true);
    }
    expect(tiers).toContain("primary");
    expect(tiers).toContain("material");
  });
});

/** 单块分级的最小自检:接上索引器之后,库里那一列就是闭集里的一个值。 */
describe("写进库里的取值恒在闭集内", () => {
  it("索引之后的每一行 tier 都是 primary / material", () => {
    addMessage("m_user", "甲方是做催收业务的。", "user");
    addMessage("m_asst", "我整理了一份材料。", "assistant");
    addArtifact("a_ev", "evidence", "# 现场素材\n\n原始记录一份。");
    reindex();
    const tiers = chunkTiers().map((r) => r.tier);
    expect(tiers.length).toBeGreaterThan(0);
    for (const t of tiers) {
      expect(t, "索引后不该有 NULL(这一趟算过了)").not.toBeNull();
      expect(isKnowledgeTier(t)).toBe(true);
    }
    const set: ReadonlySet<KnowledgeTier> = new Set(tiers as KnowledgeTier[]);
    expect([...set].sort()).toEqual(["material", "primary"]);
  });

  it("库里出现闭集外的 tier ⇒ 读侧**响亮抛错**(fail loud,不静默降级成某一档)", () => {
    addMessage("m_user", "甲方是做催收业务的。", "user");
    reindex();
    const chunkId = chunkTiers()[0]!.id;
    // 正样本:合法取值读得出来(下面那两条断言才有对照,不是在一个永远抛错的函数上空转)
    expect(getKnowledgeChunk(db, chunkId)!.tier).toBe("primary");

    db.prepare(`UPDATE knowledge_chunks SET tier = 'tainted'`).run();

    // 负样本:闭集外的值必须被点名,不许被当成 material(那是拿"库坏了"冒充一个取值)。
    // ⚠️ 抛错的是 `rowToChunk` 这一层,不是 SQL:排序那句 CASE 只认 'primary',
    // 它会安静地把这一行分到非 primary 组 —— 所以拦住"读面撒谎"的只有这一层。
    expect(() => getKnowledgeChunk(db, chunkId)).toThrow(/未定义 tier/);
    expect(() => searchKnowledgeChunks(db, buildMatchQuery("催收")!)).toThrow(/未定义 tier/);
    // 行还在、删掉它与否不是这里的事:如实读不到就该响亮,不是悄悄当成低权重
    expect(() => db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks`).get()).not.toThrow();
  });
});
