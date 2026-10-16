/**
 * Sansheng 平台 · MCP · **求解**:角色 + 项目 → 这一条会话能连哪些 MCP server
 *
 * ── 它是 MCP 版的「solveToolset」,但多了一个维度 ───────────────
 *
 *   solveToolset  agent × project × 集合文件 → 一个工具名集合
 *   solveMcpFor   agent × project × 授权文件 → 一份 pi 配置
 *
 * 差别在于产物形态:平台的工具名是**闭合集**里的名字,而 MCP 的工具名
 * (`mcp__<server>__<tool>`)由**外部 server 在运行时才决定** ——
 * 平台在求解期**根本不知道**它们有哪些、叫什么。所以产物只能是:
 *
 *   - 一份交给 pi 的配置(哪些 server 连、怎么连);
 *   - 一组 allowlist **模式**(`mcp__<server>__*`)。
 *
 * ⚠️ 这就是为什么 `wiring` 里那几行必须一起看:有 server 连接上、但 allowlist
 * 里没有对应的 `mcp__` 模式 ⇒ pi 会把它的工具**全部注册且激活**(坑 3 的
 * fail-open),而没有 server 连接、但 allowlist 里有模式 ⇒ 一个空承诺。
 *
 * ── 收口项目 ⇒ 零 server ────────────────────────────────────────
 *
 * 与 scope 门(`authorize.ts` 的 `PROJECT_SCOPED_PREFIXES` 里新增 `"mcp."`)
 * **同一条判据的两个落点**:工具面在求解期被挡,配置在这里也解成零 ——
 * 因为授权文件是**按角色**存的(不按项目),它自己分不清「这个角色在收口项目里」。
 * 两者缺一个就会漏:只挡工具面,pi 那边照样把 server 连上(连上就要 spawn 进程 /
 * 出网,那比多给一个工具贵得多)。
 */
import type { RuntimeDeps } from "../runtime/assembly.js";
import type { Agent, Project } from "../harness/authorize.js";
import { isTerminalProjectStatus } from "../storage/repo/projects.js";
import { resolveMcpCatalog, isValidServerName, type McpServerDef } from "./config.js";
import { readGrantFile, type McpGrantFile } from "./grants.js";

/** 一条交给 pi 的 server(定义 + 平台强制的两个字段)。 */
export interface SolvedMcpServer {
  readonly name: string;
  /** `true` = 授权命中;`false` = 目录里有但没授权(仍**必须**列给 pi,见下) */
  readonly granted: boolean;
  readonly def: McpServerDef;
}

/** 一次求解的完整结果。**没有任何字段是「猜」的**:要么有据,要么如实报出。 */
export interface McpSolution {
  readonly role: string;
  /** `active` = 该连的;`closed_project` / `intake` = 一条都不连(附原因) */
  readonly state: "ok" | "closed_project" | "intake" | "no_grants";
  /** **目录里全部** server,分 `granted` 两档。⚠️ 未授权的也必须列出(坑 4)。 */
  readonly servers: readonly SolvedMcpServer[];
  readonly patterns: readonly string[];
  /** 授权文件里写了、目录里没有的名字 —— **不静默生效** */
  readonly unknownServers: readonly string[];
  /** 授权文件坏掉的原因(`state==="ok"` 时也可能非空:坏文件 ⇒ 零授权) */
  readonly problem: string | undefined;
  /** 目录文件坏掉的原因 */
  readonly catalogProblem: string | undefined;
}

/**
 * pi 侧的 server 名模式。
 *
 * ⚠️ 名字里的 `-` 必须换成 `_` —— pi 的 `mcpNamespace()` 也这么干
 * (`mcp__<server>` with `-` replaced by `_`)。用原名去 allowlist 里找会**永远不命中**,
 * 而那种形态是「配置说有、工具没给」:最难查的一类。
 */
export function mcpPattern(serverName: string): string {
  return `mcp__${serverName.replace(/-/g, "_")}__*`;
}

/**
 * 求解一次。
 *
 * `deps.mcpFor(role)` 是授权的**唯一**来源(懒读,每次现读盘);没接线时
 * (`undefined`)按零授权处理 —— 与「授权文件不存在」同一种结果,但**不算故障**
 * (只挂 HTTP 的装配、单元测试都走这条路)。
 */
export function solveMcpFor(deps: RuntimeDeps, agent: Agent, project: Project | null): McpSolution {
  const dataDir = deps.dataDir;
  const role = agent.role;

  const catalog = dataDir === undefined
    ? { servers: [] as McpServerDef[], state: "absent" as const, path: "", problem: undefined }
    : resolveMcpCatalog(dataDir);
  const catalogProblem = catalog.problem;

  // ── 1. 作用域:接待模式 / 收口项目 ⇒ 零 server ──
  // 接待模式(`project === null`):MCP 是「拿着别人的资料干活」,接待阶段
  // 连外部系统没有任何合理场景,而它是最容易被诱导的那一步(甲方原话直连外部)。
  if (project === null) {
    return emptySolution(role, "intake", catalogProblem);
  }
  if (isTerminalProjectStatus(project.status)) {
    return emptySolution(role, "closed_project", catalogProblem);
  }

  // ── 2. 授权文件 ──
  const grant: McpGrantFile | undefined = deps.mcpFor?.(role);
  const grantResolution = dataDir === undefined
    ? { problem: undefined as string | undefined }
    : readGrantFile(dataDir, role);
  const problem = grantResolution.problem;

  const allow = new Set<string>(grant?.allow ?? []);
  const deny = new Set<string>(grant?.deny ?? []);
  const grantedNames = [...allow].filter((n) => !deny.has(n));

  // ── 3. 求交:目录 ∩ 授权 ──
  const servers: SolvedMcpServer[] = [];
  for (const def of catalog.servers) {
    servers.push({ name: def.name, granted: grantedNames.includes(def.name), def });
  }

  // 授权里有、目录里没有的名字 —— 如实报出,**不静默生效**
  const unknownServers = grantedNames.filter(
    (n) => !catalog.servers.some((s) => s.name === n) || !isValidServerName(n),
  );

  const active = servers.filter((s) => s.granted);
  if (active.length === 0) {
    return {
      ...emptySolution(role, "no_grants", catalogProblem),
      servers, // 仍然列全 —— pi 那边要靠它们写成 enabled:false(坑 4)
      unknownServers,
      problem,
    };
  }

  return {
    role,
    state: "ok",
    servers,
    patterns: active.map((s) => mcpPattern(s.name)),
    unknownServers,
    problem,
    catalogProblem,
  };
}

function emptySolution(
  role: string,
  state: McpSolution["state"],
  catalogProblem: string | undefined,
): McpSolution {
  return {
    role,
    state,
    servers: [],
    patterns: [],
    unknownServers: [],
    problem: undefined,
    catalogProblem,
  };
}

/**
 * 这个角色**一条授权都没有**吗。
 *
 * 读面 / 启动日志用它决定「要不要专门说一声『无授权』」——
 * 与 `platform smoke` 的要求同款:零授权角色也要打印一行,
 * 否则「没配」和「配错了」在日志里长得一模一样。
 */
export function isNoGrantState(s: McpSolution): boolean {
  return s.state !== "ok";
}
