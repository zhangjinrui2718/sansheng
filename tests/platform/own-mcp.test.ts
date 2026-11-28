/**
 * 自己仓库里的 MCP 服务进会话(migration 040)· 求解层 —— `solveMcpFor` / `toLoadedMcpConfig`
 *
 * ── 这一文件守的是六条硬要求 ───────────────────────────────────
 *
 *   ① **不经授权文件**:合法的、没被停用的 `mcp.json` 直接进他自己的会话(用户裁决)。
 *   ② **四类不连,且都有原因**:格式不对 / 被停用 / 撞了人的目录 / 没有装配工作区。
 *   ③ **进程工作目录钉在工具目录**(`cwd`),不按项目仓(会话 cwd)解析相对路径。
 *   ④ **人的目录那一半行为不变**:授权、secrets、hidden 那一套一个字没动。
 *   ⑤ **业务经理与项目经理、接待阶段、收口项目**:一条自己的服务都不连。
 *   ⑥ **质检写了 `mcp.json` 不连**(它试跑不了)。
 *
 * 宿主那一层(换会话、停用端点)在 `own-kit-host.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, loadProjectForAuthz, updateProject } from "../../src/platform/storage/repo/projects.js";
import { agentWorkspaceRoot } from "../../src/platform/workspace/root.js";
import { solveMcpFor, mcpPattern, type McpSolution } from "../../src/platform/mcp/solve.js";
import { toLoadedMcpConfig } from "../../src/platform/runtime/agentRuntime/pi/mcpConfig.js";
import { writeMcpCatalog } from "../../src/platform/mcp/config.js";
import { mcpForDataDir } from "../../src/platform/mcp/grants.js";
import { setOwnToolDisabled } from "../../src/platform/storage/repo/agentTools.js";
import type { RuntimeDeps } from "../../src/platform/runtime/assembly.js";
import type { Agent } from "../../src/platform/harness/authorize.js";

let db: Database.Database;
let dataDir = "";
let workRoot = "";

beforeEach(() => {
  db = openPlatformMemoryDb();
  ensureOrg(db, 1);
  insertProject(db, { id: "p1", name: "项目一", client: "甲", goal: "g", status: "active", createdAt: 1 });
  ensureProjectOrg(db, "p1", 1);
  dataDir = mkdtempSync(join(tmpdir(), "ss-own-mcp-data-"));
  workRoot = mkdtempSync(join(tmpdir(), "ss-own-mcp-work-"));
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

function agentOf(roleId: string): Agent {
  const a = getAgent(db, roleId);
  if (a === null) throw new Error(`夹具里没有 agent ${roleId}`);
  const { id, role, displayName, specialization } = a;
  return { id, role, displayName, ...(specialization !== null ? { specialization } : {}) };
}

function deps(over: Partial<RuntimeDeps> = {}): RuntimeDeps {
  return { db, dataDir, workspaceRoot: workRoot, ...over };
}

function put(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
}
const SKILL = "---\ndescription: 检索我自己的调研笔记\n---\n正文";
function ownTool(role: string, name: string, mcp?: unknown): string {
  const root = agentWorkspaceRoot(workRoot, role);
  put(root, `tools/${name}/SKILL.md`, SKILL);
  put(root, `tools/${name}/server.py`, "print('server')");
  if (mcp !== undefined) put(root, `tools/${name}/mcp.json`, typeof mcp === "string" ? mcp : JSON.stringify(mcp));
  return root;
}
const names = (s: McpSolution): string[] => s.servers.filter((x) => x.granted).map((x) => x.name);

describe("solveMcpFor · 自己仓库里的 MCP 服务(不经授权文件)", () => {
  it("① 合法的直接连:名字 own-<角色>-<工具>,granted,cwd 钉在工具目录;allowlist 有对应模式", () => {
    ownTool("coding_worker", "rag", { command: "python", args: ["server.py"] });
    const s = solveMcpFor(deps(), agentOf("cw"), loadProjectForAuthz(db, "p1"));
    expect(names(s)).toEqual(["own-coding_worker-rag"]);
    expect(s.ownTools).toEqual(["rag"]);
    expect(s.ownProblem).toBeUndefined();
    expect(s.patterns).toContain(mcpPattern("own-coding_worker-rag"));
    const entry = s.servers[0];
    expect(entry).toMatchObject({ origin: "own", granted: true, cwd: join(workRoot, "roles", "coding_worker", "tools", "rag") });
    expect(entry?.def).toMatchObject({ transport: "stdio", command: "python", args: ["server.py"] });
    expect(entry?.source).toBe("sansheng:roles/coding_worker/tools/rag/mcp.json");
  });

  it("② 四类不连:格式不对 / 被停用 / 没有装配工作区 —— 都不算故障也不报错;撞了人的目录才报", () => {
    ownTool("coding_worker", "bad", "{ not json");
    ownTool("coding_worker", "remote", { url: "https://example.com/mcp" });
    ownTool("coding_worker", "off", { command: "python" });
    ownTool("coding_worker", "on", { command: "python" });
    setOwnToolDisabled(db, { id: "atd_1", agentId: "cw", toolName: "off", disabled: true, now: 1 });
    const s = solveMcpFor(deps(), agentOf("cw"), loadProjectForAuthz(db, "p1"));
    expect(names(s)).toEqual(["own-coding_worker-on"]);
    expect(s.ownTools).toEqual(["on"]);
    // 格式不对的原因在扫描结果里(上下文与人读面都看得到),这里不重复报
    expect(s.ownProblem).toBeUndefined();
    // 没有装配工作区:一条都不连,不算故障
    const bare = solveMcpFor(deps({ workspaceRoot: undefined }), agentOf("cw"), loadProjectForAuthz(db, "p1"));
    expect(bare.ownTools).toEqual([]);
    expect(bare.ownProblem).toBeUndefined();
    expect(names(bare)).toEqual([]);
  });

  it("② 撞了人的目录:人的一份赢,自己的不连,原因可见", () => {
    ownTool("coding_worker", "rag", { command: "python" });
    const w = writeMcpCatalog(dataDir, {
      servers: [{ name: "own-coding_worker-rag", transport: "stdio", command: "node" }], state: "ok", path: "", problem: undefined,
    }, 1);
    expect(w.ok, JSON.stringify(w)).toBe(true);
    const s = solveMcpFor(deps(), agentOf("cw"), loadProjectForAuthz(db, "p1"));
    expect(s.ownTools).toEqual([]);
    expect(s.ownProblem).toContain("撞了");
    // 人的一份仍在目录里(未授权 ⇒ hidden),行为不变
    expect(s.servers.map((x) => [x.name, x.granted, x.origin])).toEqual([["own-coding_worker-rag", false, undefined]]);
  });

  it("⑤ 业务经理与项目经理没有自己的仓库;接待阶段与收口项目一条都不连", () => {
    ownTool("coding_worker", "rag", { command: "python" });
    const p = loadProjectForAuthz(db, "p1");
    for (const id of ["bm", "pm"]) {
      const s = solveMcpFor(deps(), agentOf(id), p);
      expect(s.ownTools).toEqual([]);
      expect(names(s)).toEqual([]);
    }
    expect(solveMcpFor(deps(), agentOf("cw"), null).ownTools).toEqual([]);
    updateProject(db, "p1", { status: "done" }, 2);
    const closed = solveMcpFor(deps(), agentOf("cw"), loadProjectForAuthz(db, "p1"));
    expect(closed.state).toBe("closed_project");
    expect(closed.ownTools).toEqual([]);
  });

  it("⑥ 质检写了 mcp.json 不连(它试跑不了);同一个仓库它自己的说明类工具照常", () => {
    const root = ownTool("quality_reviewer", "helper", { command: "python" });
    put(root, "tools/checklist/SKILL.md", SKILL);
    const s = solveMcpFor(deps(), agentOf("qa"), loadProjectForAuthz(db, "p1"));
    expect(names(s)).toEqual([]);
    expect(s.ownTools).toEqual([]);
  });

  it("① 与人的目录**并存**:两条都连,各自的来源指得出文件", () => {
    ownTool("coding_worker", "rag", { command: "python" });
    const w = writeMcpCatalog(dataDir, {
      servers: [{ name: "human-tool", transport: "stdio", command: "node" }], state: "ok", path: "", problem: undefined,
    }, 1);
    expect(w.ok, JSON.stringify(w)).toBe(true);
    // 给 cw 开人的那条:授权文件按角色存,直接写盘;`deps.mcpFor` 是授权的唯一来源
    mkdirSync(join(dataDir, "harness", "mcp"), { recursive: true });
    writeFileSync(join(dataDir, "harness", "mcp", "coding_worker.json"), JSON.stringify({ allow: ["human-tool"], deny: [] }));
    const s = solveMcpFor(deps({ mcpFor: mcpForDataDir(dataDir) }), agentOf("cw"), loadProjectForAuthz(db, "p1"));
    expect(names(s).sort()).toEqual(["human-tool", "own-coding_worker-rag"]);
    expect(s.patterns.sort()).toEqual([mcpPattern("human-tool"), mcpPattern("own-coding_worker-rag")].sort());
  });
});

describe("toLoadedMcpConfig · 自己的条目带 cwd、不带凭据;人的那一半不变", () => {
  it("③ 自己的服务:cwd = 工具目录,enabled + direct,source 指向那个 mcp.json", () => {
    ownTool("coding_worker", "rag", { command: "python", args: ["server.py"], env: { PYTHONUNBUFFERED: "1" } });
    const s = solveMcpFor(deps(), agentOf("cw"), loadProjectForAuthz(db, "p1"));
    const r = toLoadedMcpConfig(s, dataDir, undefined);
    const own = r.config.servers.find((x) => x.name === "own-coding_worker-rag");
    expect(own?.config).toMatchObject({
      type: "stdio", command: "python", args: ["server.py"], enabled: true,
      exposure: "direct", env: { PYTHONUNBUFFERED: "1" },
      cwd: join(workRoot, "roles", "coding_worker", "tools", "rag"),
    });
    expect(own?.source).toBe("sansheng:roles/coding_worker/tools/rag/mcp.json");
    expect(r.unresolved).toEqual([]);
    expect(r.config.autoEnableCodemode).toBe(false);
  });

  it("④ 人的目录那一半:没有 cwd,source 仍是 servers.json,未授权的仍是 hidden", () => {
    const w = writeMcpCatalog(dataDir, {
      servers: [{ name: "human-tool", transport: "stdio", command: "node" }], state: "ok", path: "", problem: undefined,
    }, 1);
    expect(w.ok, JSON.stringify(w)).toBe(true);
    const s = solveMcpFor(deps(), agentOf("cw"), loadProjectForAuthz(db, "p1"));
    const r = toLoadedMcpConfig(s, dataDir, undefined);
    const human = r.config.servers.find((x) => x.name === "human-tool");
    expect(human?.config).toMatchObject({ enabled: false, exposure: "hidden" });
    expect(human?.config).not.toHaveProperty("cwd");
    expect(human?.source).toContain("servers.json");
  });
});
