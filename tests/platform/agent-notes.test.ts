/**
 * 经验库(migration 040,2026-11-28)· 回归 —— 仓储与四个工具
 *
 * ── 这一文件守的是五条硬要求 ───────────────────────────────────
 *
 *   ① **按角色隔离**:一个角色只检索得到、读得到、改得到自己的条目;别人的条目与
 *      「不存在」长得一样(不暴露存在性)。
 *   ② **调研必须带出处**:没有 source 的 research 一行都不写。
 *   ③ **退休 = 不再冒出来,但读得到、救得活**。
 *   ④ **写库函数的返回值不许丢**:改一条不存在的、退休一条已退休的,都如实报失败。
 *   ⑤ **闭集之外的值读到就抛**:不把一行坏数据归到某一类。
 *
 * 每轮注入在 `own-kit-context.test.ts`;仓库那半边在 `own-repo.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import {
  AGENT_NOTE_KINDS, countActiveAgentNotes, countAgentNotesByKind, getAgentNote, insertAgentNote,
  listAgentNotes, retireAgentNote, searchAgentNotes, updateAgentNote,
} from "../../src/platform/storage/repo/agentNotes.js";
import { EXPERIENCE_MAX_ACTIVE } from "../../src/platform/tools/experience.js";
import { buildMatchQuery } from "../../src/platform/knowledge/query.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import { solveToolset } from "../../src/platform/harness/authorize.js";
import { CAPABILITY_TOOLS } from "../../src/platform/harness/capability.js";
import { PROJECT_ROLES, ROLE_SPECS } from "../../src/platform/identity/role.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";

let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  ensureOrg(db, clock);
  // 经验库不按项目限定,但 `experience.*` 不在接待能力清单里(三个执行角色从不在接待阶段
  // 跑回合)—— 所以工具测试要在一个真项目里调。
  insertProject(db, { id: "p1", name: "项目一", client: "甲", goal: "g", status: "active", createdAt: clock });
  ensureProjectOrg(db, "p1", clock);
  seq = 0;
});
afterEach(() => db.close());

const AGENT_OF: Readonly<Record<(typeof PROJECT_ROLES)[number], string>> = {
  business_manager: "bm", project_manager: "pm", research_worker: "wk", coding_worker: "cw", quality_reviewer: "qa",
};

function ctx(agentId: string): ToolRunContext {
  const agent = getAgent(db, agentId);
  if (agent === null) throw new Error(`夹具里没有 agent ${agentId}`);
  return { db, agent, project: loadProjectForAuthz(db, "p1"), now: () => clock, newId: (p) => `${p}_${++seq}` };
}
function call(tool: string, args: Record<string, unknown>, agentId: string): ToolResult {
  const r = dispatch(tool, args, ctx(agentId));
  if (r instanceof Promise) throw new Error("sync only");
  return r;
}
function okText(r: ToolResult): string {
  if (!r.ok) throw new Error(`期望成功,实际失败:${r.code} ${r.message}`);
  return r.text;
}
/** 从工具返回文本里抠 id(`已记下 an_3「…」`)。 */
function idOf(r: ToolResult): string {
  const m = /an_\d+/.exec(okText(r));
  if (m === null) throw new Error(`返回文本里没有 id:${okText(r)}`);
  return m[0];
}

// ── 仓储 ────────────────────────────────────────────────────────

describe("agent_notes · 仓储", () => {
  it("写入后读得回,预分词列按 bigram 落下来", () => {
    insertAgentNote(db, {
      id: "an_1", agentId: "wk", now: clock,
      note: { kind: "lesson", title: "报告先列数据", content: "这类报告先列数据再下结论", source: null, sourceProjectId: null },
    });
    const n = getAgentNote(db, "an_1");
    expect(n).not.toBeNull();
    expect(n?.kind).toBe("lesson");
    expect(n?.status).toBe("active");
    expect(n?.seg).toContain("报告");
    expect(n?.seg).toContain("先列");
  });

  it("中文按相邻两字检索得到;无关的词检索不到", () => {
    insertAgentNote(db, { id: "an_1", agentId: "wk", now: clock, note: { kind: "lesson", title: "接口重试", content: "那个接口要带指数退避重试", source: null, sourceProjectId: null } });
    insertAgentNote(db, { id: "an_2", agentId: "wk", now: clock, note: { kind: "research", title: "docker 网络", content: "bridge 网络模式下容器间用名字互相访问", source: "https://docs.docker.com", sourceProjectId: null } });
    const hits = searchAgentNotes(db, buildMatchQuery("重试")!, { agentId: "wk" }).map((h) => h.note.id);
    expect(hits).toEqual(["an_1"]);
    expect(searchAgentNotes(db, buildMatchQuery("docker")!, { agentId: "wk" }).map((h) => h.note.id)).toEqual(["an_2"]);
    expect(searchAgentNotes(db, buildMatchQuery("量子纠缠")!, { agentId: "wk" })).toEqual([]);
  });

  it("① 隔离:别人的条目搜不到(agentId 必传,且只认它)", () => {
    insertAgentNote(db, { id: "an_1", agentId: "wk", now: clock, note: { kind: "lesson", title: "接口重试", content: "那个接口要带重试", source: null, sourceProjectId: null } });
    expect(searchAgentNotes(db, buildMatchQuery("重试")!, { agentId: "cw" })).toEqual([]);
    expect(listAgentNotes(db, { agentId: "cw" })).toEqual([]);
    expect(listAgentNotes(db, { agentId: "wk" }).map((n) => n.id)).toEqual(["an_1"]);
  });

  it("③ 退休:不再被检索到;读得到;重复退休返回 false;改写会救活", () => {
    insertAgentNote(db, { id: "an_1", agentId: "wk", now: clock, note: { kind: "lesson", title: "旧做法", content: "以前这么干", source: null, sourceProjectId: null } });
    expect(retireAgentNote(db, "an_1", "已过时", clock)).toBe(true);
    expect(getAgentNote(db, "an_1")?.status).toBe("retired");
    expect(getAgentNote(db, "an_1")?.retireReason).toBe("已过时");
    expect(searchAgentNotes(db, buildMatchQuery("以前")!, { agentId: "wk" })).toEqual([]);
    // ④ 已退休再退休不算成功
    expect(retireAgentNote(db, "an_1", "再来一次", clock)).toBe(false);
    expect(retireAgentNote(db, "an_nope", "x", clock)).toBe(false);
    // 人读面显式要 all 才连退休的一起列
    expect(listAgentNotes(db, { agentId: "wk" })).toEqual([]);
    expect(listAgentNotes(db, { agentId: "wk", status: "all" }).map((n) => n.id)).toEqual(["an_1"]);
    // 改写救活
    expect(updateAgentNote(db, "an_1", { kind: "lesson", title: "新做法", content: "现在这么干", source: null, sourceProjectId: null }, clock + 1)).toBe(true);
    const n = getAgentNote(db, "an_1");
    expect(n?.status).toBe("active");
    expect(n?.retireReason).toBeNull();
    expect(searchAgentNotes(db, buildMatchQuery("现在")!, { agentId: "wk" }).map((h) => h.note.id)).toEqual(["an_1"]);
  });

  it("④ 改一条不存在的返回 false;FTS 在改写与删除后跟着变(旧词不再命中)", () => {
    expect(updateAgentNote(db, "an_nope", { kind: "lesson", title: "t", content: "c", source: null, sourceProjectId: null }, clock)).toBe(false);
    insertAgentNote(db, { id: "an_1", agentId: "wk", now: clock, note: { kind: "lesson", title: "甲词", content: "全是甲词", source: null, sourceProjectId: null } });
    expect(searchAgentNotes(db, buildMatchQuery("甲词")!, { agentId: "wk" })).toHaveLength(1);
    updateAgentNote(db, "an_1", { kind: "lesson", title: "乙词", content: "全是乙词", source: null, sourceProjectId: null }, clock + 1);
    expect(searchAgentNotes(db, buildMatchQuery("甲词")!, { agentId: "wk" })).toEqual([]);
    expect(searchAgentNotes(db, buildMatchQuery("乙词")!, { agentId: "wk" })).toHaveLength(1);
  });

  it("条数与按类型计数;limit 与 kind 过滤", () => {
    for (const [i, kind] of (["lesson", "research", "research"] as const).entries()) {
      insertAgentNote(db, { id: `an_${i}`, agentId: "wk", now: clock + i, note: { kind, title: `条目${i}`, content: "共同关键词 部署", source: kind === "research" ? "书" : null, sourceProjectId: null } });
    }
    expect(countActiveAgentNotes(db, "wk")).toBe(3);
    expect(countAgentNotesByKind(db, "wk")).toEqual({ lesson: 1, research: 2 });
    expect(searchAgentNotes(db, buildMatchQuery("部署")!, { agentId: "wk", limit: 2 })).toHaveLength(2);
    expect(searchAgentNotes(db, buildMatchQuery("部署")!, { agentId: "wk", kind: "research" })).toHaveLength(2);
    expect(searchAgentNotes(db, buildMatchQuery("部署")!, { agentId: "wk", kind: "lesson" })).toHaveLength(1);
    // 人读面按改的时间倒序
    expect(listAgentNotes(db, { agentId: "wk" }).map((n) => n.id)).toEqual(["an_2", "an_1", "an_0"]);
  });

  it("⑤ 闭集之外的值读到就抛(不归到任何一类)", () => {
    db.prepare(
      `INSERT INTO agent_notes (id, agent_id, kind, title, content, source, source_project_id, seg, status, created_at, updated_at)
       VALUES ('an_bad', 'wk', 'gossip', 't', 'c', NULL, NULL, '', 'active', 1, 1)`,
    ).run();
    expect(() => getAgentNote(db, "an_bad")).toThrow(/gossip/);
    expect(() => countAgentNotesByKind(db, "wk")).toThrow(/gossip/);
    expect(AGENT_NOTE_KINDS).toEqual(["lesson", "research"]);
  });
});

// ── 工具 ────────────────────────────────────────────────────────

describe("experience_save · 记一条", () => {
  it("经验条目不带出处也行;调研条目**必须**带出处", () => {
    const okR = call("experience_save", { kind: "lesson", title: "报告先列数据", content: "先列数据再下结论" }, "wk");
    expect(okR.ok).toBe(true);
    const noSource = call("experience_save", { kind: "research", title: "某站要 referer", content: "不带 referer 打不开" }, "wk");
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) {
      expect(noSource.code).toBe("invalid_args");
      expect(noSource.message).toContain("source");
    }
    // 一行都没写
    expect(searchAgentNotes(db, buildMatchQuery("referer")!, { agentId: "wk" })).toEqual([]);
  });

  it("参数校验:类型不在闭集(带合法清单)、标题过长、正文过长、正文为空", () => {
    const badKind = call("experience_save", { kind: "gossip", title: "t", content: "c" }, "wk");
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.alternatives).toEqual(["lesson", "research"]);
    expect(call("experience_save", { kind: "lesson", title: "标".repeat(81), content: "c" }, "wk").ok).toBe(false);
    expect(call("experience_save", { kind: "lesson", title: "t", content: "字".repeat(8001) }, "wk").ok).toBe(false);
    expect(call("experience_save", { kind: "lesson", title: "t", content: "   " }, "wk").ok).toBe(false);
    expect(countActiveAgentNotes(db, "wk")).toBe(0);
  });

  it("① 别人的 noteId 与不存在的 noteId 得到**同一句**失败(不暴露存在性)", () => {
    const cwId = idOf(call("experience_save", { kind: "lesson", title: "cw 的", content: "别人的条目" }, "cw"));
    const asWk = call("experience_save", { kind: "lesson", title: "改", content: "改", noteId: cwId }, "wk");
    const asMissing = call("experience_save", { kind: "lesson", title: "改", content: "改", noteId: "an_nope" }, "wk");
    expect(asWk.ok).toBe(false);
    expect(asMissing.ok).toBe(false);
    if (!asWk.ok && !asMissing.ok) expect(asWk.message.replace(cwId, "X")).toBe(asMissing.message.replace("an_nope", "X"));
    expect(getAgentNote(db, cwId)?.title).toBe("cw 的");
  });

  it("改写:内容替换、退休的救活(并如实说出来)", () => {
    const id = idOf(call("experience_save", { kind: "lesson", title: "旧", content: "旧内容" }, "wk"));
    call("experience_retire", { noteId: id, reason: "过时" }, "wk");
    const r = call("experience_save", { kind: "lesson", title: "新", content: "新内容", noteId: id }, "wk");
    expect(r.ok).toBe(true);
    expect(okText(r)).toContain("重新生效");
    expect(getAgentNote(db, id)).toMatchObject({ title: "新", content: "新内容", status: "active" });
    expect(countActiveAgentNotes(db, "wk")).toBe(1);
  });

  it(`在用条目到上限(${EXPERIENCE_MAX_ACTIVE})后拒收,并指向「先退休旧的」`, () => {
    for (let i = 0; i < EXPERIENCE_MAX_ACTIVE; i += 1) {
      // id 用另一个前缀:工具生成的 id 是 `an_<序号>`,撞了会是一次 UNIQUE 冲突(夹具 bug,不是被测行为)
      insertAgentNote(db, { id: `anfix_${i}`, agentId: "wk", now: clock, note: { kind: "lesson", title: `t${i}`, content: "c", source: null, sourceProjectId: null } });
    }
    const r = call("experience_save", { kind: "lesson", title: "多出来的", content: "c" }, "wk");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("conflict");
      expect(r.message).toContain("experience_retire");
    }
    // 退休一条之后就能记了(先断言真的退休了 —— 夹具自己也不能静默没生效)
    expect(retireAgentNote(db, "anfix_0", "x", clock)).toBe(true);
    expect(call("experience_save", { kind: "lesson", title: "多出来的", content: "c" }, "wk").ok).toBe(true);
  });
});

describe("experience_retire · 退休一条", () => {
  it("要写原因;只能退休自己的;重复退休如实报冲突", () => {
    const id = idOf(call("experience_save", { kind: "lesson", title: "t", content: "c" }, "wk"));
    expect(call("experience_retire", { noteId: id, reason: "  " }, "wk").ok).toBe(false);
    expect(call("experience_retire", { noteId: id, reason: "不是你的" }, "cw").ok).toBe(false);
    expect(getAgentNote(db, id)?.status).toBe("active");
    expect(call("experience_retire", { noteId: id, reason: "记错了" }, "wk").ok).toBe(true);
    const again = call("experience_retire", { noteId: id, reason: "再来" }, "wk");
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.code).toBe("conflict");
      expect(again.message).toContain("记错了");
    }
  });
});

describe("experience_search / experience_read · 查与读", () => {
  it("查询词太短拒收;库是空的与「没命中」是两句不同的话", () => {
    expect(call("experience_search", { query: "a" }, "wk").ok).toBe(false);
    expect(call("experience_search", { query: "。。" }, "wk").ok).toBe(false);
    const empty = okText(call("experience_search", { query: "部署" }, "wk"));
    expect(empty).toContain("还是空的");
    call("experience_save", { kind: "lesson", title: "接口重试", content: "那个接口要带重试" }, "wk");
    const miss = okText(call("experience_search", { query: "量子纠缠" }, "wk"));
    expect(miss).toContain("没有匹配");
    expect(miss).not.toContain("还是空的");
  });

  it("命中带类型标签、摘录与 noteId;type 过滤生效;limit 有上限", () => {
    call("experience_save", { kind: "lesson", title: "接口重试", content: "那个接口要带重试" }, "wk");
    call("experience_save", { kind: "research", title: "重试的论文", content: "某论文说重试要加抖动", source: "doi:10.1/x" }, "wk");
    const both = okText(call("experience_search", { query: "重试" }, "wk"));
    expect(both).toContain("命中 2 条");
    expect(both).toContain("[经验]《接口重试》");
    expect(both).toContain("[调研]《重试的论文》");
    expect(both).toContain("出处:doi:10.1/x");
    expect(both).toContain("experience_read");
    const onlyResearch = okText(call("experience_search", { query: "重试", kind: "research" }, "wk"));
    expect(onlyResearch).toContain("命中 1 条");
    expect(call("experience_search", { query: "重试", kind: "gossip" }, "wk").ok).toBe(false);
    // limit 再大也不超过 20:先灌 25 条
    for (let i = 0; i < 25; i += 1) insertAgentNote(db, { id: `an_x${i}`, agentId: "wk", now: clock, note: { kind: "lesson", title: `批量${i}`, content: "重试", source: null, sourceProjectId: null } });
    expect(okText(call("experience_search", { query: "重试", limit: 999 }, "wk"))).toContain("命中 20 条");
  });

  it("① 读:只读得到自己的;退休的读得到并写明状态与原因", () => {
    const wkId = idOf(call("experience_save", { kind: "lesson", title: "接口重试", content: "那个接口要带重试" }, "wk"));
    expect(call("experience_read", { noteId: wkId }, "cw").ok).toBe(false);
    const live = okText(call("experience_read", { noteId: wkId }, "wk"));
    expect(live).toContain("状态:在用");
    expect(live).toContain("那个接口要带重试");
    call("experience_retire", { noteId: wkId, reason: "后来发现不用" }, "wk");
    const retired = okText(call("experience_read", { noteId: wkId }, "wk"));
    expect(retired).toContain("已退休");
    expect(retired).toContain("后来发现不用");
  });
});

describe("经验库 · 能力面", () => {
  it("三个执行角色都拿得到四个工具;业务经理与项目经理一个都没有", () => {
    for (const role of PROJECT_ROLES) {
      const r = solveToolset(getAgent(db, AGENT_OF[role])!, loadProjectForAuthz(db, "p1"));
      const has = r.tools.includes("experience_save");
      expect(has, `${role}`).toBe(role === "research_worker" || role === "coding_worker" || role === "quality_reviewer");
    }
    expect(CAPABILITY_TOOLS["experience.read"]).toEqual(["experience_search", "experience_read"]);
    expect(CAPABILITY_TOOLS["experience.write"]).toEqual(["experience_save", "experience_retire"]);
  });

  it("派发器再判一次:业务经理直接调 experience_save 被拒(旧会话也拦得住)", () => {
    const r = call("experience_save", { kind: "lesson", title: "t", content: "c" }, "bm");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("denied");
    expect(countActiveAgentNotes(db, "bm")).toBe(0);
  });

  it("来源项目缺省取当前项目;显式给了就用显式的;改写时不给则沿用原条目的", () => {
    const r = call("experience_save", { kind: "lesson", title: "t", content: "在项目一里学的" }, "wk");
    expect(r.ok).toBe(true);
    const id = idOf(r);
    expect(getAgentNote(db, id)?.sourceProjectId).toBe("p1");
    // 显式给一个库里没有的项目 ⇒ 拒收(而不是让外键在底下炸)
    const ghost = call("experience_save", { kind: "lesson", title: "t", content: "c", sourceProjectId: "pj_ghost" }, "wk");
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.code).toBe("not_found");
    insertProject(db, { id: "pj_other", name: "项目二", client: "甲", goal: "g", status: "active", createdAt: clock });
    const explicit = idOf(call("experience_save", { kind: "lesson", title: "t", content: "c", sourceProjectId: "pj_other" }, "wk"));
    expect(getAgentNote(db, explicit)?.sourceProjectId).toBe("pj_other");
    call("experience_save", { kind: "lesson", title: "t2", content: "改写", noteId: explicit }, "wk");
    expect(getAgentNote(db, explicit)?.sourceProjectId).toBe("pj_other");
    // 这两条能力不按项目限定(收口后仍在)、也不在接待能力清单里(接待阶段拿不到)
    for (const role of PROJECT_ROLES) {
      expect(ROLE_SPECS[role].ceiling.includes("experience.read")).toBe(role !== "business_manager" && role !== "project_manager");
    }
    const intake = solveToolset(getAgent(db, "wk")!, null);
    expect(intake.tools).not.toContain("experience_save");
    expect(intake.tools).not.toContain("own_write");
  });
});
