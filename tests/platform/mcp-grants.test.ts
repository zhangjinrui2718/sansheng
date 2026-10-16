/**
 * MCP · 角色授权文件(`harness/mcp/{role}.json`)
 *
 * ── 这一组守着的**核心**是「退化方向」 ────────────────────────────
 *
 * 授权文件坏掉时必须退化成 **零授权**。这与 `harness/toolSet.ts` 的方向**相反**
 * (那里坏文件退化成 `ceiling` 全集 = **放宽**),而两条断言在同一个测试里,
 * 互为对照 —— 只改一边不会让任何东西变红,那正是它危险的地方。
 *
 *   tools/{role}.json 坏 ⇒ 按 ceiling 全集(**更宽**,可见)
 *   mcp/{role}.json   坏 ⇒ 零授权(**更严**,可见)
 *
 * 理由:集合文件是**收窄**机制,「全放行」= 回到出厂状态;而 MCP 授权是**增量**
 * 机制,「全放行」没有任何东西可回落 —— 那是一次笔误换一次**静默提权**。
 *
 * 另外三件事:两个字段缺一即 invalid;路径穿越被挡;`unknownServers` 如实报出。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGrantFile, readGrantFile, writeGrantFile, resolveAllGrants, grantPath,
  mcpForDataDir, grantedRolesOf, listGrantBackups, strayMcpFiles,
} from "../../src/platform/mcp/grants.js";
import { resolveToolSet, toolSetDir } from "../../src/platform/harness/toolSet.js";
import { solveToolset } from "../../src/platform/harness/authorize.js";
import { ROLE_SPECS } from "../../src/platform/identity/role.js";
import type { Agent } from "../../src/platform/harness/authorize.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sansheng-mcp-grant-"));
  dirs.push(d);
  return d;
}

function writeRaw(dataDir: string, role: string, text: string): void {
  mkdirSync(join(dataDir, "harness", "mcp"), { recursive: true });
  writeFileSync(join(dataDir, "harness", "mcp", `${role}.json`), text, "utf8");
}

const pmAgent: Agent = { id: "a1", role: "project_manager", displayName: "PM" };
const project = { id: "p1", name: "P", status: "active" as const, assignments: [{ agentId: "a1" }] };

describe("mcp-grants · 形状纪律", () => {
  it("`allow` 与 `deny` **缺一即 invalid**(不是「缺 deny 就当空 deny」)", () => {
    expect(parseGrantFile({ allow: ["docs"], deny: [] }).ok).toBe(true);
    expect(parseGrantFile({ allow: ["docs"] }).ok).toBe(false);
    expect(parseGrantFile({ deny: [] }).ok).toBe(false);
    expect(parseGrantFile({ allow: ["docs"], deny: "x" }).ok).toBe(false);
    expect(parseGrantFile({ allow: [1], deny: [] }).ok).toBe(false);
    expect(parseGrantFile([]).ok).toBe(false);
  });

  it("报出的原因说得清**缺的是哪一条**", () => {
    const p = parseGrantFile({ allow: [] });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.detail).toContain("deny");
  });

  it("没有文件 ⇒ `absent` 且 file 为 undefined(= 零授权)", () => {
    const r = readGrantFile(tmp(), "project_manager");
    expect(r.state).toBe("absent");
    expect(r.file).toBeUndefined();
    expect(r.problem).toBeUndefined();
  });

  it("坏文件 ⇒ `invalid` + problem 可见", () => {
    const d = tmp();
    writeRaw(d, "project_manager", "{ 坏");
    const r = readGrantFile(d, "project_manager");
    expect(r.state).toBe("invalid");
    expect(r.problem).toContain("零授权");
  });

  it("空文件 ≠ 空名单:坏文件处置,但两条都不给权限", () => {
    const d = tmp();
    writeRaw(d, "project_manager", "");
    const r = readGrantFile(d, "project_manager");
    expect(r.state).toBe("invalid");
    expect(r.file).toBeUndefined();
  });
});

describe("mcp-grants · ⚠️ 坏授权文件 ⇒ 零授权(与 toolset 的方向**相反**)", () => {
  it("对照:坏 toolset 退化成 ceiling **全集**(更宽)", () => {
    const d = tmp();
    mkdirSync(toolSetDir(d), { recursive: true });
    writeFileSync(join(toolSetDir(d), "project_manager.json"), "{ 坏", "utf8");
    const r = resolveToolSet(d, "project_manager");
    expect(r.state).toBe("invalid");
    expect(r.file, "集合文件的退化是「按 ceiling 全集」").toBeUndefined();
    const solved = solveToolset(pmAgent, project, r.file);
    const ceiling = ROLE_SPECS["project_manager"].ceiling.length;
    expect(solved.capabilities.length, "退化成 ceiling 全集 ⇒ 能力一条不少").toBe(ceiling);
  });

  it("对照:坏 MCP 授权文件 ⇒ **零授权**(更严)", () => {
    const d = tmp();
    writeRaw(d, "project_manager", "{ 坏");
    const r = readGrantFile(d, "project_manager");
    expect(r.state).toBe("invalid");
    expect(r.file).toBeUndefined();
    expect(mcpForDataDir(d)("project_manager")).toBeUndefined();
  });

  it("两条退化**方向相反**,且都不是「无信息」:各有 problem", () => {
    const d = tmp();
    mkdirSync(toolSetDir(d), { recursive: true });
    writeFileSync(join(toolSetDir(d), "project_manager.json"), "{ 坏", "utf8");
    writeRaw(d, "project_manager", "{ 坏");
    expect(resolveToolSet(d, "project_manager").problem).toBeDefined();
    expect(readGrantFile(d, "project_manager").problem).toBeDefined();
  });

  it("⚠️ 授权的退化方向在源码里写明了理由(防止后来者「顺手改成一致」)", () => {
    const src = readFileSync("src/platform/mcp/grants.ts", "utf8");
    expect(src).toContain("与 `harness/toolSet.ts`");
    expect(src).toContain("静默提权");
  });
});

describe("mcp-grants · 路径穿越", () => {
  it("非角色名直接抛错(类型上的闭合联合也要有运行期防线)", () => {
    const d = tmp();
    const bogus = "../../settings" as unknown as "project_manager";
    expect(() => grantPath(d, bogus)).toThrow(/PROJECT_ROLES/);
  });

  it("目录里非角色的 `.json` 会被报成 stray(而不是被读)", () => {
    const d = tmp();
    writeRaw(d, "project_manager", '{"allow":["docs"],"deny":[]}');
    writeRaw(d, "project-managers", '{"allow":["docs"],"deny":[]}');
    expect(strayMcpFiles(d)).toEqual(["project-managers.json"]);
    expect(readGrantFile(d, "project_manager").file).toEqual({ allow: ["docs"], deny: [] });
  });
});

describe("mcp-grants · unknownServers 由 solve 层如实报出(这里只测输入侧)", () => {
  it("授权文件里的名字被原样交给 solve —— 它不在这一层被过滤", () => {
    const d = tmp();
    writeRaw(d, "project_manager", '{"allow":["docs","ghost"],"deny":[]}');
    expect(readGrantFile(d, "project_manager").file?.allow).toEqual(["docs", "ghost"]);
  });
});

describe("mcp-grants · 写面(四条规矩)", () => {
  it("报成功 = **回读**磁盘上那份,且备份真的落盘", () => {
    const d = tmp();
    const t = 1_700_000_000_000;
    const first = writeGrantFile(d, "project_manager", { allow: ["docs"], deny: [] }, t);
    expect(first.ok).toBe(true);
    expect(JSON.parse(readFileSync(grantPath(d, "project_manager"), "utf8"))).toEqual({
      allow: ["docs"],
      deny: [],
    });
    const second = writeGrantFile(d, "project_manager", { allow: ["docs", "sentry"], deny: [] }, t + 1);
    expect(second.ok).toBe(true);
    expect(second.backupPath).toBeDefined();
    expect(readFileSync(second.backupPath as string, "utf8")).toContain('"docs"');
    expect(listGrantBackups(d, "project_manager").length).toBe(1);
  });

  it("备份保留 10 份(更早的被裁掉)", () => {
    const d = tmp();
    for (let i = 0; i < 13; i++) {
      writeGrantFile(d, "project_manager", { allow: [`s${i}`], deny: [] }, 1_700_000_000_000 + i);
    }
    expect(listGrantBackups(d, "project_manager").length).toBe(10);
    const dir = join(d, "harness", "backups", "mcp");
    expect(readdirSync(dir).length).toBe(10);
  });

  it("未知角色 → 拒(不落盘)", () => {
    const d = tmp();
    const r = writeGrantFile(d, "boss" as unknown as "project_manager", { allow: ["x"], deny: [] }, 1);
    expect(r.ok).toBe(false);
    expect(readGrantFile(d, "project_manager").state).toBe("absent");
  });

  it("grantedRolesOf 读的是**授权文件本身**(不是内存态)", () => {
    const d = tmp();
    writeRaw(d, "project_manager", '{"allow":["docs"],"deny":[]}');
    writeRaw(d, "business_manager", '{"allow":["docs","sentry"],"deny":[]}');
    expect(grantedRolesOf(d, "docs")).toEqual(["business_manager", "project_manager"]);
    expect(grantedRolesOf(d, "sentry")).toEqual(["business_manager"]);
    expect(grantedRolesOf(d, "ghost")).toEqual([]);
  });

  it("resolveAllGrants 覆盖全部五个角色(顺序稳定)", () => {
    expect(resolveAllGrants(tmp()).map((r) => r.role)).toEqual([
      "business_manager",
      "project_manager",
      "research_worker",
      "coding_worker",
      "quality_reviewer",
    ]);
  });
});
