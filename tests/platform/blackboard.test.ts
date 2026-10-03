/**
 * BC3 Blackboard + BC4 ChangeControl · 仓储行为测试(批次 3)
 *
 * 重点同样不是 CRUD 能不能跑通,而是:
 *   - 作用域是 **projectId 而非 conversationId**(本次升级最关键的签名变更)
 *   - 约束真的在生效(CHECK / FK)
 *   - 状态机的**非法迁移被拒**(proposed 直接跳 implemented 是最典型的漏洞)
 *   - 两个多对多关系可查 —— 设计 1 §8.1 原本没给它们存储位置
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertWork } from "../../src/platform/storage/repo/works.js";
import {
  insertArtifact, getArtifact, listArtifacts, setArtifactStatus, updateArtifactBody,
  countArtifactsByKind, addArtifactLink, removeArtifactLink, listLinks, listBackLinks,
  isArtifactStatus, isArtifactLinkRel,
  type ArtifactRow, type ArtifactKind,
} from "../../src/platform/storage/repo/artifacts.js";
import {
  insertBlocker, getBlocker, listBlockers, setBlockerStatus,
  blockWork, unblockWork, listBlockedWorks, blockersForWork,
  isBlockerStatus, isBlockerSeverity, isUnresolvedBlocker,
} from "../../src/platform/storage/repo/blockers.js";
import {
  insertChange, getChange, listChanges, transitionChange, affectWork, unaffectedWork,
  listAffectedWorks, changesForWork,
  isChangeStatus, isChangeTerminal, canTransition,
} from "../../src/platform/storage/repo/changes.js";

let db: Database.Database;
let seq = 0;
let projectId: string;
let agentA: string;
let agentB: string;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  projectId = `pj${++seq}`;
  insertProject(db, {
    id: projectId, name: "测试", client: "甲方", goal: "g", status: "active", createdAt: T0,
  });
  agentA = `ag${++seq}`;
  agentB = `ag${++seq}`;
  insertAgent(db, { id: agentA, role: "worker", specialization: "algorithm", displayName: "算法", createdAt: T0 });
  insertAgent(db, { id: agentB, role: "quality_reviewer", specialization: null, displayName: "质检", createdAt: T0 });
});
afterEach(() => db.close());

function mkArtifact(kind: ArtifactKind, over: Partial<ArtifactRow> = {}): string {
  const id = `ar${++seq}`;
  insertArtifact(db, {
    id, projectId, conversationId: null, kind, status: "open", authorAgentId: agentA,
    title: `工件${seq}`, body: "正文", metadataJson: null,
    createdAt: T0 + seq, updatedAt: T0 + seq,
    ...over,
  });
  return id;
}

function mkWork(status: "open" | "in_progress" = "open"): string {
  const id = `wk${++seq}`;
  insertWork(db, {
    id, projectId, parentWorkId: null, title: `工作${seq}`, goal: "g",
    status, assigneeAgentId: agentA, createdAt: T0 + seq, updatedAt: T0 + seq,
  });
  return id;
}

// ── BC3 artifacts ───────────────────────────────────────────────

describe("BC3 · artifacts", () => {
  it("插入与读取", () => {
    const id = mkArtifact("evidence");
    expect(getArtifact(db, id)).toMatchObject({
      id, projectId, kind: "evidence", status: "open", authorAgentId: agentA,
    });
  });

  it("**作用域是 projectId 而非 conversationId** —— 同项目跨会话的工件都可见", () => {
    // 两条工件来自完全不同的会话(甚至没有会话),但同属一个项目
    mkArtifact("evidence", { conversationId: "conv-1" });
    mkArtifact("decision", { conversationId: "conv-2" });
    mkArtifact("note", { conversationId: null });

    // 按项目查得到全部三条 —— 这正是「对话活不过项目」的落地
    expect(listArtifacts(db, projectId)).toHaveLength(3);

    // 另一个项目查不到
    const other = `pj${++seq}`;
    insertProject(db, { id: other, name: "别的", client: "c", goal: "g", status: "active", createdAt: T0 });
    expect(listArtifacts(db, other)).toHaveLength(0);
  });

  it("非法 kind 被 CHECK 拒绝", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO artifacts (id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at)
         VALUES ('x',?,NULL,'made_up','open',?,'t','b',NULL,1,1)`,
      ).run(projectId, agentA),
    ).toThrow(/CHECK/i);
  });

  it("非法 status 被 CHECK 拒绝", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO artifacts (id,project_id,conversation_id,kind,status,author_agent_id,title,body,metadata_json,created_at,updated_at)
         VALUES ('x',?,NULL,'note','in_progress',?,'t','b',NULL,1,1)`,
      ).run(projectId, agentA),
    ).toThrow(/CHECK/i);
  });

  it("author 必须指向真实 agent(外键)", () => {
    expect(() => mkArtifact("note", { authorAgentId: "ghost" })).toThrow(/FOREIGN KEY/i);
  });

  it("listArtifacts 支持 kind / status / author / limit 过滤", () => {
    mkArtifact("evidence");
    mkArtifact("evidence", { status: "accepted" });
    mkArtifact("review_finding", { authorAgentId: agentB });

    expect(listArtifacts(db, projectId, { kind: "evidence" })).toHaveLength(2);
    expect(listArtifacts(db, projectId, { status: "accepted" })).toHaveLength(1);
    expect(listArtifacts(db, projectId, { authorAgentId: agentB })).toHaveLength(1);
    expect(listArtifacts(db, projectId, { limit: 2 })).toHaveLength(2);
  });

  it("listArtifacts 按 created_at 倒序(最近发生了什么)", () => {
    const older = mkArtifact("note");
    const newer = mkArtifact("note");
    const ids = listArtifacts(db, projectId).map((a) => a.id);
    expect(ids[0], "较新的排在前面").toBe(newer);
    expect(ids[1]).toBe(older);
  });

  it("setArtifactStatus / updateArtifactBody", () => {
    const id = mkArtifact("hypothesis");
    setArtifactStatus(db, id, "accepted", T0 + 500);
    updateArtifactBody(db, id, "改过的正文", T0 + 501);
    expect(getArtifact(db, id)).toMatchObject({
      status: "accepted", body: "改过的正文", updatedAt: T0 + 501,
    });
  });

  it("countArtifactsByKind 汇总", () => {
    mkArtifact("evidence"); mkArtifact("evidence"); mkArtifact("note");
    expect(countArtifactsByKind(db, projectId)).toEqual({ evidence: 2, note: 1 });
  });

  it("行 → 领域对象边界校验:数据库里出现未知 kind 会抛错", () => {
    const id = mkArtifact("note");
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE artifacts SET kind = 'bogus' WHERE id = ?`).run(id);
    db.pragma("ignore_check_constraints = OFF");
    expect(() => getArtifact(db, id)).toThrow(/未定义 kind/);
  });

  it("删项目级联带走工件", () => {
    mkArtifact("note");
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
    expect(listArtifacts(db, projectId)).toEqual([]);
  });
});

describe("BC3 · artifact_links", () => {
  it("加边与双向查询", () => {
    const q = mkArtifact("client_question");
    const d = mkArtifact("decision");
    expect(addArtifactLink(db, d, "answers", q)).toEqual({ ok: true });
    expect(listLinks(db, d, "answers")).toEqual([q]);
    expect(listBackLinks(db, q, "answers")).toEqual([d]);
  });

  it("自环被拒", () => {
    const a = mkArtifact("note");
    expect(addArtifactLink(db, a, "parent", a)).toEqual({ ok: false, reason: "self" });
  });

  it("重复边被拒", () => {
    const p = mkArtifact("project_brief");
    const c = mkArtifact("work_brief");
    addArtifactLink(db, c, "parent", p);
    expect(addArtifactLink(db, c, "parent", p)).toEqual({ ok: false, reason: "duplicate" });
  });

  it("指向不存在的工件被拒", () => {
    const a = mkArtifact("note");
    expect(addArtifactLink(db, a, "parent", "ghost")).toEqual({ ok: false, reason: "not_found" });
  });

  it("非法 rel 被 CHECK 拒绝", () => {
    const a = mkArtifact("note");
    const b = mkArtifact("note");
    expect(() =>
      db.prepare(`INSERT INTO artifact_links (artifact_id, rel, target_artifact_id) VALUES (?,?,?)`)
        .run(a, "blocks", b),
    ).toThrow(/CHECK/i);
  });

  it("同一条工件可以有多种 rel 指向同一目标", () => {
    const a = mkArtifact("note");
    const b = mkArtifact("note");
    addArtifactLink(db, a, "parent", b);
    addArtifactLink(db, a, "depends_on", b);
    expect(listLinks(db, a).sort()).toEqual([b, b]);
  });

  it("parentOf 过滤:列出某条工件的子件", () => {
    const parent = mkArtifact("project_brief");
    const c1 = mkArtifact("work_brief");
    const c2 = mkArtifact("work_brief");
    mkArtifact("work_brief"); // 无关的一条
    addArtifactLink(db, c1, "parent", parent);
    addArtifactLink(db, c2, "parent", parent);
    const kids = listArtifacts(db, projectId, { parentOf: parent }).map((a) => a.id).sort();
    expect(kids).toEqual([c1, c2].sort());
  });

  it("removeArtifactLink 生效", () => {
    const p = mkArtifact("note");
    const c = mkArtifact("note");
    addArtifactLink(db, c, "parent", p);
    removeArtifactLink(db, c, "parent", p);
    expect(listLinks(db, c)).toEqual([]);
  });

  it("删工件级联带走两侧的边", () => {
    const p = mkArtifact("note");
    const c = mkArtifact("note");
    addArtifactLink(db, c, "parent", p);
    db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(p);
    expect(listLinks(db, c)).toEqual([]);
  });
});

// ── BC4 blockers ────────────────────────────────────────────────

describe("BC4 · blockers", () => {
  function mkBlocker(over: Partial<Parameters<typeof insertBlocker>[1]> = {}): string {
    const id = `bl${++seq}`;
    insertBlocker(db, {
      id, projectId, raisedByAgentId: agentA, title: `阻塞${seq}`, detail: "细节",
      severity: "high", status: "open", createdAt: T0 + seq,
      ...over,
    });
    return id;
  }

  it("插入与读取", () => {
    const id = mkBlocker();
    expect(getBlocker(db, id)).toMatchObject({
      id, severity: "high", status: "open", resolvedAt: null, resolution: null,
    });
  });

  it("非法 severity / status 被 CHECK 拒绝", () => {
    expect(() => mkBlocker({ severity: "urgent" as never })).toThrow(/CHECK/i);
    expect(() => mkBlocker({ status: "pending" as never })).toThrow(/CHECK/i);
  });

  it("unresolvedOnly 只给 open 与 acknowledged", () => {
    mkBlocker({ status: "open" });
    mkBlocker({ status: "acknowledged" });
    mkBlocker({ status: "resolved", resolvedAt: T0, resolution: "已修" });
    mkBlocker({ status: "deferred", resolvedAt: T0, resolution: "搁置" });
    mkBlocker({ status: "rejected", resolvedAt: T0, resolution: "不成立" });

    expect(listBlockers(db, projectId)).toHaveLength(5);
    expect(listBlockers(db, projectId, { unresolvedOnly: true })).toHaveLength(2);
  });

  it("按 severity 排序是 critical → low,不是字典序", () => {
    mkBlocker({ severity: "low" });
    mkBlocker({ severity: "critical" });
    mkBlocker({ severity: "medium" });
    mkBlocker({ severity: "high" });
    expect(listBlockers(db, projectId).map((b) => b.severity)).toEqual([
      "critical", "high", "medium", "low",
    ]);
  });

  it("落终态必须给 resolution —— 否则事后看不出当时怎么处理的", () => {
    const id = mkBlocker();
    for (const st of ["resolved", "rejected", "deferred"] as const) {
      expect(() => setBlockerStatus(db, id, st, T0 + 1)).toThrow(/必须给 resolution/);
      expect(() => setBlockerStatus(db, id, st, T0 + 1, "   ")).toThrow(/必须给 resolution/);
    }
  });

  it("落终态记录 resolvedAt 与 resolution", () => {
    const id = mkBlocker();
    setBlockerStatus(db, id, "resolved", T0 + 88, "补上了缺失的依赖");
    expect(getBlocker(db, id)).toMatchObject({
      status: "resolved", resolvedAt: T0 + 88, resolution: "补上了缺失的依赖",
    });
  });

  it("从终态退回非终态会清掉 resolvedAt / resolution(不留矛盾状态)", () => {
    const id = mkBlocker();
    setBlockerStatus(db, id, "resolved", T0 + 88, "已修");
    setBlockerStatus(db, id, "open", T0 + 99);
    expect(getBlocker(db, id)).toMatchObject({ status: "open", resolvedAt: null, resolution: null });
  });

  it("acknowledged 不需要 resolution(它还不是终态)", () => {
    const id = mkBlocker();
    expect(() => setBlockerStatus(db, id, "acknowledged", T0 + 1)).not.toThrow();
  });

  it("isUnresolvedBlocker 与 unresolvedOnly 语义一致", () => {
    for (const s of ["open", "acknowledged"] as const) expect(isUnresolvedBlocker(s)).toBe(true);
    for (const s of ["resolved", "deferred", "rejected"] as const) {
      expect(isUnresolvedBlocker(s)).toBe(false);
    }
  });

  it("守卫与 schema 闭集一致", () => {
    for (const s of ["open", "acknowledged", "resolved", "deferred", "rejected"]) {
      expect(isBlockerStatus(s)).toBe(true);
    }
    for (const s of ["low", "medium", "high", "critical"]) {
      expect(isBlockerSeverity(s)).toBe(true);
    }
    expect(isBlockerStatus("pending")).toBe(false);
    expect(isBlockerSeverity("urgent")).toBe(false);
  });
});

describe("BC4 · blocker_blocks(设计 §8.1 原本缺这张表)", () => {
  function mkBlocker(): string {
    const id = `bl${++seq}`;
    insertBlocker(db, {
      id, projectId, raisedByAgentId: agentA, title: `阻塞${seq}`, detail: "d",
      severity: "critical", status: "open", createdAt: T0 + seq,
    });
    return id;
  }

  it("登记与查询:这个阻塞挡住了谁", () => {
    const b = mkBlocker();
    const w1 = mkWork(), w2 = mkWork();
    blockWork(db, b, w1);
    blockWork(db, b, w2);
    expect(listBlockedWorks(db, b).sort()).toEqual([w1, w2].sort());
  });

  it("**反向查询:这条工作项被哪些未解决阻塞挡着** —— 「未解决阻塞反馈给用户」的入口", () => {
    const b1 = mkBlocker();
    const b2 = mkBlocker();
    const w = mkWork();
    blockWork(db, b1, w);
    blockWork(db, b2, w);
    expect(blockersForWork(db, w).map((b) => b.id).sort()).toEqual([b1, b2].sort());

    // 解掉一个 → 只剩一个
    setBlockerStatus(db, b1, "resolved", T0 + 1, "已修");
    expect(blockersForWork(db, w).map((b) => b.id)).toEqual([b2]);

    // 全解掉 → 空
    setBlockerStatus(db, b2, "rejected", T0 + 2, "不成立");
    expect(blockersForWork(db, w)).toEqual([]);
  });

  it("acknowledged 仍算挡着,deferred 不算", () => {
    const b = mkBlocker();
    const w = mkWork();
    blockWork(db, b, w);
    setBlockerStatus(db, b, "acknowledged", T0 + 1);
    expect(blockersForWork(db, w)).toHaveLength(1);
    setBlockerStatus(db, b, "deferred", T0 + 2, "先搁置");
    expect(blockersForWork(db, w)).toEqual([]);
  });

  it("重复登记是幂等的(ON CONFLICT DO NOTHING)", () => {
    const b = mkBlocker();
    const w = mkWork();
    blockWork(db, b, w);
    blockWork(db, b, w);
    expect(listBlockedWorks(db, b)).toEqual([w]);
  });

  it("unblockWork 生效", () => {
    const b = mkBlocker();
    const w = mkWork();
    blockWork(db, b, w);
    unblockWork(db, b, w);
    expect(listBlockedWorks(db, b)).toEqual([]);
  });

  it("删工作项 / 删阻塞都级联带走关联", () => {
    const b1 = mkBlocker(), b2 = mkBlocker();
    const w = mkWork();
    blockWork(db, b1, w);
    blockWork(db, b2, w);
    db.prepare(`DELETE FROM works WHERE id = ?`).run(w);
    expect(listBlockedWorks(db, b1)).toEqual([]);
    expect(listBlockedWorks(db, b2)).toEqual([]);
  });
});

// ── BC4 change_requests ─────────────────────────────────────────

describe("BC4 · change_requests", () => {
  function mkChange(over: Partial<Parameters<typeof insertChange>[1]> = {}): string {
    const id = `ch${++seq}`;
    insertChange(db, {
      id, projectId, title: `变更${seq}`, rationale: "因为所以", impactJson: null,
      createdAt: T0 + seq,
      ...over,
    });
    return id;
  }

  it("插入默认 proposed", () => {
    const id = mkChange();
    expect(getChange(db, id)).toMatchObject({ status: "proposed", decidedAt: null });
  });

  it("非法 status 被 CHECK 拒绝", () => {
    expect(() => mkChange({ status: "doing" as never })).toThrow(/CHECK/i);
  });

  it("合法迁移链 proposed → under_review → accepted → implemented", () => {
    const id = mkChange();
    expect(transitionChange(db, id, "under_review", T0 + 1, agentB)).toEqual({ ok: true });
    expect(transitionChange(db, id, "accepted", T0 + 2, agentB)).toEqual({ ok: true });
    expect(transitionChange(db, id, "implemented", T0 + 3, agentA)).toEqual({ ok: true });
    expect(getChange(db, id)!.status).toBe("implemented");
  });

  it("**proposed 不能直接跳 implemented** —— 没评审就实施是这类流程最典型的漏洞", () => {
    const id = mkChange();
    const r = transitionChange(db, id, "implemented", T0 + 1, agentA);
    expect(r).toEqual({ ok: false, reason: "illegal_transition", from: "proposed" });
    expect(getChange(db, id)!.status, "非法迁移不该写库").toBe("proposed");
  });

  it("终态不可再流转", () => {
    const id = mkChange();
    transitionChange(db, id, "rejected", T0 + 1, agentB);
    expect(isChangeTerminal("rejected")).toBe(true);
    expect(transitionChange(db, id, "under_review", T0 + 2, agentB)).toMatchObject({
      ok: false, reason: "illegal_transition",
    });
  });

  it("评审类迁移必须记决定人(没有决定人的结论 = 没人负责)", () => {
    const id = mkChange();
    // 先合法地进 under_review —— 从 proposed 直接 accepted 是另一条规则(见下一个用例)
    expect(transitionChange(db, id, "under_review", T0 + 1)).toEqual({ ok: true });
    expect(transitionChange(db, id, "accepted", T0 + 2)).toEqual({
      ok: false, reason: "missing_decider",
    });
    expect(transitionChange(db, id, "accepted", T0 + 2, "")).toEqual({
      ok: false, reason: "missing_decider",
    });
    // 给了决定人就能过
    expect(transitionChange(db, id, "accepted", T0 + 3, agentB)).toEqual({ ok: true });
  });

  it("非法迁移优先于缺决定人报出(修决定人也救不了一条走不通的路)", () => {
    const id = mkChange();
    // proposed 直接 accepted:既非法迁移、又没给决定人 —— 应报更根本的那个
    expect(transitionChange(db, id, "accepted", T0 + 1)).toMatchObject({
      ok: false, reason: "illegal_transition",
    });
  });

  it("不存在的变更 → not_found", () => {
    expect(transitionChange(db, "ghost", "under_review", T0, agentA)).toEqual({
      ok: false, reason: "not_found",
    });
  });

  it("canTransition 白名单与实现一致", () => {
    expect(canTransition("proposed", "under_review")).toBe(true);
    expect(canTransition("proposed", "implemented")).toBe(false);
    expect(canTransition("under_review", "accepted")).toBe(true);
    expect(canTransition("accepted", "implemented")).toBe(true);
    expect(canTransition("implemented", "rejected")).toBe(false);
  });

  it("listChanges 可按状态过滤", () => {
    mkChange();
    const id2 = mkChange();
    transitionChange(db, id2, "rejected", T0 + 99, agentB);
    expect(listChanges(db, projectId)).toHaveLength(2);
    expect(listChanges(db, projectId, { status: "rejected" }).map((c) => c.id)).toEqual([id2]);
  });

  it("isChangeStatus 闭集", () => {
    for (const s of ["proposed", "under_review", "accepted", "implemented", "rejected"]) {
      expect(isChangeStatus(s)).toBe(true);
    }
    expect(isChangeStatus("doing")).toBe(false);
  });
});

describe("BC4 · change_affects(取代不可查的 affected_work_ids_json)", () => {
  function mkChange(): string {
    const id = `ch${++seq}`;
    insertChange(db, {
      id, projectId, title: `变更${seq}`, rationale: "r", impactJson: null, createdAt: T0 + seq,
    });
    return id;
  }

  it("登记与双向查询", () => {
    const c = mkChange();
    const w1 = mkWork(), w2 = mkWork();
    affectWork(db, c, w1);
    affectWork(db, c, w2);
    expect(listAffectedWorks(db, c).sort()).toEqual([w1, w2].sort());
    expect(changesForWork(db, w1).map((x) => x.id)).toEqual([c]);
  });

  it("**「哪些变更影响了这条工作项」在 SQL 层问得出来** —— 这正是 JSON 列做不到的", () => {
    const c1 = mkChange(), c2 = mkChange();
    const w = mkWork();
    affectWork(db, c1, w);
    affectWork(db, c2, w);
    const changes = changesForWork(db, w);
    expect(changes.map((x) => x.id).sort()).toEqual([c1, c2].sort());
    expect(changes[0]!.status).toBe("proposed");
  });

  it("重复登记幂等;unaffectedWork 生效", () => {
    const c = mkChange();
    const w = mkWork();
    affectWork(db, c, w);
    affectWork(db, c, w);
    expect(listAffectedWorks(db, c)).toEqual([w]);
    unaffectedWork(db, c, w);
    expect(listAffectedWorks(db, c)).toEqual([]);
  });

  it("删变更加级联带走关联", () => {
    const c = mkChange();
    const w = mkWork();
    affectWork(db, c, w);
    db.prepare(`DELETE FROM change_requests WHERE id = ?`).run(c);
    expect(changesForWork(db, w)).toEqual([]);
  });

  it("删工作项级联带走关联", () => {
    const c = mkChange();
    const w = mkWork();
    affectWork(db, c, w);
    db.prepare(`DELETE FROM works WHERE id = ?`).run(w);
    expect(listAffectedWorks(db, c)).toEqual([]);
  });
});

// ── 跨 BC 接缝 ──────────────────────────────────────────────────

describe("跨 BC · 阻塞 + 变更 + 工件 一起回答「这个项目现在什么状况」", () => {
  it("未解决阻塞能定位到具体工作项,而不只是一个计数", () => {
    const w1 = mkWork("in_progress");
    const w2 = mkWork("in_progress");

    insertBlocker(db, {
      id: "b-critical", projectId, raisedByAgentId: agentA, title: "缺依赖",
      detail: "上游包没发", severity: "critical", status: "open", createdAt: T0,
    });
    insertBlocker(db, {
      id: "b-low", projectId, raisedByAgentId: agentB, title: "文档待补",
      detail: "README 没写", severity: "low", status: "open", createdAt: T0,
    });
    blockWork(db, "b-critical", w1);
    blockWork(db, "b-low", w2);

    // 项目级:未解决阻塞按严重度排
    const unresolved = listBlockers(db, projectId, { unresolvedOnly: true });
    expect(unresolved.map((b) => b.id)).toEqual(["b-critical", "b-low"]);

    // 工作项级:哪件事被卡住、被什么卡住
    expect(blockersForWork(db, w1).map((b) => b.title)).toEqual(["缺依赖"]);
    expect(blockersForWork(db, w2).map((b) => b.title)).toEqual(["文档待补"]);
  });

  it("需求变更能追溯到受影响的工作项与它的产出", () => {
    const w = mkWork("in_progress");
    const ev = mkArtifact("evidence", { title: "实现证据" });

    insertChange(db, {
      id: "ch-1", projectId, title: "加一个字段", rationale: "甲方要求",
      impactJson: JSON.stringify(["schema", "前端"]), createdAt: T0,
    });
    affectWork(db, "ch-1", w);

    expect(listAffectedWorks(db, "ch-1")).toEqual([w]);
    expect(changesForWork(db, w).map((c) => c.title)).toEqual(["加一个字段"]);
    expect(getArtifact(db, ev)!.title).toBe("实现证据");
  });
});
