/**
 * Sansheng 平台 · MCP · 求解结果 → pi 的 `LoadedMcpConfig`
 *
 * ── 这是整层唯一碰 pi 类型的地方 ─────────────────────────────────
 *
 * 其余模块(`solve.ts` / `grants.ts` / `config.ts`)都只认平台自己的类型,
 * 所以它们可以被纯函数测试完整覆盖,不需要起 SDK。
 *
 * ── 四个坑在这里落地(每一个都写进了源码与回归)────────────────────
 *
 * **坑 1 — SDK 会话不加载内置扩展。**
 * `DefaultResourceLoader` 不传 `extensionFactories` 时 MCP 扩展根本不存在
 * ⇒ 一个 server 定义写得再对也是死的。接线在 `runtime/session.ts`。
 *
 * **坑 2 — `bindExtensions` 不被 `createAgentSession` 自动调用**
 * (`dist/core/agent-session.js` 里 `sdk.js` 零调用)。不绑定 ⇒ 扩展收不到
 * `session_start` ⇒ 不去连 server。同样在 `runtime/session.ts`。
 *
 * **坑 3 — allowlist 在 `mcp__` 一个条目都没有时是 fail-open 的。**
 * `agent-session.js`: `_allowlistFiltersMcp` 只在「allowlist 为空」或「某个
 * 条目以 `mcp__` 开头」时为 true;而 `_isAllowedTool` 在它为 false 时
 * **保留全部 MCP 工具注册**。
 * ⇒ 本文件的做法:**永远把 MCP 扩展装上,但授权为零时一条 server 都不启用**
 *   —— 没有 server 连接 ⇒ 没有任何 MCP 工具可注册 ⇒ 那个 fail-open 的分支
 *   **碰不到任何东西**。
 *   为什么选这一条而不是「零授权时不装扩展」:不装扩展会让 `wiring` 看起来
 *   像「这一条会话根本没考虑 MCP」,而实际上「零授权」是一个**有效状态**,
 *   它必须在 `wiring` 里留一行(`mcpServers: []`)。装上 + 零启用两种做法都
 *   fail-closed,后者让「没授权」这件事可见。
 *
 * **坑 4 — pi 的资源工具会越界。**
 * `list_mcp_resources` / `read_mcp_resource` / `list_mcp_resource_templates`
 * 到达的是「**每一个** enabled 且非 hidden 的 server」
 * (`extensions/mcp/index.js`: `servers.filter((s) => s.connection?.hasResources
 * && isEnabled(s) && exposureOf(s.entry) !== "hidden")`)。
 * ⇒ 未授权的 server **必须显式**写成 `{ enabled: false, exposure: "hidden" }`,
 *   **不能只是不列**。不列 ⇒ pi 读它自己的 `mcp.json` 时可能仍然连上,
 *   而「不列」这件事在代码里看不出与「忘了写」的区别。
 *
 * 另外两条硬要求:
 *   · `autoEnableCodemode: false` + 每条 server `exposure: "direct"`。
 *     codemode 的调用「do not depend on the active tool set」(pi 自己的
 *     `docs/mcp.md`)—— 也就是说**平台的 allowlist 拦不住它**。所以 Wave 1
 *     关掉 codemode,只留 `direct`:工具逐个进 allowlist,边界逐条可见。
 *   · **完全接管 `loadConfig`**,不设 `projectConfig`。pi 的默认实现
 *     (`extensions/mcp/config.js`)会读 `<agentDir>/mcp.json` **和**
 *     `<cwd>/.pi/mcp.json`(trusted project);而本平台的 `cwd` 就是**项目仓根**
 *     ⇒ 那份文件会进 git、整仓对甲方可见(设计 `docs/DESIGN-PLATFORM.md`
 *     的透明交付裁决)。所以平台**必须自己提供配置源**,一条都不许它自己读。
 */
import type { LoadedMcpConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { McpSolution, SolvedMcpServer } from "./solve.js";
import { withResolvedSecrets, type SecretStore } from "./secrets.js";

/** `servers.json` 的路径在 `wiring` / 日志里要报出来,而 pi 只吃 `{ source }`。 */
export const MCP_CONFIG_SOURCE = "sansheng:harness/mcp/servers.json";

/**
 * 一条 server 的 pi 侧配置。
 *
 * `exposure` 固定 `direct`(`ok`)或 `hidden`(`not granted`)—— `codemode` 与
 * `deferred` 都不给,理由见文件头。
 */
function toPiConfig(
  entry: SolvedMcpServer,
  resolved: { env: Readonly<Record<string, string>>; headers: Readonly<Record<string, string>> },
): McpServerConfig {
  const base = {
    exposure: (entry.granted ? "direct" : "hidden") as "direct" | "hidden",
    enabled: entry.granted,
  };
  if (entry.def.transport === "http") {
    return {
      type: "http",
      url: entry.def.url as string,
      ...base,
      ...(Object.keys(resolved.headers).length > 0 ? { headers: { ...resolved.headers } } : {}),
      ...(entry.def.timeout !== undefined ? { timeout: entry.def.timeout } : {}),
      ...(entry.def.description !== undefined ? { description: entry.def.description } : {}),
    };
  }
  return {
    type: "stdio",
    command: entry.def.command as string,
    ...base,
    ...(entry.def.args !== undefined ? { args: [...entry.def.args] } : {}),
    ...(Object.keys(resolved.env).length > 0 ? { env: { ...resolved.env } } : {}),
    ...(entry.def.timeout !== undefined ? { timeout: entry.def.timeout } : {}),
    ...(entry.def.description !== undefined ? { description: entry.def.description } : {}),
  };
}

/** 一次转换的结果:pi 要的那份,加上「有哪些 secret 解不开」这个必须可见的事实。 */
export interface PiConfigResult {
  readonly config: LoadedMcpConfig;
  /** 解不开的 secret(缺 `enc:` / keyring 不是同一个)。**键名**,不含值。 */
  readonly unresolved: readonly string[];
  /** ⚠️ Wave 1 **读不到**:pi 把连接状态写进 `<agentDir>/mcp.log`,平台读不着。
   *  与 `ProjectLiveView.runtime = "unavailable"` 同一条纪律:宁可没有这个字段,
   *  也不伪造一个「已连接」。 */
  readonly connectionState: "unavailable";
}

/**
 * 求解结果 → pi 配置。
 *
 * ⚠️ `store` 可以是 `undefined`(没有装配 secret 层):那时**不解密**,
 * `servers.json` 里写的 `${VAR}` 引用原样交给 pi(它自己会从进程环境解析)。
 * 这不是「静默降级成没有凭据」——`${VAR}` 本来就是不需要平台的引用形式。
 */
export function toLoadedMcpConfig(
  solution: McpSolution,
  dataDir: string | undefined,
  store: SecretStore | undefined,
): PiConfigResult {
  const unresolved: string[] = [];
  const servers: McpServerEntry[] = [];

  for (const entry of solution.servers) {
    const resolved =
      dataDir !== undefined && store !== undefined
        ? withResolvedSecrets(dataDir, entry.def, store)
        : { env: entry.def.env ?? {}, headers: entry.def.headers ?? {}, unresolved: [] as string[] };
    for (const u of resolved.unresolved) unresolved.push(`${entry.name}:${u}`);
    servers.push({
      name: entry.name,
      config: toPiConfig(entry, resolved),
      source: MCP_CONFIG_SOURCE,
    });
  }

  return {
    config: {
      servers,
      // ⚠️ 恒为 false。见文件头:codemode 的调用不经过 active tool set。
      autoEnableCodemode: false,
      // 刻意**不给** `projectConfig` —— 见文件头(会读到 `<cwd>/.pi/mcp.json`)。
      errors: [],
    },
    unresolved,
    connectionState: "unavailable",
  };
}

/**
 * 一条可执行的「配置坏在哪」说明 —— 启动日志与 `platform smoke` 用它。
 *
 * ⚠️ 它**不猜连接状态**:Wave 1 平台读不到每个会话的 MCP 连接状态
 * (pi 把它写进 `<agentDir>/mcp.log`),所以这里只报「我们算出了什么」。
 */
export function describeMcpSolution(solution: McpSolution): string {
  const lines: string[] = [];
  lines.push(`MCP(${solution.role}):状态=${solution.state}`);
  if (solution.servers.length === 0) {
    lines.push("  server:无");
  } else {
    for (const s of solution.servers) {
      lines.push(`  server:${s.name} · ${s.granted ? "已授权(enabled/direct)" : "未授权(enabled:false/hidden)"}`);
    }
  }
  if (solution.patterns.length > 0) lines.push(`  allowlist 模式:${solution.patterns.join(", ")}`);
  if (solution.unknownServers.length > 0) {
    lines.push(`  ⚠️ 授权里有、目录里没有:${solution.unknownServers.join(", ")}(不静默生效)`);
  }
  if (solution.catalogProblem !== undefined) lines.push(`  ⚠️ 目录文件:${solution.catalogProblem}`);
  if (solution.problem !== undefined) lines.push(`  ⚠️ 授权文件:${solution.problem}`);
  lines.push("  连接状态:读不到(平台不解析 pi 的 mcp.log —— 宁可没有,也不伪造)");
  return lines.join("\n");
}
