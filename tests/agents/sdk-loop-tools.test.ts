/**
 * 批次 8-A · SDK 内置工具接进 planner/executor 的工具循环
 *
 * 本文件守的是 2026-10-03 角色职能核查的头号发现(见 docs/AGENT-AUDIT-2026-10-03.md §1.3):
 * **集合文件说执行者有 13 个工具,工具循环里真的只有 6 个** —— read / grep / find / ls /
 * edit / write / bash 从来没被接进 `buildOrchestratorTools`,而同一份出厂提示词正在教
 * 模型用它们。没有本文件,这个洞可以再开一年没人发现:它不报错、不崩、只是让模型
 * 「工具失败 → 编造」,而所有测试都绿。
 *
 * 四组断言:
 *  1. **7 个 SDK 工具真的被构造出来**(不是空数组,不是 undefined 的工厂)。
 *  2. **它们真的能干活**:在临时 cwd 里 read / write / bash / grep 各跑一次。
 *  3. **工具错误回灌成文本而不是抛出整轮**(模型要能换个参数重试)。
 *  4. **不变量:集合文件不许再说谎** —— 对每个角色,`tools/{role}.json` 的 allowed
 *     必须是工具池的子集。**这条是本批的真正防线**:以后往池子里加/减工具、
 *     改集合文件,一旦又出现「配置说有、执行点没有」,这里立刻红。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSdkLoopTools, LOOP_SDK_TOOL_NAMES } from "../../src/server/harness/sdkTools.js";
import { ensureHarness } from "../../src/server/harness/loader.js";
import { TOOL_ROLES, loadToolSets } from "../../src/server/harness/tools.js";
import { buildOrchestratorTools } from "../../src/server/agents/orchestrator.js";
import { Storage } from "../../src/server/storage/db.js";

let cwd: string;
let dataDir: string;
let dir: string;
let storage: Storage;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ss-sdk-loop-"));
  dataDir = mkdtempSync(join(tmpdir(), "ss-sdk-loop-data-"));
  dir = mkdtempSync(join(tmpdir(), "ss-sdk-loop-db-"));
  writeFileSync(join(cwd, "hello.txt"), "你好,sansheng", "utf-8");
  storage = new Storage(join(dir, "sansheng.db"));
});

afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("8-A · SDK 内置工具桥接", () => {
  it("① 7 个工具都被构造出来(read / grep / find / ls / edit / write / bash)", async () => {
    const tools = await createSdkLoopTools(cwd);
    expect(tools.map((t) => t.name).sort()).toEqual([...LOOP_SDK_TOOL_NAMES].sort());
    // read 被两个工厂各产出一次,必须按名去重(否则协议段里出现两条 read)
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) expect(t.description.length).toBeGreaterThan(0);
  });

  it("② 它们真的能干活:read / write / bash / grep 各跑一次", async () => {
    const byName = new Map((await createSdkLoopTools(cwd)).map((t) => [t.name, t]));
    expect((await byName.get("read")!.run({ path: "hello.txt" }))).toContain("你好,sansheng");
    expect((await byName.get("ls")!.run({ path: "." }))).toContain("hello.txt");
    expect((await byName.get("grep")!.run({ pattern: "sansheng", path: "." }))).toContain("hello.txt");
    await byName.get("write")!.run({ path: "out.txt", content: "写进去的内容" });
    expect(readFileSync(join(cwd, "out.txt"), "utf-8")).toBe("写进去的内容");
    expect((await byName.get("bash")!.run({ command: "echo shengsheng-ok" }))).toContain("shengsheng-ok");
  });

  it("③ 参数错误回灌成 [工具失败] 文本,不抛 —— 模型要能换个参数重试", async () => {
    const byName = new Map((await createSdkLoopTools(cwd)).map((t) => [t.name, t]));
    const out = await byName.get("read")!.run({});
    expect(out.startsWith("[工具失败]")).toBe(true);
  });

  it("④ 不变量:每个角色的集合文件都不许声称拥有池子里没有的工具", async () => {
    ensureHarness(dataDir);
    const sets = loadToolSets(dataDir);
    // 生产同款工具池(与 orchestrator 构造时完全同一条路径)
    const pool = new Set((await buildOrchestratorTools(storage, cwd)).map((t) => t.name));
    const lied: string[] = [];
    for (const role of TOOL_ROLES) {
      for (const tool of sets[role].allowed) {
        if (!pool.has(tool)) lied.push(`${role} 声称有 ${tool}`);
      }
    }
    expect(lied).toEqual([]);
  });

  it("⑤ 出厂提示词承诺的能力必须真的在池子里(提示词不许教不存在的工具)", async () => {
    ensureHarness(dataDir);
    const sets = loadToolSets(dataDir);
    const pool = new Set((await buildOrchestratorTools(storage, cwd)).map((t) => t.name));
    // promptUnits.ts 的 executor 单元明写「读 / 检索 / 列目录 / 编辑 / 写入 / 执行命令」
    for (const promised of ["read", "grep", "ls", "edit", "write", "bash"]) {
      expect(pool.has(promised)).toBe(true);
      expect(sets.executor.allowed).toContain(promised);
    }
  });
});