/**
 * 批次 7-E · harness 工具集合(src/server/harness/tools.ts)
 *
 * 本文件守的是三件事,每件都是**权限面**的正确性,不是格式正确性:
 *
 *   1. **ceiling 突破不了**(架构护栏):批次 5b-1 P3 有一条已生效的裁决
 *      (jev A 方案 conf 1.00)—— 沟通员从机制上杜绝直接干活。集合文件一旦变成
 *      用户可写,最自然的失败模式就是有人往 communicator.json 里写 "bash"。
 *      这里断言:写了会被拒绝、进 blockedByCeiling、产生 warning,且**不影响
 *      其余合法条目**。这是本模块存在的核心理由。
 *
 *   2. **fail-closed**(解析器健壮性):权限面上「读不懂配置」绝不能退化成
 *      「放行一切」。断言损坏 JSON / 顶层非对象 / allow 非数组 / 工具名不存在
 *      / 顶层字段拼错(allowed vs allow)—— 五种坏输入全部退回或收窄,
 *      绝不产出超出 ceiling 的 allowed。
 *
 *   3. **不覆盖用户手笔**(harness = 雇员手册,雇主手笔至上):ensureToolSets
 *      的三分支语义与 ensureHarness 同源。
 *
 * 与既有测试的分工:
 *   - communicator-readonly-tools.test.ts 是**端到端**那一条(真 createAgentSession,
 *     断言 session 上真的没有 bash/edit/write);本文件是**语义**层,不触网。
 *   - harness-loader.test.ts 守 prompt 版本链;本文件守 toolSets 版本链的 v1 语义。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TOOL_ROLES,
  ensureToolSets,
  loadToolSets,
  roleToolCeiling,
  toolSetFilePath,
} from "../../src/server/harness/tools.js";
import { ensureHarness, loadHarness } from "../../src/server/harness/loader.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-tool-sets-"));
});

afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** 写一份用户手笔的集合文件(裸字符串,故意绕过序列化以覆盖畸形输入)。 */
function writeSet(role: string, content: string): void {
  writeFileSync(toolSetFilePath(dataDir, role as (typeof TOOL_ROLES)[number]), content, "utf-8");
}

describe("harness 工具集合 · 生成与读取(批次 7-E)", () => {
  it("ensureToolSets 为全部 7 个角色生成集合文件(含 harness_manager)", () => {
    ensureToolSets(dataDir);
    for (const role of TOOL_ROLES) {
      const text = readFileSync(toolSetFilePath(dataDir, role), "utf-8");
      const parsed: unknown = JSON.parse(text);
      expect(parsed).toMatchObject({ allow: expect.any(Array), deny: expect.any(Array) });
    }
  });

  it("ensureHarness 一个入口同时生成 prompt 与 tool set(同一 harness 规约面)", () => {
    ensureHarness(dataDir);
    expect(loadHarness(dataDir).toolSets.communicator.source).toBe("factory");
  });

  it("出厂:communicator 拿只读四件套;其余角色 allow 为空(enforced=false 如实标注)", () => {
    ensureToolSets(dataDir);
    const sets = loadToolSets(dataDir);

    expect(sets.communicator.allowed).toEqual(["read", "grep", "find", "ls"]);
    expect(sets.communicator.enforced).toBe(true);

    // 没工具循环的角色**不能**拿到一份非空名单 —— 那是换个姿势继续撒谎
    for (const role of ["planner", "executor", "harness_manager", "critic", "memory", "reflection"] as const) {
      expect(sets[role].allowed, `${role} 无工具循环,出厂集合必须为空`).toEqual([]);
      expect(sets[role].enforced, `${role} 不得谎报已生效`).toBe(false);
      expect(sets[role].enforceBasis.length).toBeGreaterThan(0); // 必须说清为什么没接线
    }
  });

  it("幂等:连续两次 ensureToolSets 不产生漂移,且用户手笔不被覆盖", () => {
    ensureToolSets(dataDir);
    const first = readFileSync(toolSetFilePath(dataDir, "communicator"), "utf-8");
    ensureToolSets(dataDir);
    expect(readFileSync(toolSetFilePath(dataDir, "communicator"), "utf-8")).toBe(first);

    writeSet("communicator", JSON.stringify({ allow: ["read"], deny: ["grep"] }));
    ensureToolSets(dataDir);
    expect(readFileSync(toolSetFilePath(dataDir, "communicator"), "utf-8")).toContain('"deny"');
    expect(loadToolSets(dataDir).communicator.source).toBe("user");
  });

  it("缺文件时退回出厂集合(source=factory),不报错", () => {
    const sets = loadToolSets(dataDir); // 从未 ensure 过
    expect(sets.communicator.allowed).toEqual(["read", "grep", "find", "ls"]);
    expect(sets.communicator.source).toBe("factory");
  });
});

describe("harness 工具集合 · ceiling 突破不了(架构护栏)", () => {
  it("用户往 communicator.json 写 bash/write/edit/powershell → 全部被拒,只读四件套不受影响", () => {
    ensureToolSets(dataDir);
    writeSet(
      "communicator",
      JSON.stringify({ allow: ["read", "grep", "find", "ls", "bash", "write", "edit", "powershell"], deny: [] }),
    );
    const set = loadToolSets(dataDir).communicator;

    // 合法条目照常生效(不是「一有越权就整份拒绝」)
    expect(set.allowed).toEqual(["read", "grep", "find", "ls"]);
    // 越权条目逐个可见 —— 提权失败绝不能静默
    expect(set.blockedByCeiling).toEqual(["bash", "write", "edit", "powershell"]);
    expect(set.warnings.join("\n")).toContain("架构上界");
  });

  it("allow ⊄ ceiling 对全部 7 个角色都成立(没有一个角色能自己获得写/执行能力)", () => {
    const all = ["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"];
    ensureToolSets(dataDir);
    for (const role of TOOL_ROLES) {
      writeSet(role, JSON.stringify({ allow: all, deny: [] }));
      const set = loadToolSets(dataDir)[role];
      expect(set.allowed, `${role} 的 allowed 越界`).toEqual([...roleToolCeiling(role)]);
      expect(set.blockedByCeiling.length).toBeGreaterThan(0);
    }
  });

  it("deny 与 allow 冲突时 deny 胜出", () => {
    ensureToolSets(dataDir);
    writeSet("communicator", JSON.stringify({ allow: ["read", "grep"], deny: ["grep"] }));
    const set = loadToolSets(dataDir).communicator;
    expect(set.allowed).toEqual(["read"]);
    expect(set.warnings.join("\n")).toContain("deny 胜出");
  });
});

describe("harness 工具集合 · fail-closed(读不懂配置 ≠ 放行一切)", () => {
  /** 坏输入一律不得让 allowed 超出该角色的 ceiling。 */
  function expectFailClosed(role: "communicator" | "executor", content: string): void {
    writeSet(role, content);
    const set = loadToolSets(dataDir)[role];
    const ceiling = [...roleToolCeiling(role)];
    for (const tool of set.allowed) {
      expect(ceiling, `坏输入产出了越界的 ${tool}`).toContain(tool);
    }
  }

  it("损坏 JSON → 退回出厂集合,并留下 warning(不是空集合,更不是全放行)", () => {
    ensureToolSets(dataDir);
    writeSet("communicator", "{ this is not json");
    const set = loadToolSets(dataDir).communicator;
    expect(set.source).toBe("factory");
    expect(set.allowed).toEqual(["read", "grep", "find", "ls"]);
    expect(set.warnings.join("\n")).toContain("解析失败");
  });

  it("顶层不是对象 → 退回出厂集合", () => {
    ensureToolSets(dataDir);
    writeSet("communicator", JSON.stringify(["read", "bash"]));
    const set = loadToolSets(dataDir).communicator;
    expect(set.source).toBe("factory");
    expect(set.allowed).not.toContain("bash");
  });

  it("allow 不是数组 → 按空处理(fail-closed),并留 warning", () => {
    ensureToolSets(dataDir);
    writeSet("communicator", JSON.stringify({ allow: "read,grep,find,ls" }));
    const set = loadToolSets(dataDir).communicator;
    expect(set.allowed).toEqual([]);
    expect(set.warnings.join("\n")).toContain("fail-closed");
  });

  it("未知工具名被剔除(SDK 闭合联合里不存在的东西不可能被执行)", () => {
    ensureToolSets(dataDir);
    writeSet("communicator", JSON.stringify({ allow: ["read", "fs_read", "shell", "http"], deny: [] }));
    const set = loadToolSets(dataDir).communicator;
    expect(set.allowed).toEqual(["read"]);
    // 特别断言:M3c 老 enabledTools 里的名字确实进不来
    expect(set.allowed).not.toContain("fs_read");
    expect(set.allowed).not.toContain("shell");
    expect(set.warnings.join("\n")).toContain("未知工具名");
  });

  it("顶层字段拼错(allowed 而非 allow)→ 收窄为空 + 明确告警,不是「静默放行」", () => {
    ensureToolSets(dataDir);
    writeSet("communicator", JSON.stringify({ allowed: ["read", "bash"] }));
    const set = loadToolSets(dataDir).communicator;
    expect(set.allowed).toEqual([]);
    expect(set.warnings.join("\n")).toContain("未知字段");
    expect(set.warnings.join("\n")).toContain("allow");
  });

  it("每一种坏输入都不得越界(executor 角色走一遍全谱)", () => {
    ensureToolSets(dataDir);
    for (const bad of [
      "{ broken",
      "[]",
      '"a string"',
      "null",
      JSON.stringify({ allow: 42 }),
      JSON.stringify({ allow: [null, 1, {}, "read"] }),
      JSON.stringify({ allow: ["bash", "write"] }),
      JSON.stringify({ deny: "everything", allow: ["read"] }),
    ]) {
      expectFailClosed("executor", bad);
    }
  });

  it("单个角色文件损坏不影响其他角色", () => {
    ensureToolSets(dataDir);
    writeSet("communicator", "{ broken");
    const sets = loadToolSets(dataDir);
    expect(sets.communicator.source).toBe("factory");
    expect(sets.executor.source).toBe("factory");
    expect(sets.executor.allowed).toEqual([]);
  });
});

describe("harness 工具集合 · ceiling 本身(工具目录自洽性)", () => {
  it("每个角色的 ceiling 都 ⊆ SDK 闭合联合,且不含写/执行类工具", () => {
    ensureToolSets(dataDir);
    for (const role of TOOL_ROLES) {
      const ceiling = roleToolCeiling(role);
      for (const tool of ceiling) {
        expect(["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]).toContain(tool);
        expect(["edit", "write", "bash", "powershell"], `${role} 的 ceiling 含写/执行类工具`).not.toContain(tool);
      }
    }
  });
});
