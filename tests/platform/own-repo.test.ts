/**
 * 自己的仓库(migration 040,2026-11-28)· 回归 —— 扫描与校验 + `own_read` / `own_write`
 *
 * ── 这一文件守的是五条硬要求 ───────────────────────────────────
 *
 *   ① **有仓库的角色 / 能提交 MCP 的角色都从 ceiling 推出来**,不另写一张角色表。
 *   ② **格式不对如实报原因**(缺说明书、坏 JSON、名字不合法、质检写了 mcp.json)——
 *      悄悄跳过 = 一个静默失效的工具。
 *   ③ **这两个工具只够得着自己的仓库**:`..`、仓库外的绝对路径、软链逃逸、`.git/` 都拒;
 *      仓库内的绝对路径认。
 *   ④ **写完当场回话**:合法的说「下一轮起可用」,不合法的把原因带回去,停用的提醒他。
 *   ⑤ **别的角色拿不到**:业务经理直接调被派发器拒;研究员借它写不进项目仓。
 *
 * 宿主收尾(提交 + 换会话)在 `own-kit-host.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { getAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { agentWorkspaceRoot, projectWorkspaceRoot } from "../../src/platform/workspace/root.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import {
  OWN_REPO_ROLES, canRunOwnMcp, ownMcpServerName, ownsRepo, parseSkillFrontmatter,
  scanOwnTools, validateOwnMcp,
} from "../../src/platform/harness/ownTools.js";
import { setOwnToolDisabled } from "../../src/platform/storage/repo/agentTools.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import { PROJECT_ROLES, ROLE_SPECS } from "../../src/platform/identity/role.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";

const T0 = 1_700_000_000_000;
const SKILL = (desc = "把一份网页正文抽成干净的文本"): string =>
  ["---", "name: extract-text", `description: ${desc}`, "---", "# extract-text", "", "什么时候用:拿到一个网页要提炼的时候。", "怎么用:`python extract.py <url>`"].join("\n");

let db: Database.Database;
let workRoot = "";
let seq = 0;

beforeEach(() => {
  db = openPlatformMemoryDb();
  ensureOrg(db, T0);
  insertProject(db, { id: "p1", name: "项目一", client: "甲", goal: "g", status: "active", createdAt: T0 });
  ensureProjectOrg(db, "p1", T0);
  workRoot = mkdtempSync(join(tmpdir(), "ss-own-repo-"));
  seq = 0;
});
afterEach(() => {
  db.close();
  rmSync(workRoot, { recursive: true, force: true });
});

function ctx(agentId: string): ToolRunContext {
  const agent = getAgent(db, agentId);
  if (agent === null) throw new Error(`夹具里没有 agent ${agentId}`);
  return {
    db, agent, project: loadProjectForAuthz(db, "p1"), now: () => T0, newId: (p) => `${p}_${++seq}`,
    workspace: createGitWorkspace(), workspaceRoot: workRoot,
  };
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
function put(root: string, rel: string, content: string): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

// ── 根算式与「谁有仓库」 ─────────────────────────────────────────

describe("自己的仓库 · 根算式与角色", () => {
  it("根 = <工作根>/roles/<角色>:绝对路径,与 projects/ 平级,不嵌在项目仓里", () => {
    const root = agentWorkspaceRoot("relative/work", "coding_worker");
    expect(root).toBe(resolve("relative/work", "roles", "coding_worker"));
    expect(root.endsWith(join("roles", "coding_worker"))).toBe(true);
    const project = projectWorkspaceRoot("relative/work", "p1");
    expect(project.startsWith(root)).toBe(false);
    expect(root.startsWith(project)).toBe(false);
  });

  it("① 有仓库的 = ceiling 里带 own.write 的(恰好三个执行角色);能提交 MCP 的 = 带 code.exec 的(质检不算)", () => {
    expect([...OWN_REPO_ROLES].sort()).toEqual(["coding_worker", "quality_reviewer", "research_worker"]);
    for (const role of PROJECT_ROLES) {
      expect(ownsRepo(role), `${role}`).toBe(ROLE_SPECS[role].ceiling.includes("own.write"));
      expect(canRunOwnMcp(role), `${role}`).toBe(ROLE_SPECS[role].ceiling.includes("code.exec"));
    }
    expect(canRunOwnMcp("quality_reviewer")).toBe(false);
    expect(canRunOwnMcp("research_worker")).toBe(true);
    expect(ownMcpServerName("research_worker", "rag")).toBe("own-research_worker-rag");
  });
});

// ── 解析与校验(纯函数)──────────────────────────────────────────

describe("parseSkillFrontmatter · 说明书", () => {
  it("合法:name 可省(= 目录名),description 必需", () => {
    const ok = parseSkillFrontmatter(SKILL(), "extract-text");
    expect(ok).toEqual({ ok: true, name: "extract-text", description: "把一份网页正文抽成干净的文本" });
    const noName = parseSkillFrontmatter("---\ndescription: 只写了说明\n---\n正文", "x");
    expect(noName).toEqual({ ok: true, name: "x", description: "只写了说明" });
  });

  it("② 不合法的三种,各带一句可执行的原因", () => {
    expect(parseSkillFrontmatter("# 没有_frontmatter", "x")).toMatchObject({ ok: false, problem: expect.stringContaining("frontmatter") });
    expect(parseSkillFrontmatter("---\nname: x\n---\n正文", "x")).toMatchObject({ ok: false, problem: expect.stringContaining("description") });
    // 名字 = 目录名(唯一事实来源):frontmatter 里的 name 写什么都不改名字
    expect(parseSkillFrontmatter(SKILL(), "别的目录")).toEqual({ ok: true, name: "别的目录", description: "把一份网页正文抽成干净的文本" });
    expect(parseSkillFrontmatter("---\nname: x\ndescription: 短\n---\n", "x")).toMatchObject({ ok: true });
    expect(parseSkillFrontmatter(`---\nname: x\ndescription: ${"长".repeat(1025)}\n---\n`, "x")).toMatchObject({ ok: false, problem: expect.stringContaining("太长") });
    // 名字里的不合法字符由**目录名**那一关拦(见 scanOwnTools),frontmatter 的 name 不参与
  });
});

describe("validateOwnMcp · mcp.json", () => {
  it("合法的 stdio 声明", () => {
    const r = validateOwnMcp({ command: "python", args: ["server.py"], env: { PYTHONUNBUFFERED: "1" } }, { canExec: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.def.transport).toBe("stdio");
      expect(r.def.command).toBe("python");
      expect(r.def.env).toEqual({ PYTHONUNBUFFERED: "1" });
    }
  });

  it("② 另加的三条 + 复用人的目录那套:`url` / `headers` / `${变量}` / `!cmd` 都拒", () => {
    expect(validateOwnMcp({ url: "https://example.com/mcp" }, { canExec: true })).toMatchObject({ ok: false, problem: expect.stringContaining("url") });
    expect(validateOwnMcp({ command: "x", headers: { Authorization: "Bearer t" } }, { canExec: true })).toMatchObject({ ok: false, problem: expect.stringContaining("headers") });
    expect(validateOwnMcp({ command: "x", env: { KEY: "${ANTHROPIC_API_KEY}" } }, { canExec: true })).toMatchObject({ ok: false, problem: expect.stringContaining("环境变量") });
    expect(validateOwnMcp({ command: "x", env: { KEY: "!cat ~/.ssh/id_rsa" } }, { canExec: true })).toMatchObject({ ok: false });
    expect(validateOwnMcp({ command: "x", args: "not-an-array" }, { canExec: true })).toMatchObject({ ok: false });
    expect(validateOwnMcp([], { canExec: true })).toMatchObject({ ok: false });
  });

  it("② 没有跑命令能力的角色(质检)写 MCP ⇒ 不生效,并说清为什么", () => {
    const r = validateOwnMcp({ command: "python", args: ["server.py"] }, { canExec: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("跑命令");
  });
});

describe("scanOwnTools · 仓库就是真相", () => {
  it("目录不在 = 读不到(missing),与「还没有工具」(ready + 空)分开", () => {
    const missing = join(workRoot, "roles", "nobody");
    expect(scanOwnTools(missing, { canExec: true })).toEqual({ root: missing, state: "missing", tools: [] });
    const empty = agentWorkspaceRoot(workRoot, "coding_worker");
    mkdirSync(empty, { recursive: true });
    expect(scanOwnTools(empty, { canExec: true })).toEqual({ root: empty, state: "ready", tools: [] });
    put(empty, "README.md", "x");
    expect(scanOwnTools(empty, { canExec: true }).tools).toEqual([]);
  });

  it("② 一个说明类 + 一个 MCP + 三种不合法,按名字排序,各带状态;文件数跳过依赖目录", () => {
    const root = agentWorkspaceRoot(workRoot, "coding_worker");
    put(root, "tools/zeta/SKILL.md", SKILL());
    put(root, "tools/alpha/SKILL.md", SKILL("检索我自己的调研笔记"));
    put(root, "tools/alpha/mcp.json", JSON.stringify({ command: "python", args: ["server.py"] }));
    put(root, "tools/alpha/server.py", "print('hi')");
    put(root, "tools/alpha/node_modules/dep/index.js", "// 依赖");
    // 不合法 1:缺 description
    put(root, "tools/nodesc/SKILL.md", "---\nname: nodesc\n---\n正文");
    // 不合法 2:mcp.json 坏了
    put(root, "tools/badmcp/SKILL.md", SKILL());
    put(root, "tools/badmcp/mcp.json", "{ not json");
    // 不合法 3:目录名不合法
    put(root, "tools/有 空格/SKILL.md", SKILL());
    // 杂物不算是工具
    put(root, "tools/.DS_Store", "");
    put(root, "tools/notes.txt", "");

    const scan = scanOwnTools(root, { canExec: true });
    expect(scan.state).toBe("ready");
    expect(scan.tools.map((t) => t.name)).toEqual(["alpha", "badmcp", "nodesc", "zeta", "有 空格"]);
    const alpha = scan.tools.find((t) => t.name === "alpha");
    expect(alpha).toMatchObject({ kind: "mcp", problem: null, fileCount: 3, description: "检索我自己的调研笔记" });
    expect(alpha?.mcp?.def.command).toBe("python");
    expect(scan.tools.find((t) => t.name === "zeta")).toMatchObject({ kind: "skill", problem: null, fileCount: 1 });
    expect(scan.tools.find((t) => t.name === "nodesc")?.problem).toContain("description");
    expect(scan.tools.find((t) => t.name === "badmcp")).toMatchObject({ kind: "mcp", problem: expect.stringContaining("JSON") });
    expect(scan.tools.find((t) => t.name === "有 空格")?.problem).toContain("目录名");
  });

  it("同一个仓库,质检看那条 MCP 是「格式不对」(它试跑不了),工程师看是合法的", () => {
    const root = agentWorkspaceRoot(workRoot, "quality_reviewer");
    put(root, "tools/alpha/SKILL.md", SKILL());
    put(root, "tools/alpha/mcp.json", JSON.stringify({ command: "python" }));
    expect(scanOwnTools(root, { canExec: false }).tools[0]?.problem).toContain("跑命令");
    expect(scanOwnTools(root, { canExec: true }).tools[0]?.problem).toBeNull();
  });
});

// ── own_read / own_write ────────────────────────────────────────

describe("own_write / own_read · 只够得着自己的仓库", () => {
  it("写进自己的仓库并读回来;父目录按需建;写的是工具文件时当场回话", () => {
    const w = call("own_write", { path: "tools/extract-text/SKILL.md", content: SKILL() }, "cw");
    expect(w.ok).toBe(true);
    expect(okText(w)).toContain("已写入");
    expect(okText(w)).toContain("下一轮起会列在你面前");
    const r = call("own_read", { path: "tools/extract-text/SKILL.md" }, "cw");
    expect(okText(r)).toContain("# extract-text");
    // 真的落在 <工作根>/roles/coding_worker/ 下
    expect(existsSync(join(agentWorkspaceRoot(workRoot, "coding_worker"), "tools", "extract-text", "SKILL.md"))).toBe(true);
  });

  it("④ 写 mcp.json:能跑命令的角色得到「下一轮起出现在工具面上」;质检得到「不可用」与原因", () => {
    call("own_write", { path: "tools/rag/SKILL.md", content: SKILL() }, "cw");
    const cw = okText(call("own_write", { path: "tools/rag/mcp.json", content: JSON.stringify({ command: "python", args: ["server.py"] }) }, "cw"));
    expect(cw).toContain("下一轮起");
    expect(cw).toContain("mcp__own_coding_worker_rag__*");
    call("own_write", { path: "tools/rag/SKILL.md", content: SKILL() }, "qa");
    const qa = okText(call("own_write", { path: "tools/rag/mcp.json", content: JSON.stringify({ command: "python" }) }, "qa"));
    expect(qa).toContain("不可用");
    expect(qa).toContain("跑命令");
    // 缺 description 的说明书:当场指出来
    const bad = okText(call("own_write", { path: "tools/nodesc/SKILL.md", content: "---\nname: nodesc\n---\n正文" }, "cw"));
    expect(bad).toContain("不可用");
    expect(bad).toContain("description");
  });

  it("③ 越界一律拒:`..`、仓库外的绝对路径、`.git/`、软链逃逸;仓库内的绝对路径认", () => {
    const outside = mkdtempSync(join(tmpdir(), "ss-own-outside-"));
    try {
      const root = agentWorkspaceRoot(workRoot, "coding_worker");
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, join(root, "evil"));
      const cases: Array<[string, string]> = [
        ["../research_worker/x.md", "向上逃到别的角色的仓库"],
        [join(workRoot, "projects", "p1", "artifacts", "evil.md"), "项目仓里的绝对路径"],
        [join(outside, "evil.md"), "仓库外的绝对路径"],
        ["evil/evil.md", "经软链逃出去"],
        [".git/config", "版本库内部"],
        ["/etc/hosts", "系统文件"],
      ];
      for (const [path, why] of cases) {
        const r = call("own_write", { path, content: "x" }, "cw");
        expect(r.ok, `${why}:${path}`).toBe(false);
        if (!r.ok) expect(r.code, why).toBe("denied");
      }
      // 读面同一道门
      expect(call("own_read", { path: "../../etc/hosts" }, "cw").ok).toBe(false);
      expect(call("own_read", { path: "evil/evil.md" }, "cw").ok).toBe(false);
      // 负样本:仓库内的绝对路径**认**(上下文里给的就是绝对路径)
      const abs = okText(call("own_write", { path: join(root, "tools", "abs", "SKILL.md"), content: SKILL() }, "cw"));
      expect(abs).toContain("已写入");
      expect(okText(call("own_read", { path: join(root, "tools", "abs", "SKILL.md") }, "cw"))).toContain("extract-text");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("⑤ 研究员借它写不进项目仓;业务经理连工具都拿不到(派发器再判一次)", () => {
    const r = call("own_write", { path: "../../projects/p1/artifacts/evil.md", content: "x" }, "wk");
    expect(r.ok).toBe(false);
    expect(existsSync(join(projectWorkspaceRoot(workRoot, "p1"), "artifacts", "evil.md"))).toBe(false);
    const bm = call("own_write", { path: "tools/x/SKILL.md", content: SKILL() }, "bm");
    expect(bm.ok).toBe(false);
    if (!bm.ok) expect(bm.code).toBe("denied");
    // 而研究员在项目仓里仍然没有 write / edit(边界原样)
    expect(ROLE_SPECS.research_worker.ceiling.includes("code.write")).toBe(false);
    expect(ROLE_SPECS.research_worker.boundaryDeny).toContain("write");
  });

  it("读不到的如实说;单文件超限拒收;读超大文件截断并注明", () => {
    expect(call("own_read", { path: "nope.md" }, "cw").ok).toBe(false);
    const big = call("own_write", { path: "big.txt", content: "字".repeat(200 * 1024 + 1) }, "cw");
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.code).toBe("invalid_args");
    put(agentWorkspaceRoot(workRoot, "coding_worker"), "long.txt", "a".repeat(40_500));
    const r = okText(call("own_read", { path: "long.txt" }, "cw"));
    expect(r).toContain("只读了前 40000 个");
  });

  it("④ 甲方停用过的工具:往里写东西时提醒他「改它不会让它恢复」", () => {
    const root = agentWorkspaceRoot(workRoot, "coding_worker");
    put(root, "tools/rag/SKILL.md", SKILL());
    expect(setOwnToolDisabled(db, { id: "atd_1", agentId: "cw", toolName: "rag", disabled: true, now: T0 })).toBe(true);
    // 幂等:再停一次不改行
    expect(setOwnToolDisabled(db, { id: "atd_2", agentId: "cw", toolName: "rag", disabled: true, now: T0 })).toBe(false);
    const w = okText(call("own_write", { path: "tools/rag/SKILL.md", content: SKILL() }, "cw"));
    expect(w).toContain("甲方停用了");
    expect(setOwnToolDisabled(db, { id: "atd_3", agentId: "cw", toolName: "rag", disabled: false, now: T0 })).toBe(true);
    expect(setOwnToolDisabled(db, { id: "atd_4", agentId: "cw", toolName: "rag", disabled: false, now: T0 })).toBe(false);
  });

  it("工作区没装配时如实报装配错误(不是「写成功了」也不是「路径不对」)", () => {
    const agent = getAgent(db, "cw");
    if (agent === null) throw new Error("夹具里没有 cw");
    const bare: ToolRunContext = { db, agent, project: loadProjectForAuthz(db, "p1"), now: () => T0, newId: (p) => `${p}_x` };
    const r = dispatch("own_write", { path: "a.md", content: "x" }, bare);
    if (r instanceof Promise) throw new Error("sync only");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });
});
