/**
 * 批次 7-F · harness 工具桥接(src/server/harness/toolBridge.ts)
 *
 * 背景:`src/server/tools/` 的 6 个 sandbox 工具(fs 四件套 + http 两件套)一直都在,
 * 沙箱完备、测试齐全,但**零个 agent 够得着**。本批把它们包成 SDK `ToolDefinition`
 * 经 `createAgentSession({ customTools })` 搬进工具面。
 *
 * 本文件守 4 件事,按重要性:
 *
 *   1. **provider 命名合规**(回归护栏):工具名必须是 `^[a-zA-Z0-9_-]{1,64}$`。
 *      OpenAI / Anthropic / DeepSeek 的 function-name schema 都这样要求 ——
 *      **带点的 `fs.readFile` 会被 provider 直接拒收**。这是「LLM 侧名字 ≠
 *      registry 内部名」的全部理由,一旦有人图省事把 `name` 改成 registry 名,
 *      这条会红(而且只在真机调 provider 时才炸,那时已经晚了)。
 *   2. **授权面不重复实现**:桥接层**不许**按 allowlist 过滤 —— 授权 100% 由
 *      tools.ts 的 allowed 名单决定(SDK isAllowedTool 统一过滤 builtin 与
 *      customTools)。这里断言 catalog / ceiling / BRIDGED_TOOLS 三者的名字面
 *      完全一致,**没有名字只在一处出现**。
 *   3. **上界不放宽**:`canvas_write` / `net_fetch` / `net_post` 已桥接、已测试,
 *      但**不在任何角色的 ceiling 内**。这条是 7-F 里最需要被守住的不变量。
 *   4. **错误必须可辨**:registry 抛的 SandboxError / NetSandboxError 要被渲染成
 *      `[工具失败]` 文本(而不是把 rejection 甩给 SDK 把整轮带崩),且不得被
 *      伪装成成功。沙箱越权必须真的被沙箱挡住。
 *
 * 端到端那一半(真 createAgentSession 后 active tools 到底有没有 canvas_read、
 * 有没有 canvas_write)在 `communicator-readonly-tools.test.ts` —— 那里才是
 * 「桥接 + allowlist 联合生效」的证明。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BRIDGED_TOOLS,
  BRIDGED_TOOL_NAMES,
  TOOL_NAME_PATTERN,
  buildBridgedTools,
  createBridgedTools,
  hasUsableParameters,
} from "../../src/server/harness/toolBridge.js";
import {
  SDK_TOOL_NAMES,
  TOOL_CATALOG,
  TOOL_NAMES,
  TOOL_ROLES,
  ensureToolSets,
  loadToolSets,
  roleToolCeiling,
} from "../../src/server/harness/tools.js";
import { ToolRegistry } from "../../src/server/tools/registry.js";
import { Sandbox } from "../../src/server/tools/sandbox.js";
import { resolveNetPolicy } from "../../src/server/tools/netSandbox.js";

/** 一次调用的记录器 —— 让「桥接层确实代理到了 registry」可断言。 */
interface Call {
  name: string;
  args: unknown;
}

function recordingRegistry(calls: Call[], result: unknown | (() => unknown)): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of BRIDGED_TOOLS) {
    reg.register(
      t.registryName,
      async (args: unknown) => {
        calls.push({ name: t.registryName, args });
        return typeof result === "function" ? (result as () => unknown)() : result;
      },
      `${t.llmName} 测试替身`,
    );
  }
  return reg;
}

function findTool(tools: ReturnType<typeof buildBridgedTools>, name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not built: ${name}`);
  return t;
}

/** SDK 的 execute 签名里只用到前三个参数;其余用不到,省略以便断言。 */
async function callTool(
  tool: ReturnType<typeof findTool>,
  params: unknown,
  signal?: AbortSignal,
): Promise<{ text: string; details: unknown }> {
  const r = await tool.execute("call-1", params as never, signal, undefined, undefined as never);
  const first = r.content[0];
  return { text: first && first.type === "text" ? first.text : "", details: r.details };
}

describe("7-F 工具桥接 · 形状与命名合规", () => {
  it("buildBridgedTools 产出 6 个工具,名字全部符合 provider 的 function-name 约束", () => {
    const tools = buildBridgedTools(new ToolRegistry());
    expect(tools).toHaveLength(6);
    for (const t of tools) {
      expect(TOOL_NAME_PATTERN.test(t.name), `工具名 ${t.name} 不符合 ^[a-zA-Z0-9_-]{1,64}$`).toBe(true);
      // 名字里绝不能出现 registry 的点号记法 —— 那是 provider 拒收的形态
      expect(t.name).not.toContain(".");
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(20);
      // promptSnippet 缺了会被 SDK 从 system prompt 的 Available tools 段里省略,
      // 工具就成了「注册了但模型不知道」的死工具
      expect(t.promptSnippet, `${t.name} 缺 promptSnippet,模型不会在 system prompt 里看到它`).toBeTruthy();
    }
  });

  it("每个工具都有可用的 parameters schema(挡住「忘了写 parameters」的退化)", () => {
    for (const t of buildBridgedTools(new ToolRegistry())) {
      expect(hasUsableParameters(t), `${t.name} 缺 parameters`).toBe(true);
    }
  });

  it("BRIDGED_TOOLS 的名字面与 BRIDGED_TOOL_NAMES 逐项一致(两处漂移会红)", () => {
    expect(BRIDGED_TOOLS.map((t) => t.llmName).sort()).toEqual([...BRIDGED_TOOL_NAMES].sort());
  });

  it("registry 内部名保持点号记法(那是内部标识,不能泄漏给 LLM)", () => {
    expect(BRIDGED_TOOLS.map((t) => t.registryName).sort()).toEqual(
      ["fs.listDir", "fs.readFile", "fs.stat", "fs.writeFile", "http.fetch", "http.postJson"],
    );
  });

  it("SDK 内置 8 个 + 桥接 6 个 = catalog 的 14 个,无遗漏无多余", () => {
    expect(SDK_TOOL_NAMES).toHaveLength(8);
    expect(BRIDGED_TOOL_NAMES).toHaveLength(6);
    expect(TOOL_NAMES).toHaveLength(14);
    expect(Object.keys(TOOL_CATALOG).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("catalog 给每个工具标了来源(sdk / sansheng),UI 靠它区分", () => {
    expect(TOOL_CATALOG.read.origin).toBe("sdk");
    expect(TOOL_CATALOG.canvas_read.origin).toBe("sansheng");
    expect(TOOL_CATALOG.net_post.origin).toBe("sansheng");
  });
});

describe("7-F 工具桥接 · 授权面不被放宽(最需要守住的不变量)", () => {
  it("canvas_write / net_fetch / net_post 不在任何角色的 ceiling 内", () => {
    for (const role of TOOL_ROLES) {
      const ceiling = roleToolCeiling(role);
      for (const tool of ["canvas_write", "net_fetch", "net_post"] as const) {
        expect(ceiling, `${role} 的 ceiling 不得含 ${tool}`).not.toContain(tool);
      }
    }
  });

  it("只读 canvas 三件套在每个角色的 ceiling 内", () => {
    for (const role of TOOL_ROLES) {
      const ceiling = roleToolCeiling(role);
      for (const tool of ["canvas_read", "canvas_list", "canvas_stat"] as const) {
        expect(ceiling, `${role} 的 ceiling 应含 ${tool}`).toContain(tool);
      }
    }
  });

  it("上界里没有写 / 执行 / 网络出口工具(v1 原则:只读面不含任何副作用路径)", () => {
    for (const role of TOOL_ROLES) {
      for (const tool of roleToolCeiling(role)) {
        expect(TOOL_CATALOG[tool].risk, `${role} 上界含 ${tool}(${TOOL_CATALOG[tool].risk})`).toBe("readonly");
      }
    }
  });

  it("出厂 communicator 集合 = 上界全集;其余角色仍为空集合 + enforced:false", () => {
    const sets = loadToolSets(makeDataDir());
    expect(sets.communicator.allowed).toEqual([...roleToolCeiling("communicator")]);
    expect(sets.communicator.allowed).toContain("canvas_read");
    for (const role of ["planner", "executor", "harness_manager", "critic", "memory", "reflection"] as const) {
      expect(sets[role].allowed, `${role} 仍无工具循环,不得给非空出厂名单`).toEqual([]);
      expect(sets[role].enforced).toBe(false);
    }
  });

  it("集合文件里写 canvas_write / net_post → 被 ceiling 拒绝且逐个可见", () => {
    const dir = makeDataDir();
    ensureToolSets(dir);
    writeSet(dir, "communicator", {
      allow: ["read", "canvas_read", "canvas_write", "net_post"],
      deny: [],
    });
    const set = loadToolSets(dir).communicator;
    expect(set.allowed).toEqual(["read", "canvas_read"]);
    expect(set.blockedByCeiling).toEqual(["canvas_write", "net_post"]);
  });
});

describe("7-F 工具桥接 · 确实代理到 ToolRegistry", () => {
  it("canvas_read → registry 的 fs.readFile,并把结果渲染成文本", async () => {
    const calls: Call[] = [];
    const tools = buildBridgedTools(recordingRegistry(calls, { content: "hello canvas", mtimeMs: 42 }));
    const r = await callTool(findTool(tools, "canvas_read"), { path: "notes.md" });

    expect(calls).toEqual([{ name: "fs.readFile", args: { path: "notes.md" } }]);
    expect(r.text).toBe("hello canvas");
    expect(r.details).toMatchObject({ path: "notes.md", mtimeMs: 42 });
  });

  it("canvas_list → fs.listDir,渲染成 kind/size/name 行", async () => {
    const calls: Call[] = [];
    const tools = buildBridgedTools(
      recordingRegistry(calls, [
        { name: "a.md", kind: "file", size: 12, mtimeMs: 1 },
        { name: "sub", kind: "dir" },
      ]),
    );
    const r = await callTool(findTool(tools, "canvas_list"), { path: "." });
    expect(calls[0]?.name).toBe("fs.listDir");
    expect(r.text).toContain("共 2 项");
    expect(r.text).toContain("file 12B");
    expect(r.text).toContain("dir\tsub");
  });

  it("canvas_stat → fs.stat;canvas_write → fs.writeFile;net_fetch → http.fetch", async () => {
    for (const [llm, registryName] of [
      ["canvas_stat", "fs.stat"],
      ["canvas_write", "fs.writeFile"],
      ["net_fetch", "http.fetch"],
      ["net_post", "http.postJson"],
    ] as const) {
      const calls: Call[] = [];
      const tools = buildBridgedTools(
        recordingRegistry(calls, () => {
          if (registryName === "fs.stat") return { kind: "file", size: 3, mtimeMs: 7 };
          if (registryName === "fs.writeFile") return { bytesWritten: 5, mtimeMs: 9 };
          return { status: 200, headers: {}, body: "ok", bodyTruncated: false };
        }),
      );
      await callTool(findTool(tools, llm), llm === "net_post" ? { url: "https://x.test", body: {} } : { path: "p" });
      expect(calls[0]?.name, `${llm} 应代理到 ${registryName}`).toBe(registryName);
    }
  });

  it("可选参数缺省时不下发给 registry(避免把 undefined 塞进沙箱判定)", async () => {
    const calls: Call[] = [];
    const tools = buildBridgedTools(recordingRegistry(calls, { content: "", mtimeMs: 0 }));
    await callTool(findTool(tools, "canvas_read"), { path: "p" });
    expect(calls[0]?.args).toEqual({ path: "p" });
  });

  it("signal 已 abort → reject(对齐 SDK 内置工具的取消语义,不伪装成一次失败调用)", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: Call[] = [];
    const tools = buildBridgedTools(recordingRegistry(calls, { content: "", mtimeMs: 0 }));
    await expect(
      callTool(findTool(tools, "canvas_read"), { path: "p" }, controller.signal),
    ).rejects.toThrow(/aborted/);
    expect(calls, "已取消的调用不该打到 registry").toHaveLength(0);
  });
});

describe("7-F 工具桥接 · 错误可辨 + 沙箱真挡得住", () => {
  it("registry 抛错 → 渲染成 [工具失败] 文本,而不是 rejection", async () => {
    const tools = buildBridgedTools(
      recordingRegistry([], () => {
        throw new Error("path escapes sandbox root");
      }),
    );
    const r = await callTool(findTool(tools, "canvas_read"), { path: "/etc/passwd" });
    expect(r.text.startsWith("[工具失败]")).toBe(true);
    expect(r.text).toContain("canvas_read");
    expect(r.text).toContain("path escapes sandbox root");
    expect(r.text).toContain("不要当成成功结果");
  });

  it("错误码被带进文本(SandboxError 的 code 是模型自我纠正的关键信息)", async () => {
    const tools = buildBridgedTools(
      recordingRegistry([], () => {
        const e = new Error("denied") as Error & { code: string };
        e.code = "denied_root";
        throw e;
      }),
    );
    const r = await callTool(findTool(tools, "canvas_write"), { path: "x", content: "y" });
    expect(r.text).toContain("(denied_root)");
    expect(r.details).toMatchObject({ code: "denied_root" });
  });

  it("【真沙箱】越过允许根的读写都被 SandboxError 挡住,并以 [工具失败] 回到模型", async () => {
    const home = mkdtempSync(join(tmpdir(), "sansheng-bridge-"));
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });
    // 允许根内先放一个真文件 —— 否则「允许根内可读」这半句测的是 ENOENT 而非放行
    writeFileSync(join(workspace, "a.txt"), "allowed content", "utf-8");
    writeFileSync(join(home, "outside.txt"), "secret", "utf-8");

    const { createToolRegistry } = await import("../../src/server/tools/integration.js");
    const registry = await createToolRegistry({
      sandbox: new Sandbox({
        policy: { allowlist: [{ path: workspace, kind: "dir" }], followSymlinks: false },
      }),
      netPolicy: resolveNetPolicy({ allowlist: [] }),
    });
    const tools = buildBridgedTools(registry);

    // 允许根内可读
    const ok = await callTool(findTool(tools, "canvas_read"), { path: join(workspace, "a.txt") });
    expect(ok.text, `允许根内应可读,实际: ${ok.text}`).toBe("allowed content");

    // 越界读:拒绝,且明确可辨
    const denied = await callTool(findTool(tools, "canvas_read"), { path: join(home, "outside.txt") });
    expect(denied.text.startsWith("[工具失败]")).toBe(true);
    expect(denied.details).toMatchObject({ code: expect.stringMatching(/denied|not_allowed|outside/) });

    // 越界写:拒绝 —— 写侧上界没开,沙箱是第二道防线
    const deniedWrite = await callTool(findTool(tools, "canvas_write"), {
      path: join(home, "outside.txt"),
      content: "overwritten",
    });
    expect(deniedWrite.text.startsWith("[工具失败]")).toBe(true);
    // 沙箱真的没让它落盘
    expect(readFileSync(join(home, "outside.txt"), "utf-8")).toBe("secret");

    rmSync(home, { recursive: true, force: true });
  });

  it("【真沙箱】net_fetch 默认 allowlist 为空 → 全部拒绝(不会被桥接层绕过)", async () => {
    const { createToolRegistry } = await import("../../src/server/tools/integration.js");
    const registry = await createToolRegistry({ netPolicy: resolveNetPolicy({ allowlist: [] }) });
    const tools = buildBridgedTools(registry);
    const r = await callTool(findTool(tools, "net_fetch"), { url: "https://example.com/" });
    expect(r.text.startsWith("[工具失败]")).toBe(true);
  });
});

describe("7-F 工具桥接 · createBridgedTools 工厂的降级路径", () => {
  it("policy 文件不可读时返回空数组而不是抛(不能让一个配错的 json 拉起 server)", async () => {
    const tools = await createBridgedTools();
    // 正常环境应拿到 6 个;无论拿没拿到,都不能 throw
    expect(Array.isArray(tools)).toBe(true);
    for (const t of tools) expect(TOOL_NAME_PATTERN.test(t.name)).toBe(true);
  }, 30_000);
});

/* ── 局部工具 ──────────────────────────────────────────────────────────── */

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-bridge-sets-"));
});
afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function makeDataDir(): string {
  return dataDir;
}

function writeSet(dir: string, role: string, content: { allow: string[]; deny: string[] }): void {
  mkdirSync(join(dir, "harness", "tools"), { recursive: true });
  writeFileSync(
    join(dir, "harness", "tools", `${role}.json`),
    `${JSON.stringify(content, null, 2)}\n`,
    "utf-8",
  );
}
