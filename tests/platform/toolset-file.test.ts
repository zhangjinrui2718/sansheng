/**
 * 批次 19 · L2 工具集合文件(`harness/tools/{role}.json`)的**接线与 fail-closed**
 *
 * ── 这组测试守着的是什么 ────────────────────────────────────────
 *
 * 在批次 19 之前,`solveToolset` 的 `userToolSet` 分支**逻辑完整却无人调用** ——
 * `RuntimeDeps.toolSetFor` 只在 2 个测试里给过值,盘上那份 JSON **零读者**。
 * 于是:
 *
 *   1. 用户改了 `~/.sansheng/harness/tools/worker.json`,权限一点没变;
 *   2. harness 视图只显示 ceiling,用户看不出第 1 条;
 *   3. 而「改了没效果」与「已经生效」在界面上长得一模一样。
 *
 * 这组测试把三件事钉住:
 *   · 盘上 JSON → `ToolSetFile` 的解析 **与 fail-closed 方向**(坏文件退回 ceiling
 *     全集,**不是**空 allowlist —— 后者会静默收回全部权限);
 *   · `bootPlatform` **真的**把 `toolSetFor` 交给了 RuntimeDeps(生产接线的断言);
 *   · harness 视图**真的**报出「集合文件收掉了什么」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { solveToolset } from "../../src/platform/harness/authorize.js";
import { factoryToolset, ROLE_SPECS, type ProjectRole } from "../../src/platform/identity/role.js";
import {
  parseToolSetFile,
  resolveAllToolSets,
  resolveToolSet,
  strayToolSetFiles,
  toolSetDir,
  toolSetForDataDir,
  toolSetPath,
} from "../../src/platform/harness/toolSet.js";
import { buildHarnessView } from "../../src/platform/transport/http.js";
import { bootPlatform } from "../../src/platform/runtime/boot.js";

const CLOCK = 1_700_000_000_000;
let dataDir: string;
let db: Database.Database | undefined;
let dirs: string[] = [];

/** 去重 + 排序 —— `factoryToolset` 不保证唯一,而 `solveToolset` 的产物一定唯一且有序。 */
function norm(xs: readonly string[]): string[] {
  return [...new Set(xs)].sort();
}

beforeEach(() => {
  dirs = [];
  dataDir = mkdtempSync(join(tmpdir(), "ss-toolset-"));
  dirs.push(dataDir);
});

afterEach(() => {
  db?.close();
  db = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** 往数据目录写一个角色的集合文件。 */
function writeSet(role: ProjectRole, body: string): string {
  const dir = toolSetDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${role}.json`);
  writeFileSync(p, body, "utf8");
  // 写后自检:测试夹具本身也不能「静默没写成」(AGENTS.md §三类静默失败)
  expect(resolveToolSet(dataDir, role).path).toBe(p);
  return p;
}

// 项目内求解用的最小项目(active → 项目内能力全部放行)
const ACTIVE = {
  id: "p1",
  name: "p",
  status: "active" as const,
  assignments: [{ agentId: "wk" }, { agentId: "bm" }],
};

describe("集合文件读取 · 路径与形状", () => {
  it("路径固定在 <dataDir>/harness/tools/{role}.json", () => {
    expect(toolSetPath(dataDir, "worker")).toBe(join(dataDir, "harness", "tools", "worker.json"));
    expect(toolSetDir(dataDir)).toBe(join(dataDir, "harness", "tools"));
  });

  it("role 不属于闭合注册表 → 抛错(路径穿越的唯一防线,规矩①)", () => {
    expect(() => toolSetPath(dataDir, "../../etc/passwd" as ProjectRole)).toThrow(/未知角色/);
    expect(() => toolSetPath(dataDir, "worker/../../x" as ProjectRole)).toThrow(/未知角色/);
  });

  it("文件不存在 → absent,按出厂行为(不是错误)", () => {
    const r = resolveToolSet(dataDir, "worker");
    expect(r.state).toBe("absent");
    expect(r.file).toBeUndefined();
    expect(r.problem).toBeUndefined();
  });

  it("合法文件 → ok,file 就是盘上那份", () => {
    writeSet("worker", JSON.stringify({ allow: ["board_list"], deny: ["board_write"] }));
    const r = resolveToolSet(dataDir, "worker");
    expect(r.state).toBe("ok");
    expect(r.file).toEqual({ allow: ["board_list"], deny: ["board_write"] });
    expect(r.problem).toBeUndefined();
  });
});

describe("集合文件读取 · fail-closed 的方向(**最容易做反的一处**)", () => {
  const badBodies: Array<[string, string]> = [
    ["不是合法 JSON", "{ allow: [oops"],
    ["空文件", "   \n  "],
    ["顶层是数组", "[]"],
    ["顶层是 null", "null"],
    ["allow 缺失", JSON.stringify({ deny: [] })],
    ["deny 缺失", JSON.stringify({ allow: ["board_list"] })],
    ["allow 不是数组", JSON.stringify({ allow: "board_list", deny: [] })],
    ["allow 里有非字符串", JSON.stringify({ allow: [1], deny: [] })],
    ["deny 里有非字符串", JSON.stringify({ allow: [], deny: [{ x: 1 }] })],
  ];

  for (const [label, body] of badBodies) {
    it(`${label} → invalid 且退化成出厂行为(不是空 allowlist)`, () => {
      writeSet("worker", body);
      const r = resolveToolSet(dataDir, "worker");
      expect(r.state).toBe("invalid");
      // **核心断言**:坏文件不给空名单 —— 空名单等于悄悄收回全部权限。
      expect(r.file).toBeUndefined();
      expect(r.problem?.detail).toMatch(/没有生效/);
      // 传给 solveToolset 的是 undefined → 调用方按 ceiling 全集求解
      expect(toolSetForDataDir(dataDir)("worker")).toBeUndefined();
    });
  }

  it("**有意**写的空名单是合法文件,效果就是零工具 —— 与坏文件不是一回事", () => {
    writeSet("worker", JSON.stringify({ allow: [], deny: [] }));
    const r = resolveToolSet(dataDir, "worker");
    expect(r.state).toBe("ok");
    expect(r.file).toEqual({ allow: [], deny: [] });

    const agent = { id: "wk", role: "worker" as const, displayName: "w" };
    expect(solveToolset(agent, ACTIVE, r.file).tools).toEqual([]);
  });

  it("四个角色各自独立:一个坏文件不影响别人", () => {
    writeSet("worker", "{{{");
    writeSet("project_manager", JSON.stringify({ allow: [], deny: [] }));
    const all = resolveAllToolSets(dataDir);
    expect(all.map((r) => r.role)).toEqual([
      "business_manager", "project_manager", "worker", "quality_reviewer",
    ]);
    expect(all.find((r) => r.role === "worker")?.state).toBe("invalid");
    expect(all.find((r) => r.role === "project_manager")?.state).toBe("ok");
    expect(all.find((r) => r.role === "business_manager")?.state).toBe("absent");
  });
});

describe("集合文件 → solveToolset 的可见结果", () => {
  it("allow 严格按名单:ceiling 全集被收窄到文件要的那几个", () => {
    const factory = norm(factoryToolset("worker"));
    const keep = [factory[0]!, factory[1]!];
    writeSet("worker", JSON.stringify({ allow: keep, deny: [] }));

    const agent = { id: "wk", role: "worker" as const, displayName: "w" };
    const solved = solveToolset(agent, ACTIVE, resolveToolSet(dataDir, "worker").file);
    expect(solved.tools).toEqual(norm(keep));
    // 出厂面确实更大 —— 否则这个测试证明不了「收窄」
    expect(factory.length).toBeGreaterThan(keep.length);
  });

  it("deny 优先于 allow", () => {
    const t = norm(factoryToolset("worker"))[0]!;
    writeSet("worker", JSON.stringify({ allow: [t], deny: [t] }));
    const agent = { id: "wk", role: "worker" as const, displayName: "w" };
    expect(solveToolset(agent, ACTIVE, resolveToolSet(dataDir, "worker").file).tools).toEqual([]);
  });

  it("超出 ceiling 的工具名 → 落 blockedByCeiling,且**不生效**", () => {
    // `bash` 来自 code.exec:worker 有,业务经理没有 —— 拿它当越权样本
    expect(ROLE_SPECS.business_manager.ceiling).not.toContain("code.exec");
    writeSet("business_manager", JSON.stringify({ allow: ["bash"], deny: [] }));
    const bm = { id: "bm", role: "business_manager" as const, displayName: "b" };
    const solved = solveToolset(bm, ACTIVE, resolveToolSet(dataDir, "business_manager").file);
    expect(solved.tools).toEqual([]);
    expect(solved.blockedByCeiling.map((d) => d.subject)).toEqual(["bash"]);
  });

  it("拼错的工具名 → 落 unknownTools(不静默生效)", () => {
    writeSet("worker", JSON.stringify({ allow: ["board_lst"], deny: [] }));
    const agent = { id: "wk", role: "worker" as const, displayName: "w" };
    const solved = solveToolset(agent, ACTIVE, resolveToolSet(dataDir, "worker").file);
    expect(solved.unknownTools.map((d) => d.subject)).toEqual(["board_lst"]);
    expect(solved.tools).toEqual([]);
  });
});

describe("文件名写错的意图必须被报出来", () => {
  it("workers.json(复数)会被列入 stray,合法文件名不会", () => {
    writeSet("worker", JSON.stringify({ allow: [], deny: [] }));
    const dir = toolSetDir(dataDir);
    writeFileSync(join(dir, "workers.json"), "{}", "utf8");
    writeFileSync(join(dir, "README.md"), "x", "utf8");
    expect(strayToolSetFiles(dataDir)).toEqual(["workers.json"]);
  });
});

describe("生产接线:bootPlatform 真的把 toolSetFor 交出去了", () => {
  it("文件在 → 返回它;文件不在 / 坏了 → undefined(出厂行为)", () => {
    writeSet("worker", JSON.stringify({ allow: ["board_list"], deny: [] }));
    writeSet("project_manager", "not json at all");

    const booted = bootPlatform({ dataDir, clientLog: () => {} });
    try {
      // 这一条就是「生产接线无人传」那个缺陷的守卫
      expect(booted.deps.toolSetFor).toBeTypeOf("function");
      expect(booted.deps.toolSetFor!("worker")).toEqual({ allow: ["board_list"], deny: [] });
      // 没有文件的角色 → undefined(= 按 ceiling 全集,出厂行为)
      expect(booted.deps.toolSetFor!("quality_reviewer")).toBeUndefined();
      // 坏文件 → 也是 undefined(fail-closed 到出厂行为),不是空名单
      expect(booted.deps.toolSetFor!("project_manager")).toBeUndefined();
    } finally {
      booted.close();
    }
  });

  it("改盘上的文件之后下一次读就变(不需要重启服务)", () => {
    const booted = bootPlatform({ dataDir, clientLog: () => {} });
    try {
      expect(booted.deps.toolSetFor!("worker")).toBeUndefined();
      writeSet("worker", JSON.stringify({ allow: ["board_list"], deny: [] }));
      expect(booted.deps.toolSetFor!("worker")).toEqual({ allow: ["board_list"], deny: [] });
    } finally {
      booted.close();
    }
  });
});

/**
 * 2026-10-05 真机现场:成员页显示「能力 22 项 · 可写 3 类 · **实得工具 0 个**」——
 * 而那一刻库里连这个角色的 agent 行都没有(组织刚被重置、还没播种)。
 *
 * `tools` 是空数组没错,但**「0 个工具」与「算不出来」是两件事**,而它们在界面上
 * 长得一模一样。所以契约里多了一维 `toolsSolved`,这组测试钉住它的两个方向:
 *   · 没有 agent 行 ⇒ `toolsSolved === false`(界面显示「求解不了」,不许显示 0);
 *   · 有 agent 行   ⇒ `toolsSolved === true`(此时 `tools: []` 才是真的 0 —— 例如
 *     接待阶段某个角色在 scope 门下确实一个都拿不到)。
 */
describe("② harness 视图:工具面「求解不了」与「真的是 0」必须能分开", () => {
  it("组织未播种(库里没有这个角色的 agent 行)⇒ toolsSolved = false", () => {
    db = openPlatformMemoryDb(); // 注意:不插任何 agent
    const v = buildHarnessView(db, dataDir);
    expect(v.roles.length, "四个角色的**规格**仍然照报(它们是代码内常量)").toBe(4);
    for (const r of v.roles) {
      expect(r.tools, `${r.role} 的工具面求解不了,所以是空数组`).toEqual([]);
      expect(r.toolsSolved, `${r.role} 必须如实报「求解不了」`).toBe(false);
      // 而 ceiling / writeKinds 是代码内常量,照常显示 —— 这正是真机上那个
      // 「22 / 3 / 0」的形状:看起来像「这个角色没有工具」。
      expect(r.ceiling.length).toBeGreaterThan(0);
    }
  });

  it("播种之后同一份视图变成 solved = true(负样本的另一半)", () => {
    db = openPlatformMemoryDb();
    insertAgent(db, {
      id: "ag_bm", role: "business_manager", specialization: null,
      displayName: "业务经理", createdAt: CLOCK,
    });
    const bm = buildHarnessView(db, dataDir).roles.find((r) => r.role === "business_manager")!;
    expect(bm.toolsSolved).toBe(true);
    expect(bm.tools.length, "接待模式(无项目)下业务经理拿得到 project_open 一类").toBeGreaterThan(0);
    // 其余三个角色仍然没有 agent 行 ⇒ 仍然「求解不了」
    const wk = buildHarnessView(db, dataDir).roles.find((r) => r.role === "worker")!;
    expect(wk.toolsSolved).toBe(false);
  });
});

describe("harness 只读视图:集合文件生效的**证据**必须可见", () => {
  beforeEach(() => {
    db = openPlatformMemoryDb();
    insertAgent(db, {
      id: "ag_wk", role: "worker", specialization: "engineering",
      displayName: "工程师", createdAt: CLOCK,
    });
    // buildHarnessView 只为**库里真有这个角色**的行求解(没有行就没有工具面可报),
    // 所以越权那一条要先种一个业务经理。
    insertAgent(db, {
      id: "ag_bm", role: "business_manager", specialization: null,
      displayName: "业务经理", createdAt: CLOCK,
    });
    insertProject(db, {
      id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: CLOCK,
    });
    addMember(db, "p1", "ag_wk", CLOCK);
    addMember(db, "p1", "ag_bm", CLOCK);
  });

  function view() {
    if (db === undefined) throw new Error("db 未初始化");
    return buildHarnessView(db, dataDir);
  }
  function roleView(role: ProjectRole) {
    const r = view().roles.find((x) => x.role === role);
    if (r === undefined) throw new Error(`视图里没有 ${role}`);
    return r;
  }

  it("没有集合文件 → tools 是 ceiling 全集,removedByToolSet 为空", () => {
    const r = roleView("worker");
    expect(r.toolSet.state).toBe("absent");
    // 正样本:库里**有**这个角色的 agent 行 ⇒ 工具面是求解过的
    expect(r.toolsSolved, "有 agent 行 ⇒ 求解过了").toBe(true);
    expect(r.toolSet.removedByToolSet).toEqual([]);
    expect(norm(r.tools)).toEqual(norm(factoryToolset("worker")));
    expect(view().toolsDir).toBe(toolSetDir(dataDir));
  });

  it("收掉两个工具 → tools 少两个,**removedByToolSet 正好是剩下的那些**", () => {
    const factory = norm(factoryToolset("worker"));
    const keep = factory.slice(0, 2);
    const drop = factory.slice(2);
    writeSet("worker", JSON.stringify({ allow: keep, deny: [] }));

    const r = roleView("worker");
    expect(r.toolSet.state).toBe("ok");
    expect(r.tools).toEqual(norm(keep));
    // 这就是「用户改了 JSON 有没有效果」在界面上的答案
    expect(r.toolSet.removedByToolSet).toEqual(norm(drop));
    expect(r.toolSet.removedByToolSet.length).toBeGreaterThan(0);
  });

  it("越权与拼错各有各的位置(blockedByCeiling / unknownTools)", () => {
    writeSet("business_manager", JSON.stringify({ allow: ["bash", "board_lst"], deny: [] }));
    const bm = roleView("business_manager");
    expect(bm.blockedByCeiling).toEqual(["bash"]);
    expect(bm.unknownTools).toEqual(["board_lst"]);
    expect(bm.tools).toEqual([]);
  });

  it("坏文件 → 视图 state=invalid、tools 回落到 ceiling 全集、problem 有话说", () => {
    writeSet("worker", "{ allow: [");
    const r = roleView("worker");
    expect(r.toolSet.state).toBe("invalid");
    expect(r.toolSet.problem).toMatch(/没有生效/);
    // 回落 = 出厂全集(方向上是**放宽**,所以必须可见)
    expect(norm(r.tools)).toEqual(norm(factoryToolset("worker")));
  });

  it("strayToolSetFiles 出现在视图顶层(文件名写错不会被静默忽略)", () => {
    const dir = toolSetDir(dataDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workers.json"), "{}", "utf8");
    expect(view().strayToolSetFiles).toEqual(["workers.json"]);
  });
});

describe("坏文件必须留现场(7-N:见不到的现场等于没有现场)", () => {
  it("走生产接线读坏文件时会留一行 warn —— 因为这次建会话用的是 ceiling 全集", () => {
    writeSet("worker", "{ allow: [oops");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
    try {
      expect(toolSetForDataDir(dataDir)("worker")).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const warn = logs.find((l) => l.includes("工具集合无效") && l.includes("worker"));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/本次按 ceiling 全集/);
    expect(warn).toMatch(/没有生效/);
  });

  it("文件合法时不产生 warn(不制造噪音)", () => {
    writeSet("worker", JSON.stringify({ allow: ["board_list"], deny: [] }));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    });
    try {
      expect(toolSetForDataDir(dataDir)("worker")).toEqual({ allow: ["board_list"], deny: [] });
    } finally {
      spy.mockRestore();
    }
    expect(logs.filter((l) => l.includes("工具集合无效"))).toEqual([]);
  });
});

describe("parseToolSetFile 是纯函数", () => {
  it("返回值不与入参共享数组", () => {
    const raw: { allow: string[]; deny: string[] } = { allow: ["a"], deny: ["b"] };
    const r = parseToolSetFile(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    raw.allow.push("c");
    expect(r.file.allow).toEqual(["a"]);
  });
});
