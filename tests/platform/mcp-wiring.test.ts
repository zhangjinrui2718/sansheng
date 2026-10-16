/**
 * MCP · **接线**的机器判据(源码 + wiring 级)
 *
 * ── 为什么这一组必须是「源码级」的 ───────────────────────────────
 *
 * MCP 的四个坑全部是**「代码里写了逻辑,但没人读」**那一类(7-E 的复发):
 *
 *   坑 1  `DefaultResourceLoader` 没传 `extensionFactories` ⇒ SDK 会话里没有 MCP 扩展
 *   坑 2  `bindExtensions` 不会被 `createAgentSession` 自动调用(`sdk.js` 零调用)
 *   坑 3  pi 的 allowlist 在没有 `mcp__` 条目时是 **fail-open** 的
 *   坑 4  pi 的资源工具到达「每个 enabled 且非 hidden 的 server」
 *
 * 前两个坑在**运行时**不可观测:一个没装扩展的会话照样建得出来、照样跑、
 * 照样返回全部平台工具 —— 只有真连一次外部 server 才会暴露,而 Wave 1
 * 连连接状态都读不到。所以判据只能落在**源码字面量**上(与
 * `tests/web/acceptance-dock.test.ts` / `deliverable-render.test.ts` 同款做法)。
 *
 * ⚠️ **每条源码判据都带变异自检**:把真源码里那一段换成**错的写法**喂回检查器,
 * 它必须变红。少了自检,一个恒真的 grep 就只是一句好看的断言(7-D 的形态)。
 * 「剥注释后扫」—— 注释里的反面教材不算命中,否则这份文件会被自己的文档
 * 判成「有 iframe src」。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifyToolset } from "../../src/platform/runtime/sdkAdapter.js";
import { solveMcpFor } from "../../src/platform/mcp/solve.js";
import { mcpPattern } from "../../src/platform/mcp/solve.js";
import type { RuntimeDeps } from "../../src/platform/runtime/assembly.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";

const SESSION_SRC = readFileSync("src/platform/runtime/session.ts", "utf8");
const SDK_ADAPTER_SRC = readFileSync("src/platform/runtime/sdkAdapter.ts", "utf8");
const PI_CONFIG_SRC = readFileSync("src/platform/mcp/piConfig.ts", "utf8");

/** 去掉块注释与行注释 —— 注释里的反面教材不算命中。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const SESSION_CODE = stripComments(SESSION_SRC);

/**
 * 检查器:`src/platform/runtime/session.ts` 里 MCP 扩展装上了没有。
 *
 * 它是**纯函数**(吃源码字符串),所以变异自检可以把改坏的源码喂回去。
 */
function checkMcpExtensionWired(src: string): {
  hasCreateMcpExtension: boolean;
  hasToolSearch: boolean;
  passesExtensionFactories: boolean;
  bindsExtensions: boolean;
  reportsBindError: boolean;
} {
  const code = stripComments(src);
  const hasCreateMcpExtension = /createMcpExtension\s*\(/.test(code);
  const hasToolSearch = /createToolSearchExtension\s*\(/.test(code);
  // `extensionFactories` 那一项必须真的出现在传给 create(...) 的对象里
  const passesExtensionFactories = /extensionFactories\s*[:,]/.test(code);
  const bindsExtensions = /\.bindExtensions\s*\(/.test(code);
  const reportsBindError = /mcpBindError/.test(code);
  return { hasCreateMcpExtension, hasToolSearch, passesExtensionFactories, bindsExtensions, reportsBindError };
}

/** 检查器:pi 配置是不是把「坑 3 / 坑 4」都处理了。 */
function checkPiConfigShape(src: string): {
  autoEnableCodemodeFalse: boolean;
  noProjectConfig: boolean;
  exposureDirect: boolean;
  exposureHidden: boolean;
  enabledFlag: boolean;
} {
  const code = stripComments(src);
  return {
    autoEnableCodemodeFalse: /autoEnableCodemode:\s*false/.test(code),
    // ⚠️ 负判据:源码里**不能**出现 `projectConfig:`(给了 pi 读 `<cwd>/.pi/mcp.json` 的口子)
    noProjectConfig: !/projectConfig\s*:/.test(code),
    exposureDirect: /"direct"/.test(code),
    exposureHidden: /"hidden"/.test(code),
    enabledFlag: /enabled:\s*entry\.granted/.test(code),
  };
}

describe("mcp-wiring · 坑 1:SDK 会话必须装 MCP 扩展", () => {
  it("session.ts 传了 createMcpExtension + createToolSearchExtension,且真的把它们交给 resourceLoader / create()", () => {
    const r = checkMcpExtensionWired(SESSION_SRC);
    expect(r.hasCreateMcpExtension, "没调 createMcpExtension").toBe(true);
    expect(r.hasToolSearch, "没调 createToolSearchExtension").toBe(true);
    expect(r.passesExtensionFactories, "extensionFactories 没有被传出去").toBe(true);
  });

  it("⚠️ 变异自检:把 `extensionFactories` 那段删掉,检查器必须变红", () => {
    // ⚠️ 必须 replaceAll —— `extensionFactories` 在源码里出现多次,
    // 只替换第一次的话检查器照样从**别处**命中 ⇒ 变异自检自己成了假通过。
    const mutated = SESSION_SRC.replaceAll("extensionFactories", "unusedFactories");
    expect(SESSION_SRC.match(/extensionFactories/g)?.length ?? 0).toBeGreaterThan(1);
    expect(checkMcpExtensionWired(mutated).passesExtensionFactories).toBe(false);
  });

  it("⚠️ 变异自检:注释里写 `createMcpExtension(` **不算**接线(判据剥注释)", () => {
    const mutated = SESSION_SRC.replace("createMcpExtension({", "// createMcpExtension({");
    expect(checkMcpExtensionWired(mutated).hasCreateMcpExtension).toBe(false);
  });
});

describe("mcp-wiring · 坑 2:必须显式 bindExtensions,且失败要报出来", () => {
  it("session.ts 调了 bindExtensions,并把失败写进 wiring", () => {
    const r = checkMcpExtensionWired(SESSION_SRC);
    expect(r.bindsExtensions, "没有显式 bindExtensions —— 扩展收不到 session_start").toBe(true);
    expect(r.reportsBindError, "绑定失败没有报进 wiring(会被静默吞掉)").toBe(true);
  });

  it("⚠️ 变异自检:删掉 bindExtensions / 删掉 mcpBindError,各自变红", () => {
    expect(checkMcpExtensionWired(SESSION_SRC.replace(".bindExtensions(", ".nope(")).bindsExtensions).toBe(false);
    expect(checkMcpExtensionWired(SESSION_SRC.replace(/mcpBindError/g, "x")).reportsBindError).toBe(false);
  });
});

describe("mcp-wiring · 坑 3:allowlist 里 `mcp__` 条目的出现由**授权**决定", () => {
  const deps = (patterns: readonly string[]): RuntimeDeps => ({
    db: openPlatformMemoryDb(),
    now: () => 1,
    newId: (p: string) => p,
  });
  const agent: Agent = { id: "a", role: "project_manager", displayName: "PM" };
  const project: Project = { id: "p", name: "P", status: "active", assignments: [{ agentId: "a" }] };

  it("**有授权** ⇒ `mcp__<server>__*` 进统一 allowlist(这同时是 pi 的过滤器开关)", () => {
    const split = classifyToolset(["read", "mcp_list"], [mcpPattern("docs")]);
    expect(split.mcpPatterns).toEqual(["mcp__docs__*"]);
    expect(split.unifiedAllowlist).toContain("mcp__docs__*");
    expect(split.unplaceable).toEqual([]);
  });

  it("**零授权** ⇒ allowlist 里一个 `mcp__` 条目都没有(不写空串骗自己)", () => {
    const split = classifyToolset(["read", "mcp_list"], []);
    expect(split.mcpPatterns).toEqual([]);
    expect(split.unifiedAllowlist.filter((t) => t.startsWith("mcp__"))).toEqual([]);
  });

  it("MCP 模式**不进 `unplaceable`**(它不是「交不出去」,是交给 pi 的扩展去交)", () => {
    // ⚠️ 旧行为:`mcp__docs__search` 会进 unplaceable ⇒ 整个建会话硬失败
    const split = classifyToolset(["read"], [mcpPattern("docs")]);
    expect(split.unplaceable).toEqual([]);
  });

  it("⚠️ 变异自检:把 `classifyToolset` 的 mcpPatterns 参数丢掉,检查器必须变红", () => {
    const mutated = SDK_ADAPTER_SRC.replace(/\.\.\.mcpPatterns,/, "");
    // 断言用的判据就是「源码里那行展开还在不在」
    expect(/\.\.\.mcpPatterns,/.test(stripComments(mutated))).toBe(false);
    expect(/\.\.\.mcpPatterns,/.test(stripComments(SDK_ADAPTER_SRC))).toBe(true);
    // ⚠️ 行为侧的对照必须用**同一个真函数** + 一个忽略参数的等价物,
    // 否则就是在测一个另写的假货(第一次写这组自检时踩过:调的还是同一个真函数,
    // 恒过/恒红都没意义)。这里显式写出「忽略 mcpPatterns」的那条路径。
    const asIfPatternsIgnored: string[] = [...classifyToolset(["read"]).unifiedAllowlist];
    expect(asIfPatternsIgnored.filter((t) => t.startsWith("mcp__"))).toEqual([]);
    // 而真函数带着 patterns 时它**在** allowlist 里
    expect([...classifyToolset(["read"], [mcpPattern("docs")]).unifiedAllowlist]).toContain("mcp__docs__*");
  });

  it("求解器:授权 ⇒ patterns;零授权 ⇒ 空(不塞空串、不塞 `mcp__*` 通配)", () => {
    const d = deps([]);
    expect(solveMcpFor(d, agent, project).patterns).toEqual([]);
  });
});

describe("mcp-wiring · 坑 4:未授权的 server 必须**显式**交给 pi", () => {
  const shape = checkPiConfigShape(PI_CONFIG_SRC);

  it("pi 配置恒为 autoEnableCodemode:false,且**不给** projectConfig", () => {
    expect(shape.autoEnableCodemodeFalse, "codemode 的调用绕过 allowlist,必须关掉").toBe(true);
    expect(shape.noProjectConfig, "给了 projectConfig ⇒ pi 会去读 <cwd>/.pi/mcp.json(那是项目仓里的文件)").toBe(true);
  });

  it("每个 server 都被写成 enabled + exposure(direct / hidden)", () => {
    expect(shape.enabledFlag, "enabled 必须由授权决定").toBe(true);
    expect(shape.exposureDirect).toBe(true);
    expect(shape.exposureHidden, "未授权的必须 hidden(资源工具只看 enabled + 非 hidden)").toBe(true);
  });

  it("⚠️ 变异自检:去掉 `enabled` / 去掉 `hidden` / 去掉 autoEnableCodemode / 加 projectConfig,各自变红", () => {
    expect(checkPiConfigShape(PI_CONFIG_SRC.replace("enabled: entry.granted", "enabled: true")).enabledFlag).toBe(false);
    // ⚠️ 同样必须 replaceAll:这些串在文件头的注释里也出现过,
    // 只替换第一次会改到注释上,而检查器是**剥注释**之后才扫的 ⇒ 恒真的自检。
    expect(checkPiConfigShape(PI_CONFIG_SRC.replaceAll(/"hidden"/g, '"direct"')).exposureHidden).toBe(false);
    expect(checkPiConfigShape(PI_CONFIG_SRC.replaceAll("autoEnableCodemode: false", "autoEnableCodemode: true"))
      .autoEnableCodemodeFalse).toBe(false);
    expect(checkPiConfigShape(PI_CONFIG_SRC.replace("errors: [],", "errors: [], projectConfig: cwd,"))
      .noProjectConfig).toBe(false);
  });
});

describe("mcp-wiring · 「声称有、实际没有」的三条自查", () => {
  it("① 平台**从不**读 pi 自己的 `mcp.json`(那是 `<cwd>` 里的文件,会进 git)", () => {
    const own = readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js", "utf8");
    // 上游确实会读 `<agentDir>/mcp.json` 与 `<cwd>/.pi/mcp.json` —— 这就是必须接管的理由
    expect(own).toContain('join(options.agentDir, "mcp.json")');
    expect(own).toContain("projectTrusted");
    // 而平台侧:配置源**由平台提供**(`loadConfig:`),一次都不让 pi 自己读
    expect(SESSION_CODE).toContain("loadConfig:");
    expect(SESSION_CODE).not.toContain("loadMcpConfig({");
    expect(SESSION_CODE).not.toMatch(/loadConfig\s*:\s*loadMcpConfig\s*\(\s*\)/);
  });

  it("② 没有「连接状态」端点 / 字段 —— 平台读不到,宁可没有也不伪造", () => {
    const httpSrc = readFileSync("src/platform/transport/http.ts", "utf8");
    const mcpRoutes = httpSrc.split("/api/mcp/").length - 1;
    expect(mcpRoutes).toBeGreaterThan(0);
    for (const forbidden of ["mcp/status", "mcp/connections", "mcp/health"]) {
      expect(httpSrc).not.toContain(`/api/${forbidden}`);
    }
    // 连接状态字段恒为 unavailable,且它只出现在 wiring / 视图里,不作为一个可读的状态
    expect(readFileSync("src/platform/mcp/piConfig.ts", "utf8")).toContain('"unavailable"');
  });

  it("③ 授权**只影响新建会话**,所以不在门铃清单里(叫醒没有用)", () => {
    const src = readFileSync("src/platform/runtime/dispatcher.ts", "utf8");
    const block = src.slice(src.indexOf("NUDGE_CAPABILITIES"), src.indexOf("NUDGE_CAPABILITIES") + 900);
    expect(block).not.toContain("mcp.");
    // 反面:改动授权**必须**在工具返回文本里说出来
    expect(readFileSync("src/platform/tools/mcp.ts", "utf8")).toContain("只对新建的会话生效");
  });
});
