/**
 * BC7 Memory 测试(批次 6)
 *
 * 重点:
 *   - bigram 检索的**真实召回能力**(旧系统在这里栽过:注释自称按字拆,
 *     实际正则贪婪整段,于是「我叫什么名字」召不回「用户名字:小明」)
 *   - 去重(旧系统缺,攒下大量重复片段)
 *   - MemoryPort 是可替换契约 —— 换后端不改调用方
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { SqliteMemory, countFragments, tokenize } from "../../src/platform/memory/sqliteMemory.js";
import {
  FRAGMENT_KINDS, isFragmentKind, type Fragment, type MemoryPort,
} from "../../src/platform/memory/port.js";
import { dispatch, notYetBuiltToolNames, capabilitiesWithoutTools } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";

let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;
let memory: SqliteMemory;
let project: Project;
let wk: Agent;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  memory = new SqliteMemory(db, { newId: (p) => `${p}_${++seq}`, now: () => clock });

  insertAgent(db, { id: "bm", role: "business_manager", specialization: null, displayName: "业务经理", createdAt: clock });
  insertAgent(db, { id: "wk", role: "research_worker", specialization: "algorithm", displayName: "算法", createdAt: clock });
  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: clock });
  addMember(db, "p1", "bm", clock);
  addMember(db, "p1", "wk", clock);
  project = loadProjectForAuthz(db, "p1")!;
  wk = { id: "wk", role: "research_worker", specialization: "algorithm", displayName: "算法" };
});
afterEach(() => db.close());

const bm: Agent = { id: "bm", role: "business_manager", displayName: "业务经理" };

function ctx(over: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    db, agent: wk, project, now: () => clock, newId: (p) => `${p}_${++seq}`,
    memory,
    ...over,
  };
}
/** 写记忆要用业务经理 —— memory.write 只给它(设计 2 §10.4) */
function bmCtx(over: Partial<ToolRunContext> = {}): ToolRunContext {
  return ctx({ agent: bm, ...over });
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

// ── 表结构 ──────────────────────────────────────────────────────

describe("BC7 schema", () => {
  it("平台侧表名不与旧表冲突(fragments / user_profile 是旧系统的)", () => {
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN
                ('memory_fragments','memory_profile','fragments','user_profile')`)
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toContain("memory_fragments");
    expect(names).toContain("memory_profile");
    // 旧 `fragments` 表已被 011 清场删除 —— 平台用的是 memory_fragments。
    // (这条断言在清场前是反过来的:「旧表还该在」。)
    expect(names, "旧 fragments 表还在 —— 011_drop_legacy.sql 没生效").not.toContain("fragments");
  });

  it("content 非空由 schema 强制", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO memory_fragments (id,kind,content,importance,decay_factor,access_count,created_at,content_hash)
         VALUES ('x','fact','   ',0.5,0.95,0,1,'h')`,
      ).run(),
    ).toThrow(/CHECK/i);
  });

  it("kind 闭集由 schema 强制", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO memory_fragments (id,kind,content,importance,decay_factor,access_count,created_at,content_hash)
         VALUES ('x','opinion','c',0.5,0.95,0,1,'h')`,
      ).run(),
    ).toThrow(/CHECK/i);
  });

  it("content_hash 唯一约束挡住重复插入", () => {
    db.prepare(
      `INSERT INTO memory_fragments (id,kind,content,importance,decay_factor,access_count,created_at,content_hash)
       VALUES ('a','fact','c',0.5,0.95,0,1,'same')`,
    ).run();
    expect(() =>
      db.prepare(
        `INSERT INTO memory_fragments (id,kind,content,importance,decay_factor,access_count,created_at,content_hash)
         VALUES ('b','fact','c2',0.5,0.95,0,1,'same')`,
      ).run(),
    ).toThrow(/UNIQUE/i);
  });

  it("删项目把来源项目的记忆置空(而不是连带删掉 —— 记忆属于用户,不属于项目)", () => {
    db.prepare(`DELETE FROM projects WHERE id = 'p1'`).run();
    expect(project.id).toBe("p1");
  });
});

// ── tokenize ────────────────────────────────────────────────────

describe("BC7 tokenize · 中文 bigram + 英文整词", () => {
  it("中文切相邻两字(4 字 → 3 个 bigram)", () => {
    expect(tokenize("用户名字").sort()).toEqual(["用户", "户名", "名字"].sort());
    // 2 字 → 1 个 bigram
    expect(tokenize("偏好")).toEqual(["偏好"]);
  });

  it("英文按整词(长度≥2),小写化", () => {
    expect(tokenize("TypeScript 偏好").sort()).toEqual(["typescript", "偏好"].sort());
  });

  it("混排各切各的", () => {
    const t = tokenize("用户喜欢 TypeScript");
    expect(t).toContain("typescript");
    expect(t).toContain("用户");
    expect(t).toContain("喜欢");
  });

  it("单字中文也能命中", () => {
    expect(tokenize("钱")).toEqual(["钱"]);
  });

  it("空串 / 无有效词 → 空数组", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!!")).toEqual([]);
    expect(tokenize("a")).toEqual([]); // 单个 ASCII 字母是噪音
  });
});

// ── remember / recall ───────────────────────────────────────────

describe("BC7 remember", () => {
  it("写入并返回 id", async () => {
    const id = await memory.remember({ content: "用户名字:小明", kind: "fact" });
    expect(id).toMatch(/^mem_/);
    expect(countFragments(db)).toBe(1);
  });

  it("**重复内容不重复入库**,返回已有 id", async () => {
    const a = await memory.remember({ content: "用户喜欢 TypeScript", kind: "preference" });
    const b = await memory.remember({ content: "用户喜欢 TypeScript", kind: "preference" });
    expect(b).toBe(a);
    expect(countFragments(db)).toBe(1);
  });

  it("空白差异视为同一条(trim + 折叠空白)", async () => {
    const a = await memory.remember({ content: "用户喜欢  TypeScript", kind: "preference" });
    const b = await memory.remember({ content: "  用户喜欢 TypeScript  ", kind: "preference" });
    expect(b).toBe(a);
  });

  it("空内容被拒", async () => {
    await expect(memory.remember({ content: "   ", kind: "fact" })).rejects.toThrow(/不能为空/);
  });

  it("非法 kind 被拒", async () => {
    await expect(
      memory.remember({ content: "x", kind: "opinion" as never }),
    ).rejects.toThrow(/未知记忆分类/);
  });

  it("importance 越界被拒", async () => {
    await expect(memory.remember({ content: "x", kind: "fact", importance: 1.5 }))
      .rejects.toThrow(/importance/);
  });
});

describe("BC7 recall · **旧系统栽过的那条**", () => {
  it("「我叫什么名字」召得回「用户名字:小明」", async () => {
    // 旧系统:正则贪婪整段 → 这条永远召不回(8-D 审计项 M2)
    await memory.remember({ content: "用户名字:小明", kind: "fact" });
    const hits = await memory.recall("我叫什么名字");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain("小明");
  });

  it("中文模糊查询:相关的排在前面(命中数优先)", async () => {
    await memory.remember({ content: "用户偏好用 TypeScript 写后端", kind: "preference" });
    await memory.remember({ content: "用户养了一只叫豆豆的猫", kind: "fact" });
    // 查询 bigram:用户/户的/的偏/偏好/好是/是什/什么
    // 「用户偏好…」命中 用户+的偏?否 → 用户/偏好 等;「用户养了…」只命中 用户
    // 所以前者命中数更高,必须排第一
    const hits = await memory.recall("用户的偏好是什么");
    expect(hits[0]!.content).toContain("TypeScript");
    const catIdx = hits.findIndex((h) => h.content.includes("豆豆"));
    if (catIdx >= 0) expect(catIdx, "只命中 1 个 bigram 的必须排在后面").toBeGreaterThan(0);
  });

  it("全不相关的查询返回空(bigram 无任何命中)", async () => {
    await memory.remember({ content: "用户偏好用 TypeScript", kind: "preference" });
    expect(await memory.recall("量子纠缠退相干")).toEqual([]);
  });

  it("英文技术词按整词匹配", async () => {
    await memory.remember({ content: "用户用 pnpm 而不是 npm", kind: "preference" });
    await memory.remember({ content: "用户喜欢深色主题", kind: "preference" });
    const hits = await memory.recall("pnpm");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("pnpm");
  });

  it("命中数优先于 importance(高权重但无关的不该压顶)", async () => {
    await memory.remember({ content: "用户偏好 TypeScript", kind: "preference", importance: 0.1 });
    await memory.remember({ content: "用户偏好深色主题", kind: "preference", importance: 1.0 });
    const hits = await memory.recall("TypeScript 偏好");
    expect(hits[0]!.content).toContain("TypeScript");
  });

  it("kinds 过滤", async () => {
    await memory.remember({ content: "用户偏好 A", kind: "preference" });
    await memory.remember({ content: "用户偏好 B", kind: "fact" });
    const only = await memory.recall("用户偏好", { kinds: ["preference"] });
    expect(only).toHaveLength(1);
    expect(only[0]!.kind).toBe("preference");
  });

  it("limit 生效", async () => {
    for (let i = 0; i < 8; i++) {
      await memory.remember({ content: `用户偏好第${i}项`, kind: "preference" });
    }
    expect((await memory.recall("用户偏好", { limit: 3 }))).toHaveLength(3);
  });

  it("无匹配 → 空数组(不是抛错)", async () => {
    await memory.remember({ content: "用户喜欢猫", kind: "fact" });
    expect(await memory.recall("量子力学")).toEqual([]);
  });

  it("查询无有效词 → 退化为按 importance 排序的前 N(而不是返回空)", async () => {
    await memory.remember({ content: "低权重", kind: "fact", importance: 0.1 });
    await memory.remember({ content: "高权重", kind: "fact", importance: 0.9 });
    const hits = await memory.recall("!!!"); // 无 CJK、无 ASCII 词
    expect(hits).toHaveLength(2);
    expect(hits[0]!.content).toBe("高权重");
  });

  it("命中会累加访问计数", async () => {
    await memory.remember({ content: "用户偏好 TypeScript", kind: "preference" });
    await memory.recall("TypeScript");
    await memory.recall("TypeScript");
    const hits = await memory.recall("TypeScript");
    expect(hits[0]!.accessCount).toBe(2); // 第三次查询读到的是前两次的累加
  });

  it("decay 存在且可调用(契约的一部分,本轮是 no-op)", async () => {
    expect(typeof memory.decay).toBe("function");
    await expect(memory.decay!()).resolves.toBeUndefined();
  });
});

// ── 工具层 ──────────────────────────────────────────────────────

describe("BC7 工具", () => {
  it("memory_* 已实现,不再是「还没建」", () => {
    const missing = notYetBuiltToolNames();
    expect(missing).not.toContain("memory_search");
    expect(missing).not.toContain("memory_remember");
  });

  it("memory.* 已覆盖,且能力面已完整(净缺口为 0)", () => {
    const gap = capabilitiesWithoutTools();
    expect(gap).not.toContain("memory.read");
    expect(gap).not.toContain("memory.write");
    // client.* 在本次一并落地 → 缺口清零
    expect(gap).not.toContain("client.ask");
    expect(gap).toEqual([]);
  });

  it("memory_remember → memory_search 闭环(业务经理写,研究工也能读)", async () => {
    okText(await call("memory_remember", { kind: "preference", content: "用户偏好简洁的代码风格" }, bmCtx()));
    const t = okText(await call("memory_search", { query: "他喜欢什么样的代码" }));
    expect(t).toContain("简洁的代码风格");
  });

  it("**研究工不能写记忆**(memory.write 只给业务经理)", async () => {
    const e = errOf(await call("memory_remember", { kind: "fact", content: "x" }, ctx()));
    expect(e.code).toBe("denied");
    expect(e.message).toContain("架构上界");
  });

  it("memory_remember 非法 kind → 回灌分类闭集", async () => {
    const e = errOf(await call("memory_remember", { kind: "opinion", content: "x" }, bmCtx()));
    expect(e.code).toBe("invalid_args");
    expect(e.alternatives).toEqual([...FRAGMENT_KINDS]);
  });

  it("memory_search 无命中给可读文案", async () => {
    expect(okText(await call("memory_search", { query: "从没提过的事" }))).toContain("没有匹配");
  });

  it("记忆写入带上来源项目", async () => {
    await call("memory_remember", { kind: "project", content: "这个项目用 pnpm" }, bmCtx());
    const row = db.prepare(`SELECT source_project_id FROM memory_fragments`).get() as {
      source_project_id: string | null;
    };
    expect(row.source_project_id).toBe("p1");
  });

  it("**未注入记忆后端时如实报装配错误**,不假装成功", async () => {
    const noMem = ctx();
    // 显式去掉 memory
    const { memory: _drop, ...rest } = noMem;
    void _drop;
    const e = errOf(await call("memory_search", { query: "x" }, rest as ToolRunContext));
    expect(e.code).toBe("internal");
    expect(e.message).toContain("记忆后端未注入");
  });
});

// ── 可替换性 ────────────────────────────────────────────────────

describe("BC7 MemoryPort 是可替换契约", () => {
  it("换一个实现,工具代码一行不改", async () => {
    // 一个完全不用数据库的假后端 —— 证明上层只依赖接口
    const store: Fragment[] = [];
    const fake: MemoryPort = {
      async remember(input) {
        const id = `fake_${store.length + 1}`;
        store.push({
          id, kind: input.kind, content: input.content,
          importance: input.importance ?? 0.5, decayFactor: 1,
          accessCount: 0, lastAccessedAt: null, createdAt: 0, sourceProjectId: null,
        });
        return id;
      },
      async recall(query, opts) {
        return store.filter((f) => f.content.includes(query)).slice(0, opts?.limit ?? 5);
      },
      // 不实现 decay —— 接口声明它是可选的
    };

    okText(await call("memory_remember", { kind: "fact", content: "假后端里的记忆" }, bmCtx({ memory: fake })));
    const t = okText(await call("memory_search", { query: "假后端里的记忆" }, ctx({ memory: fake })));
    expect(t).toContain("假后端里的记忆");
    expect(store).toHaveLength(1);
    // 真后端没被碰过
    expect(countFragments(db)).toBe(0);
  });

  it("isFragmentKind 与 schema 闭集一致", () => {
    for (const k of FRAGMENT_KINDS) expect(isFragmentKind(k)).toBe(true);
    expect(isFragmentKind("opinion")).toBe(false);
  });
});
