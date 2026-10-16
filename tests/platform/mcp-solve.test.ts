/**
 * MCP · 求解(catalog × grants → pi 配置)
 *
 * 守三件事:
 *   ① **求交** —— 授权只能开目录里已存在的 server;授权里写了不存在的名字
 *      进 `unknownServers` 而**不静默生效**。
 *   ② **未授权的 server 必须显式交给 pi**(`enabled:false` + `hidden`)——
 *      pi 的资源工具到达的是「每一个 enabled 且非 hidden 的 server」,
 *      **不列**是不够的。
 *   ③ **收口项目 ⇒ 零 server**,与 scope 门(`mcp.` 在 `PROJECT_SCOPED_PREFIXES` 里)
 *      是同一条判据的两个落点。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember } from "../../src/platform/storage/repo/projects.js";
import { mcpDir, serversPath } from "../../src/platform/mcp/config.js";
import { mcpForDataDir } from "../../src/platform/mcp/grants.js";
import { solveMcpFor, mcpPattern } from "../../src/platform/mcp/solve.js";
import { toLoadedMcpConfig } from "../../src/platform/mcp/piConfig.js";
import { solveToolset, type Agent, type Project } from "../../src/platform/harness/authorize.js";
import { ROLE_SPECS } from "../../src/platform/identity/role.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { RuntimeDeps } from "../../src/platform/runtime/assembly.js";
import type Database from "better-sqlite3";

const AT = 1_700_000_000_000;
const dirs: string[] = [];
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sansheng-mcp-solve-"));
  dirs.push(d);
  return d;
}

function seedCatalog(dataDir: string, raw: unknown): void {
  mkdirSync(mcpDir(dataDir), { recursive: true });
  writeFileSync(serversPath(dataDir), JSON.stringify(raw), "utf8");
}

function seedGrants(dataDir: string, entries: Record<string, { allow: string[]; deny?: string[] }>): void {
  mkdirSync(mcpDir(dataDir), { recursive: true });
  for (const [role, v] of Object.entries(entries)) {
    writeFileSync(
      join(mcpDir(dataDir), `${role}.json`),
      JSON.stringify({ allow: v.allow, deny: v.deny ?? [] }),
      "utf8",
    );
  }
}

function depsFor(dataDir: string): RuntimeDeps {
  db = openPlatformMemoryDb();
  insertAgent(db, { id: "a-pm", role: "project_manager", specialization: null, displayName: "PM", createdAt: AT });
  insertAgent(db, { id: "a-bm", role: "business_manager", specialization: null, displayName: "BM", createdAt: AT });
  insertAgent(db, { id: "a-rw", role: "research_worker", specialization: null, displayName: "RW", createdAt: AT });
  insertProject(db, { id: "p1", name: "P", client: "C", goal: "G", status: "active", createdAt: AT });
  insertProject(db, { id: "p2", name: "Closed", client: "C", goal: "G", status: "done", createdAt: AT, closedAt: AT });
  for (const p of ["p1", "p2"]) for (const a of ["a-pm", "a-bm", "a-rw"]) addMember(db, p, a, AT);
  return {
    db,
    dataDir,
    now: () => AT,
    newId: (p: string) => `${p}_x`,
    mcpFor: mcpForDataDir(dataDir),
  };
}

const agentOf = (id: string, role: Agent["role"]): Agent => ({ id, role, displayName: id });
const projectOf = (id: string, status: Project["status"], members: string[]): Project => ({
  id,
  name: id,
  status,
  assignments: members.map((agentId) => ({ agentId })),
});

describe("mcp-solve · 目录 × 授权 求交", () => {
  it("授权命中的 server 才是 active;patterns 一一对应", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" }, sentry: { url: "https://y/mcp" } } });
    seedGrants(d, { project_manager: { allow: ["docs"] } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    expect(s.state).toBe("ok");
    expect(s.patterns).toEqual(["mcp__docs__*"]);
    expect(s.servers.map((x) => [x.name, x.granted])).toEqual([["docs", true], ["sentry", false]]);
  });

  it("⚠️ 零授权 ⇒ `patterns` 为空,但**目录里全部 server 仍然列出来**(坑 4)", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-rw", "research_worker"), projectOf("p1", "active", ["a-rw"]));
    expect(s.state).toBe("no_grants");
    expect(s.patterns).toEqual([]);
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0].granted).toBe(false);
  });

  it("server 名里的 `-` 在模式里换成 `_`(pi 的 `mcpNamespace` 也这么干)", () => {
    expect(mcpPattern("my-docs")).toBe("mcp__my_docs__*");
  });

  it("`deny` 优先于 `allow`", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    seedGrants(d, { project_manager: { allow: ["docs"], deny: ["docs"] } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    expect(s.servers[0].granted).toBe(false);
    expect(s.patterns).toEqual([]);
  });

  it("授权里有、目录里没有的名字 ⇒ `unknownServers` **如实报出**,不静默生效", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    seedGrants(d, { project_manager: { allow: ["docs", "ghost"] } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    expect(s.unknownServers).toEqual(["ghost"]);
    expect(s.patterns).toEqual(["mcp__docs__*"]);
  });

  it("坏授权文件 ⇒ 零授权 + problem 可见", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(join(mcpDir(d), "project_manager.json"), "{ 坏", "utf8");
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    expect(s.patterns).toEqual([]);
    expect(s.problem).toContain("零授权");
  });

  it("坏目录文件 ⇒ 零 server + catalogProblem 可见", () => {
    const d = tmp();
    mkdirSync(mcpDir(d), { recursive: true });
    writeFileSync(serversPath(d), "{ 坏", "utf8");
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    expect(s.servers).toEqual([]);
    expect(s.catalogProblem).toBeDefined();
  });

  it("**没有装配 `mcpFor`**(纯 HTTP 装配)⇒ 零授权,不是「全放行」", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const deps: RuntimeDeps = { ...depsFor(d), mcpFor: undefined };
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    expect(s.state).toBe("no_grants");
    expect(s.patterns).toEqual([]);
  });
});

describe("mcp-solve · 交给 pi 的配置", () => {
  it("⚠️ 未授权的 server 写成 `{ enabled: false, exposure: \"hidden\" }`(**坑 4**)", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" }, ghost: { command: "x" } } });
    seedGrants(d, { project_manager: { allow: ["docs"] } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    const r = toLoadedMcpConfig(s, d, undefined);
    const byName = new Map(r.config.servers.map((e) => [e.name, e.config]));
    expect(byName.get("docs")).toMatchObject({ enabled: true, exposure: "direct" });
    expect(byName.get("ghost"), "未授权的必须**在**列表里且被显式关掉").toMatchObject({
      enabled: false,
      exposure: "hidden",
    });
  });

  it("**零授权时也仍然有 MCP 扩展要接的配置**(全 enabled:false),不是「没有这个 server」", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-rw", "research_worker"), projectOf("p1", "active", ["a-rw"]));
    const r = toLoadedMcpConfig(s, d, undefined);
    expect(r.config.servers).toHaveLength(1);
    expect(r.config.servers[0].config.enabled).toBe(false);
  });

  it("`autoEnableCodemode: false` 且**不给 `projectConfig`**(codemode / 项目 mcp.json 两个坑)", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    seedGrants(d, { project_manager: { allow: ["docs"] } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    const r = toLoadedMcpConfig(s, d, undefined);
    expect(r.config.autoEnableCodemode).toBe(false);
    // ⚠️ `projectConfig` 一旦出现,pi 就会去读 `<cwd>/.pi/mcp.json` —— 而 cwd 是项目仓根
    expect(Object.keys(r.config)).not.toContain("projectConfig");
    expect(r.config.servers[0].source).toContain("servers.json");
  });

  it("连接状态**恒为 unavailable** —— 平台读不到,宁可没有也不伪造", () => {
    const d = tmp();
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    expect(toLoadedMcpConfig(s, d, undefined).connectionState).toBe("unavailable");
  });

  it("stdio 的 command/args 与 http 的 url 各自落对字段", () => {
    const d = tmp();
    seedCatalog(d, {
      servers: { local: { command: "npx", args: ["-y", "srv"] }, remote: { url: "https://r/mcp" } },
    });
    seedGrants(d, { project_manager: { allow: ["local", "remote"] } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p1", "active", ["a-pm"]));
    const r = toLoadedMcpConfig(s, d, undefined);
    const local = r.config.servers.find((e) => e.name === "local");
    const remote = r.config.servers.find((e) => e.name === "remote");
    expect(local?.config).toMatchObject({ type: "stdio", command: "npx", args: ["-y", "srv"] });
    expect(remote?.config).toMatchObject({ type: "http", url: "https://r/mcp" });
  });
});

describe("mcp-solve · 作用域:收口项目 / 接待会话 ⇒ 零 server", () => {
  it("收口项目(status=done)⇒ 一个 server 都不连", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    seedGrants(d, { project_manager: { allow: ["docs"] } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), projectOf("p2", "done", ["a-pm"]));
    expect(s.state).toBe("closed_project");
    expect(s.servers).toEqual([]);
    expect(s.patterns).toEqual([]);
  });

  it("接待会话(project=null)⇒ 同样零 server", () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    seedGrants(d, { project_manager: { allow: ["docs"] } });
    const deps = depsFor(d);
    const s = solveMcpFor(deps, agentOf("a-pm", "project_manager"), null);
    expect(s.state).toBe("intake");
    expect(s.patterns).toEqual([]);
  });

  it("**scope 门同源**:`mcp.` 在 PROJECT_SCOPED_PREFIXES 里 ⇒ 收口项目里 `mcp_*` 工具被挡", () => {
    const deps = depsFor(tmp());
    const pm = agentOf("a-pm", "project_manager");
    expect(solveToolset(pm, projectOf("p1", "active", ["a-pm"])).tools).toContain("mcp_grant");
    const closed = solveToolset(pm, projectOf("p2", "done", ["a-pm"]));
    expect(closed.tools).not.toContain("mcp_grant");
    expect(closed.blockedByScope.map((x) => x.subject)).toContain("mcp.grant");
  });

  it("⚠️ `mcp.read` **没有**被放进「收口后仍可用」那三项(豁免的是说话)", () => {
    const deps = depsFor(tmp());
    const bm = agentOf("a-bm", "business_manager");
    const closed = solveToolset(bm, projectOf("p2", "done", ["a-bm"]));
    expect(closed.tools).not.toContain("mcp_list");
    // 对照:同一次收口里「说话」那几项仍然可用 —— 证明挡的是 MCP 而不是全部
    expect(closed.tools).toContain("project_read");
  });
});

describe("mcp-solve · ceiling:三个执行角色与质检一条 MCP 能力都没有", () => {
  it("没有 `mcp.grant` 的角色调 `mcp_grant` 被 **ceiling 门**拒", async () => {
    const deps = depsFor(tmp());
    for (const [id, role] of [
      ["a-bm", "business_manager"],
      ["a-rw", "research_worker"],
    ] as const) {
      const r = await dispatch(
        "mcp_grant",
        { server: "docs", role: "project_manager" },
        {
          db: deps.db,
          agent: agentOf(id, role),
          project: projectOf("p1", "active", [id]),
          now: () => AT,
          newId: (p: string) => `${p}_x`,
          dataDir: tmp(),
        },
      );
      expect(r.ok, `${role} 不该能调 mcp_grant —— 实际:${JSON.stringify(r)}`).toBe(false);
      expect((r as { message: string }).message).toContain("架构上界");
    }
  });

  it("三条 MCP 能力真的只在 ceiling 里出现该出现的地方(**代码内常量**,不是数据)", () => {
    // ⚠️ 判据不能写成 `blockedByCeiling` 含 `mcp.grant`:没给集合文件时
    // requested = ceiling,「不在 ceiling 里」的东西压根没进过 requested,
    // 所以 blockedByCeiling 是空的 —— 那是一个**看起来正常**的答案(7-D 的形态)。
    // 真正的判据在两处:ROLE_SPECS 里的 ceiling,以及 dispatch 的第 2 道门。
    const has = (role: keyof typeof ROLE_SPECS, cap: string): boolean =>
      (ROLE_SPECS[role].ceiling as readonly string[]).includes(cap);
    expect(has("business_manager", "mcp.read")).toBe(true);
    expect(has("business_manager", "mcp.grant")).toBe(false);
    expect(has("project_manager", "mcp.read")).toBe(true);
    expect(has("project_manager", "mcp.grant")).toBe(true);
    for (const role of ["research_worker", "coding_worker", "quality_reviewer"] as const) {
      expect(has(role, "mcp.read"), `${role} 不该有 mcp.read`).toBe(false);
      expect(has(role, "mcp.grant"), `${role} 不该有 mcp.grant`).toBe(false);
    }
    // 而工具面上确实一条 MCP 工具都没有
    const s = solveToolset(agentOf("a-rw", "research_worker"), projectOf("p1", "active", ["a-rw"]));
    expect(s.tools.filter((t) => t.startsWith("mcp"))).toEqual([]);
  });

  it("项目经理**能**调 `mcp_grant`(ceiling 给了)", async () => {
    const d = tmp();
    seedCatalog(d, { servers: { docs: { url: "https://x/mcp" } } });
    const deps = depsFor(d);
    const r = await dispatch(
      "mcp_grant",
      { server: "docs", role: "project_manager" },
      {
        db: deps.db,
        agent: agentOf("a-pm", "project_manager"),
        project: projectOf("p1", "active", ["a-pm"]),
        now: () => AT,
        newId: (p: string) => `${p}_x`,
        dataDir: d,
      },
    );
    expect(r.ok, `项目经理应该能授权 —— 实际:${JSON.stringify(r)}`).toBe(true);
  });
});
